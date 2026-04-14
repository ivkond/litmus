import { db } from '@/db';
import { judgeProviders, judgeVerdicts, runResults, compressionLogs, settings } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { getPublisher } from '@/lib/events/redis-client';
import { publishEvent } from '@/lib/events/redis-bus';
import { assembleContext } from './context';
import { createCompressor } from '@/lib/compression/factory';
import { buildUserPrompt, buildSystemPrompt } from './prompt';
import { settingsDefaults } from './types';
import type { JudgeMeta, JudgeTaskPayload } from './types';

const STREAM_KEY = 'litmus:judge:tasks';
const COMPRESSED_KEY_PREFIX = 'litmus:compressed';
const COMPRESSED_TTL = 7200; // 2 hours

async function getSetting<T>(key: string): Promise<T> {
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

/**
 * Enqueue judge evaluation tasks for a run result.
 * Called after reconciler.finalize() writes the result to DB.
 */
export async function enqueueJudgeTasks(runResultId: string): Promise<void> {
  // 1. Load enabled providers
  const providers = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.enabled, true))
    .orderBy(judgeProviders.priority);

  if (providers.length === 0) {
    await db
      .update(runResults)
      .set({ judgeStatus: 'skipped' })
      .where(eq(runResults.id, runResultId));
    return;
  }

  // 2. Get current evaluation version
  const [result] = await db
    .select({ evaluationVersion: runResults.evaluationVersion })
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result) return;
  const version = result.evaluationVersion;

  // 3. Snapshot provider IDs into judgeMeta
  const targetProviderIds = providers.map((p) => p.id);
  const judgeMeta: JudgeMeta = { targetProviderIds };

  await db
    .update(runResults)
    .set({
      judgeStatus: 'pending',
      judgeMeta: judgeMeta as unknown as Record<string, unknown>,
    })
    .where(eq(runResults.id, runResultId));

  // 4. Assemble and compress context
  const context = await assembleContext(runResultId);
  const compressionType = await getSetting<string>('log_compression');
  const maxCompressedChars = await getSetting<number>('max_compressed_chars');

  const compressor = createCompressor(compressionType);
  const startMs = Date.now();
  const compressed = compressor.compress(context.execution.agentLog, {
    maxChars: maxCompressedChars,
  });
  const durationMs = Date.now() - startMs;

  // Record compression (idempotent — may be called again for pending re-enqueue)
  await db.insert(compressionLogs).values({
    runResultId,
    inputChars: compressed.inputChars,
    outputChars: compressed.outputChars,
    ratio: compressed.inputChars > 0 ? compressed.outputChars / compressed.inputChars : 0,
    compressorType: compressor.type,
    durationMs,
    evaluationVersion: version,
  }).onConflictDoNothing();

  // 5. Cache compressed context in Redis
  const redis = getPublisher();
  const cacheKey = `${COMPRESSED_KEY_PREFIX}:${runResultId}:${version}`;

  const maxPromptChars = await getSetting<number>('max_judge_prompt_chars');
  const userPrompt = buildUserPrompt(
    { ...context, execution: { ...context.execution, agentLog: compressed.content } },
    maxPromptChars
  );

  await redis.set(cacheKey, JSON.stringify({
    systemPrompt: buildSystemPrompt(),
    userPrompt,
  }), 'EX', COMPRESSED_TTL);

  // 6. Enqueue one task per provider to Redis Stream
  for (const provider of providers) {
    const payload: JudgeTaskPayload = {
      runResultId,
      providerId: provider.id,
      evaluationVersion: version,
    };
    await redis.xadd(STREAM_KEY, '*', 'payload', JSON.stringify(payload));
  }

  // 7. Publish notification
  await publishEvent({
    type: 'judge:started',
    runResultId,
  });
}

/**
 * Startup recovery: re-enqueue tasks for incomplete evaluations.
 */
export async function recoverPendingEvaluations(): Promise<void> {
  const pendingResults = await db
    .select()
    .from(runResults)
    .where(inArray(runResults.judgeStatus, ['pending', 'partial']));

  for (const result of pendingResults) {
    const meta = result.judgeMeta as unknown as JudgeMeta;
    if (!meta?.targetProviderIds) continue;

    const version = result.evaluationVersion;

    const existingVerdicts = await db
      .select({ judgeProviderId: judgeVerdicts.judgeProviderId })
      .from(judgeVerdicts)
      .where(
        and(
          eq(judgeVerdicts.runResultId, result.id),
          eq(judgeVerdicts.evaluationVersion, version)
        )
      );

    const completedProviders = new Set(existingVerdicts.map((v) => v.judgeProviderId));
    const missingProviders = meta.targetProviderIds.filter((id) => !completedProviders.has(id));

    if (missingProviders.length === 0) {
      const { runAggregation } = await import('./aggregation-runner');
      await runAggregation(result.id, version);
      continue;
    }

    const redis = getPublisher();
    for (const providerId of missingProviders) {
      const payload: JudgeTaskPayload = {
        runResultId: result.id,
        providerId,
        evaluationVersion: version,
      };
      await redis.xadd(STREAM_KEY, '*', 'payload', JSON.stringify(payload));
    }
  }
}

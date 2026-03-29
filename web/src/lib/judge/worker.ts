import { db } from '@/db';
import { runResults, judgeVerdicts, judgeProviders } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getPublisher, getConsumer } from '@/lib/events/redis-client';
import { settingsDefaults, judgeResponseSchema } from './types';
import type { JudgeTaskPayload } from './types';
import { decrypt } from './encryption';
import { assembleContext } from './context';
import { createCompressor } from '@/lib/compression/factory';
import { buildSystemPrompt, buildUserPrompt } from './prompt';

const STREAM_KEY = 'litmus:judge:tasks';
const GROUP_NAME = 'judge-workers';
const COMPRESSED_KEY_PREFIX = 'litmus:compressed';
const COMPRESSED_TTL = 7200;

async function getSetting<T>(key: string): Promise<T> {
  const { settings } = await import('@/db/schema');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

async function ensureConsumerGroup(): Promise<void> {
  const redis = getPublisher();
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message?.includes('BUSYGROUP')) throw err;
  }
}

async function callJudgeAPI(
  provider: { baseUrl: string; apiKey: string; model: string },
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<{ response: string; durationMs: number }> {
  const start = Date.now();
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${decrypt(provider.apiKey)}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
    throw Object.assign(new Error('Rate limited'), { retryAfter });
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  return { response: content, durationMs: Date.now() - start };
}

async function processTask(payload: JudgeTaskPayload): Promise<void> {
  const { runResultId, providerId, evaluationVersion } = payload;

  // Version guard
  const [result] = await db
    .select({ evaluationVersion: runResults.evaluationVersion })
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result || result.evaluationVersion !== evaluationVersion) {
    return; // Stale task — discard
  }

  // Load provider
  const [provider] = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.id, providerId));

  if (!provider) {
    await writeErrorVerdict(runResultId, providerId, evaluationVersion, 'Provider not found');
    return;
  }

  // Load cached prompt from Redis, or rebuild
  const redis = getPublisher();
  const cacheKey = `${COMPRESSED_KEY_PREFIX}:${runResultId}:${evaluationVersion}`;
  const cached = await redis.get(cacheKey);

  let systemPrompt: string;
  let userPrompt: string;

  if (cached) {
    const parsed = JSON.parse(cached);
    systemPrompt = parsed.systemPrompt;
    userPrompt = parsed.userPrompt;
  } else {
    // Cache miss — re-assemble
    const context = await assembleContext(runResultId);
    const compressionType = await getSetting<string>('log_compression');
    const maxCompressedChars = await getSetting<number>('max_compressed_chars');
    const compressor = createCompressor(compressionType);
    const compressed = compressor.compress(context.execution.agentLog, { maxChars: maxCompressedChars });
    const maxPromptChars = await getSetting<number>('max_judge_prompt_chars');
    systemPrompt = buildSystemPrompt();
    userPrompt = buildUserPrompt(
      { ...context, execution: { ...context.execution, agentLog: compressed.content } },
      maxPromptChars
    );
    await redis.set(cacheKey, JSON.stringify({ systemPrompt, userPrompt }), 'EX', COMPRESSED_TTL);
  }

  // Call judge API with retries
  const maxRetries = await getSetting<number>('judge_max_retries');
  const temperature = await getSetting<number>('judge_temperature');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { response, durationMs } = await callJudgeAPI(
        provider,
        systemPrompt,
        userPrompt,
        temperature
      );

      const raw = JSON.parse(response);
      const validated = judgeResponseSchema.safeParse(raw);
      if (!validated.success) {
        throw new Error(
          `Invalid judge response: ${validated.error.issues.map((i) => i.message).join(', ')}`
        );
      }
      const parsed = validated.data;

      // Write verdict
      await db.insert(judgeVerdicts).values({
        runResultId,
        judgeProviderId: providerId,
        scores: parsed.scores,
        blockingFlags: parsed.blocking,
        rawResponse: response,
        durationMs,
        evaluationVersion,
      }).onConflictDoNothing();

      // Trigger aggregation check
      await checkAggregation(runResultId, evaluationVersion);
      return;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryAfter = (err as Record<string, unknown>).retryAfter;
      if (typeof retryAfter === 'number') {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
      } else if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }

  // All retries exhausted
  await writeErrorVerdict(
    runResultId,
    providerId,
    evaluationVersion,
    lastError?.message ?? 'Unknown error'
  );
  await checkAggregation(runResultId, evaluationVersion);
}

async function writeErrorVerdict(
  runResultId: string,
  providerId: string,
  evaluationVersion: number,
  error: string
): Promise<void> {
  await db.insert(judgeVerdicts).values({
    runResultId,
    judgeProviderId: providerId,
    scores: {},
    blockingFlags: {},
    error,
    evaluationVersion,
  }).onConflictDoNothing();
}

async function checkAggregation(
  runResultId: string,
  evaluationVersion: number
): Promise<void> {
  const { runAggregation } = await import('./aggregation-runner');
  await runAggregation(runResultId, evaluationVersion);
}

// --- Concurrency limiter via Redis INCR/DECR ---

const CONCURRENCY_GLOBAL_KEY = 'litmus:judge:concurrent:global';
const CONCURRENCY_PROVIDER_PREFIX = 'litmus:judge:concurrent:provider:';
const CONCURRENCY_TTL = 600; // auto-expire after 10min (safety net)

async function acquireConcurrencySlot(providerId: string): Promise<boolean> {
  const redis = getPublisher();
  const maxGlobal = await getSetting<number>('judge_max_concurrent_global');
  const maxPerProvider = await getSetting<number>('judge_max_concurrent_per_provider');

  const providerKey = `${CONCURRENCY_PROVIDER_PREFIX}${providerId}`;

  // Check global limit
  const globalCount = await redis.incr(CONCURRENCY_GLOBAL_KEY);
  await redis.expire(CONCURRENCY_GLOBAL_KEY, CONCURRENCY_TTL);
  if (globalCount > maxGlobal) {
    await redis.decr(CONCURRENCY_GLOBAL_KEY);
    return false;
  }

  // Check per-provider limit
  const providerCount = await redis.incr(providerKey);
  await redis.expire(providerKey, CONCURRENCY_TTL);
  if (providerCount > maxPerProvider) {
    await redis.decr(providerKey);
    await redis.decr(CONCURRENCY_GLOBAL_KEY);
    return false;
  }

  return true;
}

async function releaseConcurrencySlot(providerId: string): Promise<void> {
  const redis = getPublisher();
  const providerKey = `${CONCURRENCY_PROVIDER_PREFIX}${providerId}`;
  await redis.decr(CONCURRENCY_GLOBAL_KEY);
  await redis.decr(providerKey);
}

/**
 * Start the JudgeWorker loop — blocking read from Redis Stream.
 * Call once on application startup.
 */
export async function startWorker(consumerId: string): Promise<void> {
  await ensureConsumerGroup();
  const consumer = getConsumer();

  while (true) {
    try {
      const results = await consumer.xreadgroup(
        'GROUP', GROUP_NAME, consumerId,
        'COUNT', 1,
        'BLOCK', 5000,
        'STREAMS', STREAM_KEY, '>'
      );

      if (!results || results.length === 0) continue;

      for (const [, messages] of results as [string, [string, string[]][]][]) {
        for (const [messageId, fields] of messages) {
          try {
            const payloadStr = fields[fields.indexOf('payload') + 1];
            const payload: JudgeTaskPayload = JSON.parse(payloadStr);

            // Concurrency throttle — wait if limits are hit
            let acquired = false;
            for (let wait = 0; wait < 30; wait++) {
              acquired = await acquireConcurrencySlot(payload.providerId);
              if (acquired) break;
              await new Promise((r) => setTimeout(r, 1000));
            }

            if (!acquired) {
              // Could not acquire slot after 30s — nack by not acking, will be reclaimed
              console.warn('[JudgeWorker] Concurrency limit hit for', payload.providerId);
              continue;
            }

            try {
              await processTask(payload);
            } finally {
              await releaseConcurrencySlot(payload.providerId);
            }
            await consumer.xack(STREAM_KEY, GROUP_NAME, messageId);
          } catch (err) {
            console.error('[JudgeWorker] Error processing task (will be reclaimed):', err);
          }
        }
      }
    } catch (err) {
      console.error('[JudgeWorker] Stream read error:', err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

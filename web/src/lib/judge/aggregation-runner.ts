import { db } from '@/db';
import { runResults, judgeVerdicts, judgeProviders, settings } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getPublisher } from '@/lib/events/redis-client';
import { publishEvent } from '@/lib/events/redis-bus';
import { aggregateVerdicts, computeCompositeScore } from './aggregator';
import { computeWeights, CRITERIA_KEYS, BLOCKING_KEYS } from './criteria';
import { settingsDefaults } from './types';
import type { JudgeMeta } from './types';

async function getSetting<T>(key: string): Promise<T> {
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

export async function runAggregation(
  runResultId: string,
  evaluationVersion: number
): Promise<void> {
  const [result] = await db
    .select()
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result || result.evaluationVersion !== evaluationVersion) return;

  const meta = result.judgeMeta as unknown as JudgeMeta;
  if (!meta?.targetProviderIds) return;

  const N = meta.targetProviderIds.length;

  const verdicts = await db
    .select()
    .from(judgeVerdicts)
    .where(
      and(
        eq(judgeVerdicts.runResultId, runResultId),
        eq(judgeVerdicts.evaluationVersion, evaluationVersion)
      )
    );

  if (verdicts.length < N) {
    // Publish per-verdict progress with provider name
    const latestVerdict = verdicts[verdicts.length - 1];
    const [provider] = latestVerdict
      ? await db.select({ name: judgeProviders.name })
          .from(judgeProviders)
          .where(eq(judgeProviders.id, latestVerdict.judgeProviderId))
      : [null];

    if (verdicts.length > 0) {
      if (result.judgeStatus !== 'partial') {
        await db
          .update(runResults)
          .set({ judgeStatus: 'partial' })
          .where(eq(runResults.id, runResultId));
      }

      await publishEvent({
        type: 'judge:verdict',
        runResultId,
        providerName: provider?.name ?? 'unknown',
        progress: `${verdicts.length}/${N}`,
      });
    }
    return;
  }

  // All N verdicts received — aggregate
  const verdictInputs = verdicts.map((v) => ({
    scores: v.scores as Record<string, { score: number; rationale: string }>,
    blockingFlags: v.blockingFlags as Record<string, { triggered: boolean; rationale: string }>,
    error: v.error,
  }));

  const aggregated = aggregateVerdicts(verdictInputs, CRITERIA_KEYS, BLOCKING_KEYS);

  if (!aggregated) {
    await db
      .update(runResults)
      .set({
        judgeStatus: 'completed',
        compositeScore: result.totalScore,
        judgeMeta: { ...meta, allFailed: true } as unknown as Record<string, unknown>,
      })
      .where(eq(runResults.id, runResultId));

    await publishEvent({ type: 'judge:completed', runResultId, compositeScore: result.totalScore });
    await markMatviewRefreshNeeded();
    return;
  }

  const weightsConfig = await getSetting<{ test: number; judge: number }>('composite_weights');
  const priorityConfig = await getSetting<{ order: string[]; preset: string }>('criteria_priority');
  const blockingCaps = await getSetting<Record<string, number>>('blocking_caps');

  const criteriaWeights = computeWeights(
    priorityConfig.order,
    priorityConfig.preset as 'flat' | 'linear' | 'steep'
  );

  let judgeWeighted = 0;
  for (const key of CRITERIA_KEYS) {
    const weight = criteriaWeights[key] ?? 0;
    const score = aggregated.medianScores[key] ?? 0;
    judgeWeighted += weight * score;
  }

  const judgeNormalized = ((judgeWeighted - 1) / 4) * 100;

  const compositeScore = computeCompositeScore({
    testScore: result.totalScore ?? 0,
    judgeNormalized,
    weights: weightsConfig,
    blockingCount: aggregated.blockingCount,
    blockingCaps,
  });

  const updatedMeta: JudgeMeta = {
    ...meta,
    ...(aggregated.confidence === 'lowConfidence' ? { lowConfidence: true } : {}),
  };

  const successful = verdicts.filter((v) => !v.error);
  const failed = verdicts.filter((v) => v.error);
  if (failed.length > 0) {
    updatedMeta.partial = true;
    updatedMeta.succeeded = successful.length;
    updatedMeta.failed = failed.length;
  }

  await db
    .update(runResults)
    .set({
      judgeStatus: 'completed',
      judgeScores: aggregated.medianScores,
      blockingFlags: aggregated.blockingFlags,
      compositeScore,
      judgeMeta: updatedMeta as unknown as Record<string, unknown>,
    })
    .where(eq(runResults.id, runResultId));

  await publishEvent({
    type: 'judge:completed',
    runResultId,
    compositeScore,
  });

  await markMatviewRefreshNeeded();
}

async function markMatviewRefreshNeeded(): Promise<void> {
  const redis = getPublisher();
  await redis.set('litmus:matview-refresh-needed', '1');
}

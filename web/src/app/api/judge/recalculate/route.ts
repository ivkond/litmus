import { NextResponse } from 'next/server';
import { db } from '@/db';
import { runResults, judgeVerdicts, settings } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { aggregateVerdicts, computeCompositeScore } from '@/lib/judge/aggregator';
import { computeWeights, CRITERIA_KEYS, BLOCKING_KEYS } from '@/lib/judge/criteria';
import { settingsDefaults } from '@/lib/judge/types';

async function getSetting<T>(key: string): Promise<T> {
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

async function recalculateResult(resultId: string): Promise<void> {
  const [result] = await db
    .select()
    .from(runResults)
    .where(eq(runResults.id, resultId));

  if (!result || result.judgeStatus !== 'completed') return;

  const verdicts = await db
    .select()
    .from(judgeVerdicts)
    .where(
      and(
        eq(judgeVerdicts.runResultId, resultId),
        eq(judgeVerdicts.evaluationVersion, result.evaluationVersion)
      )
    );

  const verdictInputs = verdicts.map((v) => ({
    scores: v.scores as Record<string, { score: number; rationale: string }>,
    blockingFlags: v.blockingFlags as Record<string, { triggered: boolean; rationale: string }>,
    error: v.error,
  }));

  const aggregated = aggregateVerdicts(verdictInputs, CRITERIA_KEYS, BLOCKING_KEYS);
  if (!aggregated) return;

  const weightsConfig = await getSetting<{ test: number; judge: number }>('composite_weights');
  const priorityConfig = await getSetting<{ order: string[]; preset: string }>('criteria_priority');
  const blockingCaps = await getSetting<Record<string, number>>('blocking_caps');

  const criteriaWeights = computeWeights(
    priorityConfig.order,
    priorityConfig.preset as 'flat' | 'linear' | 'steep'
  );

  let judgeWeighted = 0;
  for (const key of CRITERIA_KEYS) {
    judgeWeighted += (criteriaWeights[key] ?? 0) * (aggregated.medianScores[key] ?? 0);
  }
  const judgeNormalized = ((judgeWeighted - 1) / 4) * 100;

  const compositeScore = computeCompositeScore({
    testScore: result.totalScore ?? 0,
    judgeNormalized,
    weights: weightsConfig,
    blockingCount: aggregated.blockingCount,
    blockingCaps,
  });

  await db
    .update(runResults)
    .set({ compositeScore })
    .where(eq(runResults.id, resultId));
}

export async function POST(request: Request) {
  const body = await request.json();
  const { runResultId } = body;

  if (runResultId) {
    await recalculateResult(runResultId);
    return NextResponse.json({ recalculated: 1 });
  }

  const results = await db
    .select({ id: runResults.id })
    .from(runResults)
    .where(eq(runResults.judgeStatus, 'completed'));

  for (const r of results) {
    await recalculateResult(r.id);
  }

  return NextResponse.json({ recalculated: results.length });
}

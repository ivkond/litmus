import { NextResponse } from 'next/server';
import { db } from '@/db';
import { runResults, judgeProviders, judgeVerdicts } from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { enqueueJudgeTasks } from '@/lib/judge/service';
import type { JudgeMeta, JudgeTaskPayload } from '@/lib/judge/types';

const STREAM_KEY = 'litmus:judge:tasks';

export async function POST(request: Request) {
  const body = await request.json();
  const { scenarioId, status = 'pending' } = body;

  if (status === 'pending') {
    // Resume incomplete evaluations — only enqueue MISSING provider tasks
    const conditions = [inArray(runResults.judgeStatus, ['pending', 'partial'])];
    if (scenarioId) conditions.push(eq(runResults.scenarioId, scenarioId));

    const results = await db
      .select({
        id: runResults.id,
        evaluationVersion: runResults.evaluationVersion,
        judgeMeta: runResults.judgeMeta,
      })
      .from(runResults)
      .where(and(...conditions));

    let enqueued = 0;
    // Lazy import to avoid pulling Redis/env at module parse time (breaks unit tests)
    const { getPublisher } = await import('@/lib/events/redis-client');
    const redis = getPublisher();

    for (const r of results) {
      const meta = r.judgeMeta as unknown as JudgeMeta | null;
      if (!meta?.targetProviderIds) continue;

      // Find which providers already have verdicts for this version
      const existingVerdicts = await db
        .select({ judgeProviderId: judgeVerdicts.judgeProviderId })
        .from(judgeVerdicts)
        .where(
          and(
            eq(judgeVerdicts.runResultId, r.id),
            eq(judgeVerdicts.evaluationVersion, r.evaluationVersion)
          )
        );

      const completedProviders = new Set(existingVerdicts.map((v) => v.judgeProviderId));
      const missingProviders = meta.targetProviderIds.filter((id) => !completedProviders.has(id));

      if (missingProviders.length === 0) {
        // All providers done — trigger aggregation
        const { runAggregation } = await import('@/lib/judge/aggregation-runner');
        await runAggregation(r.id, r.evaluationVersion);
        continue;
      }

      // Enqueue only missing providers
      for (const providerId of missingProviders) {
        const payload: JudgeTaskPayload = {
          runResultId: r.id,
          providerId,
          evaluationVersion: r.evaluationVersion,
        };
        await redis.xadd(STREAM_KEY, '*', 'payload', JSON.stringify(payload));
      }
      enqueued += missingProviders.length;
    }

    return NextResponse.json({ enqueued });
  }

  if (status === 'all') {
    const providers = await db
      .select()
      .from(judgeProviders)
      .where(eq(judgeProviders.enabled, true));

    if (providers.length === 0) {
      return NextResponse.json({ error: 'No enabled judge providers' }, { status: 422 });
    }

    const judgeMeta: JudgeMeta = {
      targetProviderIds: providers.map((p) => p.id),
    };

    const conditions = scenarioId
      ? [eq(runResults.scenarioId, scenarioId)]
      : [];

    const results = await db
      .select({ id: runResults.id })
      .from(runResults)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    // Atomic: version bump + reset for each result, then enqueue
    for (const r of results) {
      await db.transaction(async (tx) => {
        await tx
          .update(runResults)
          .set({
            evaluationVersion: sql`evaluation_version + 1`,
            judgeStatus: 'pending',
            judgeMeta: judgeMeta as unknown as Record<string, unknown>,
            compositeScore: null,
            judgeScores: null,
            blockingFlags: null,
          })
          .where(eq(runResults.id, r.id));
      });

      await enqueueJudgeTasks(r.id);
    }

    return NextResponse.json({ enqueued: results.length });
  }

  return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
}

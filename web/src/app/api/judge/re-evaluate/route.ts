import { NextResponse } from 'next/server';
import { db } from '@/db';
import { runResults, judgeProviders } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { enqueueJudgeTasks } from '@/lib/judge/service';
import type { JudgeMeta } from '@/lib/judge/types';

export async function POST(request: Request) {
  const { runResultId } = await request.json();
  if (!runResultId) {
    return NextResponse.json({ error: 'runResultId required' }, { status: 400 });
  }

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

  // Atomic: version bump + reset + snapshot, then enqueue
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
      .where(eq(runResults.id, runResultId));
  });

  await enqueueJudgeTasks(runResultId);

  return NextResponse.json({ ok: true });
}

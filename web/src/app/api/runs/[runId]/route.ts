import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, runResults, agents, agentExecutors, models, scenarios } from '@/db/schema';
import { activeSchedulers } from '../route';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  // Join tasks with agent/model/scenario names for client-side hydration
  const tasks = await db
    .select({
      id: runTasks.id,
      status: runTasks.status,
      agentName: agents.name,
      modelName: models.name,
      scenarioSlug: scenarios.slug,
      startedAt: runTasks.startedAt,
      finishedAt: runTasks.finishedAt,
      exitCode: runTasks.exitCode,
    })
    .from(runTasks)
    .innerJoin(agentExecutors, eq(runTasks.agentExecutorId, agentExecutors.id))
    .innerJoin(agents, eq(agentExecutors.agentId, agents.id))
    .innerJoin(models, eq(runTasks.modelId, models.id))
    .innerJoin(scenarios, eq(runTasks.scenarioId, scenarios.id))
    .where(eq(runTasks.runId, runId));

  // Join results with agent/model/scenario names for score hydration
  const results = await db
    .select({
      id: runResults.id,
      status: runResults.status,
      agentName: agents.name,
      modelName: models.name,
      scenarioSlug: scenarios.slug,
      testsPassed: runResults.testsPassed,
      testsTotal: runResults.testsTotal,
      totalScore: runResults.totalScore,
      durationSeconds: runResults.durationSeconds,
      attempt: runResults.attempt,
      maxAttempts: runResults.maxAttempts,
    })
    .from(runResults)
    .innerJoin(agents, eq(runResults.agentId, agents.id))
    .innerJoin(models, eq(runResults.modelId, models.id))
    .innerJoin(scenarios, eq(runResults.scenarioId, scenarios.id))
    .where(eq(runResults.runId, runId));

  return NextResponse.json({ ...run, tasks, results });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const scheduler = activeSchedulers.get(runId);
  if (scheduler) {
    await scheduler.cancel(runId);
  }

  await db.update(runs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(runs.id, runId));

  return NextResponse.json({ status: 'cancelled' });
}

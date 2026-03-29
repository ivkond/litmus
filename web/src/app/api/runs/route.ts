import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, agents, agentExecutors, models, scenarios } from '@/db/schema';
import { Scheduler } from '@/lib/orchestrator/scheduler';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { Reconciler } from '@/lib/orchestrator/reconciler';
import { runEventBus } from '@/lib/orchestrator/event-bus';
import { env } from '@/lib/env';
import { z } from 'zod';
import type { LaneConfig } from '@/lib/orchestrator/types';

const createRunSchema = z.object({
  agents: z.array(z.object({
    id: z.string().uuid(),
    models: z.array(z.string().uuid()),
  })).min(1),
  scenarios: z.array(z.string().uuid()).min(1),
  maxRetries: z.number().int().min(1).max(10).default(3),
  maxConcurrentLanes: z.number().int().min(1).max(10).default(3),
  /** Per-step timeout in seconds (run.sh, test script). 0 = no timeout. */
  stepTimeoutSeconds: z.number().int().min(0).max(3600).default(0),
});

// In-memory scheduler registry (single instance)
export const activeSchedulers = new Map<string, Scheduler>();

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createRunSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { agents: agentSelections, scenarios: scenarioIds, maxRetries, maxConcurrentLanes, stepTimeoutSeconds } = parsed.data;

  // ── Phase 1: Validate all entities BEFORE any DB writes ──────────
  // All validation errors return 400 before touching the database.
  const lanes: LaneConfig[] = [];
  const taskInserts: Array<{ agentExecutorId: string; modelId: string; scenarioId: string }> = [];

  for (const agentSel of agentSelections) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentSel.id));
    const [executor] = await db
      .select()
      .from(agentExecutors)
      .where(eq(agentExecutors.agentId, agentSel.id))
      .limit(1);

    if (!agent || !executor || executor.type !== 'docker') {
      return NextResponse.json(
        { error: `Agent ${agentSel.id} has no docker executor` },
        { status: 400 },
      );
    }

    // Parse agent's available models for validation
    interface AvailableModel { dbId: string; externalId: string; name: string }
    const available = (agent.availableModels ?? []) as AvailableModel[];
    const availableDbIds = new Set(available.map((m) => m.dbId));

    for (const modelId of agentSel.models) {
      const [model] = await db.select().from(models).where(eq(models.id, modelId));
      if (!model) {
        return NextResponse.json({ error: `Model ${modelId} not found` }, { status: 400 });
      }

      // Validate the model was discovered for this agent
      if (availableDbIds.size > 0 && !availableDbIds.has(model.id)) {
        return NextResponse.json(
          { error: `Model "${model.name}" is not available for agent "${agent.name}". Run model discovery first.` },
          { status: 400 },
        );
      }

      const laneScenarios = [];
      for (const scenarioId of scenarioIds) {
        const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId));
        if (!scenario) {
          return NextResponse.json({ error: `Scenario ${scenarioId} not found` }, { status: 400 });
        }

        taskInserts.push({ agentExecutorId: executor.id, modelId: model.id, scenarioId: scenario.id });

        laneScenarios.push({
          id: scenario.id,
          slug: scenario.slug,
          promptPath: `${scenario.slug}/prompt.txt`,
          language: scenario.language ?? 'python',
        });
      }

      // externalId comes from per-agent discovery (availableModels JSONB), not shared models table
      const agentModel = available.find((m) => m.dbId === model.id);
      const externalId = agentModel?.externalId ?? model.name;

      lanes.push({
        agent: { id: agent.id, slug: executor.agentSlug, name: agent.name },
        model: { id: model.id, name: model.name, externalId },
        executorId: executor.id,
        scenarios: laneScenarios,
      });
    }
  }

  // ── Phase 2: All validated — atomic transaction for run + tasks ──
  // If anything fails here it rolls back; no orphan rows possible.
  const { run, taskRows } = await db.transaction(async (tx) => {
    const [newRun] = await tx.insert(runs).values({
      status: 'pending',
      configSnapshot: parsed.data,
    }).returning();

    let insertedTasks: Array<{ id: string; agentExecutorId: string; modelId: string; scenarioId: string }> = [];
    if (taskInserts.length > 0) {
      insertedTasks = await tx.insert(runTasks).values(
        taskInserts.map((t) => ({ ...t, runId: newRun.id, status: 'pending' as const })),
      ).returning({ id: runTasks.id, agentExecutorId: runTasks.agentExecutorId, modelId: runTasks.modelId, scenarioId: runTasks.scenarioId });
    }

    return { run: newRun, taskRows: insertedTasks };
  });

  // Build composite-key → DB UUID map for scheduler
  const taskIds = new Map<string, string>();
  for (const row of taskRows) {
    taskIds.set(`${row.agentExecutorId}:${row.modelId}:${row.scenarioId}`, row.id);
  }

  // Fire-and-forget scheduler execution (outside transaction)
  const dockerExecutor = new DockerExecutor(env.DOCKER_HOST);
  const reconciler = new Reconciler();
  const scheduler = new Scheduler(dockerExecutor, reconciler, runEventBus, env.WORK_ROOT);
  activeSchedulers.set(run.id, scheduler);

  scheduler.execute({
    runId: run.id,
    lanes,
    maxRetries,
    maxConcurrentLanes,
    stepTimeoutSeconds,
    taskIds,
  }).finally(() => {
    activeSchedulers.delete(run.id);
  });

  return NextResponse.json({ runId: run.id }, { status: 201 });
}

export async function GET() {
  const rows = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50);
  return NextResponse.json(rows);
}

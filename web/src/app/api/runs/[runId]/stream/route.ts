import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, runResults, agents, agentExecutors, models, scenarios } from '@/db/schema';
import { runEventBus } from '@/lib/orchestrator/event-bus';
import type { RunEvent } from '@/lib/orchestrator/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: RunEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Replay terminal states for reconnection
      const terminalTasks = await db
        .select()
        .from(runTasks)
        .where(
          and(
            eq(runTasks.runId, runId),
            inArray(runTasks.status, ['completed', 'failed', 'error', 'cancelled']),
          ),
        );

      for (const task of terminalTasks) {
        const [executorRow] = await db.select().from(agentExecutors).where(eq(agentExecutors.id, task.agentExecutorId));
        const [agentRow] = executorRow
          ? await db.select().from(agents).where(eq(agents.id, executorRow.agentId))
          : [null];
        const [modelRow] = await db.select().from(models).where(eq(models.id, task.modelId));
        const [scenarioRow] = await db.select().from(scenarios).where(eq(scenarios.id, task.scenarioId));

        // Look up result with full key including agentId to avoid cross-agent collisions
        const [result] = agentRow
          ? await db
              .select()
              .from(runResults)
              .where(
                and(
                  eq(runResults.runId, runId),
                  eq(runResults.agentId, agentRow.id),
                  eq(runResults.scenarioId, task.scenarioId),
                  eq(runResults.modelId, task.modelId),
                ),
              )
          : [];

        if (task.status === 'completed' && result) {
          send({
            type: 'task:completed', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
            attempt: result.attempt, maxAttempts: result.maxAttempts,
            score: result.totalScore, testsPassed: result.testsPassed,
            testsTotal: result.testsTotal, duration: result.durationSeconds, final: true,
          });
        } else if (task.status === 'failed' && result) {
          send({
            type: 'task:failed', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
            attempt: result.attempt, maxAttempts: result.maxAttempts,
            score: result.totalScore, errorMessage: result.errorMessage ?? 'Tests failed', final: true,
          });
        } else if (task.status === 'error') {
          send({
            type: 'task:error', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
            errorMessage: task.errorMessage ?? 'Unknown error',
          });
        } else if (task.status === 'cancelled') {
          send({
            type: 'task:cancelled', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
          });
        }
      }

      // Subscribe to live events
      const unsub = runEventBus.subscribe(runId, (event) => {
        try {
          send(event);
          if (event.type === 'run:completed' || event.type === 'run:cancelled') {
            unsub();
            controller.close();
          }
        } catch {
          unsub();
        }
      });

      // Close immediately if run already finished
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      if (run && ['completed', 'failed', 'error', 'cancelled'].includes(run.status)) {
        unsub();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

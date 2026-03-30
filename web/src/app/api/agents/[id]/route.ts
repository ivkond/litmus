import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors, runResults, runTasks } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';

class ConflictError extends Error {}

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  version: z.string().optional(),
  executor: z.object({
    type: z.enum(['docker', 'host', 'kubernetes']).optional(),
    agentSlug: z.string().min(1).optional(),
    binaryPath: z.string().optional(),
    healthCheck: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const parsed = updateAgentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { name, version, executor } = parsed.data;

  const [existing] = await db.select().from(agents).where(eq(agents.id, id));
  if (!existing) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  if (name !== undefined || version !== undefined) {
    await db
      .update(agents)
      .set({
        ...(name !== undefined && { name }),
        ...(version !== undefined && { version: version || null }),
      })
      .where(eq(agents.id, id));
  }

  if (executor) {
    const existing = await db
      .select()
      .from(agentExecutors)
      .where(eq(agentExecutors.agentId, id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(agentExecutors)
        .set(executor)
        .where(eq(agentExecutors.id, existing[0].id));
    } else {
      // No executor exists — fail-fast if required fields are missing
      if (!executor.type || !executor.agentSlug) {
        return NextResponse.json(
          { error: 'executor.type and executor.agentSlug are required to create a new executor' },
          { status: 400 },
        );
      }
      await db
        .insert(agentExecutors)
        .values({
          agentId: id,
          type: executor.type,
          agentSlug: executor.agentSlug,
          binaryPath: executor.binaryPath,
          healthCheck: executor.healthCheck,
          config: executor.config ?? {},
        });
    }
  }

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));
  const executors = await db.select().from(agentExecutors).where(eq(agentExecutors.agentId, id));

  return NextResponse.json({ ...updated, executors });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // Block deletion if agent has historical data referencing it (409 Conflict).
  // Checks run_results (→ agents.id) and run_tasks (→ agent_executors.id).
  // All inside one transaction to prevent race conditions.
  try {
    await db.transaction(async (tx) => {
      const resultRefs = await tx.select().from(runResults).where(eq(runResults.agentId, id));
      if (resultRefs.length > 0) {
        throw new ConflictError(
          `Cannot delete agent: ${resultRefs.length} run results reference it. Archive or reassign first.`,
        );
      }

      const executorRows = await tx.select().from(agentExecutors).where(eq(agentExecutors.agentId, id));
      if (executorRows.length > 0) {
        const executorIds = executorRows.map((e) => e.id);
        const taskRefs = await tx.select().from(runTasks).where(inArray(runTasks.agentExecutorId, executorIds));
        if (taskRefs.length > 0) {
          throw new ConflictError(
            `Cannot delete agent: ${taskRefs.length} run tasks reference its executor. Archive or reassign first.`,
          );
        }
      }

      await tx.delete(agentExecutors).where(eq(agentExecutors.agentId, id));
      await tx.delete(agents).where(eq(agents.id, id));
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // FK constraint violation from concurrent insert between check and delete
    // SQLSTATE 23503 = foreign_key_violation (pg driver exposes as err.code)
    const dbCode = (err as Error & { code?: string }).code;
    if (dbCode === '23503' || (err instanceof Error && /foreign key|violates.*constraint/i.test(err.message))) {
      return NextResponse.json(
        { error: 'Cannot delete agent: concurrent data references it. Try again.' },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ deleted: id });
}

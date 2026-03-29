import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors } from '@/db/schema';
import { z } from 'zod';

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

  if (name || version) {
    await db
      .update(agents)
      .set({ ...(name && { name }), ...(version && { version }) })
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
    }
  }

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));
  const executors = await db.select().from(agentExecutors).where(eq(agentExecutors.agentId, id));

  return NextResponse.json({ ...updated, executors });
}

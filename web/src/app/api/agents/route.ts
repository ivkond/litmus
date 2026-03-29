import { NextResponse } from 'next/server';
import { db } from '@/db';
import { agents, agentExecutors } from '@/db/schema';
import { z } from 'zod';

export async function GET() {
  const allAgents = await db.select().from(agents).orderBy(agents.name);
  const allExecutors = await db.select().from(agentExecutors);

  const result = allAgents.map((agent) => ({
    ...agent,
    executors: allExecutors.filter((e) => e.agentId === agent.id),
  }));

  return NextResponse.json(result);
}

const createAgentSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  executor: z.object({
    type: z.enum(['docker', 'host', 'kubernetes']),
    agentSlug: z.string().min(1),
    binaryPath: z.string().optional(),
    healthCheck: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
});

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createAgentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { name, version, executor } = parsed.data;

  const [agent] = await db.insert(agents).values({ name, version }).returning();

  const [exec] = await db
    .insert(agentExecutors)
    .values({
      agentId: agent.id,
      type: executor.type,
      agentSlug: executor.agentSlug,
      binaryPath: executor.binaryPath,
      healthCheck: executor.healthCheck,
      config: executor.config ?? {},
    })
    .returning();

  return NextResponse.json({ ...agent, executors: [exec] }, { status: 201 });
}

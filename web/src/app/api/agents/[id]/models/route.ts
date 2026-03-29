import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors, models } from '@/db/schema';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { env } from '@/lib/env';
import path from 'path';

interface DiscoveredModel {
  id: string;
  name: string;
  provider?: string;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  const [executor] = await db
    .select()
    .from(agentExecutors)
    .where(eq(agentExecutors.agentId, id))
    .limit(1);

  if (!executor) {
    return NextResponse.json({ error: 'No executor configured' }, { status: 400 });
  }

  const docker = new DockerExecutor(env.DOCKER_HOST);

  const agentHostDir = env.AGENTS_HOST_DIR
    ? path.resolve(env.AGENTS_HOST_DIR, 'agents', executor.agentSlug)
    : path.resolve('./agents', executor.agentSlug);
  const workHostDir = env.WORK_HOST_DIR ?? path.resolve('./work');

  const handle = await docker.start({
    image: 'litmus/runtime-python',
    agentHostDir,
    workHostDir,
    runId: 'model-discovery',
    env: (executor.config as Record<string, string>) ?? {},
  });

  try {
    const result = await docker.exec(handle, ['/opt/agent/models.sh']);

    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: `models.sh failed: ${result.stderr}` },
        { status: 500 },
      );
    }

    const discovered: DiscoveredModel[] = JSON.parse(result.stdout);
    const availableModels = [];

    for (const m of discovered) {
      // Upsert into shared models table (name + provider only; externalId is per-agent)
      const [row] = await db
        .insert(models)
        .values({ name: m.name, provider: m.provider })
        .onConflictDoUpdate({
          target: models.name,
          set: { provider: m.provider },
        })
        .returning();

      // Per-agent mapping: externalId stored in agents.availableModels JSONB
      availableModels.push({
        dbId: row.id,
        externalId: m.id,
        name: m.name,
        provider: m.provider,
      });
    }

    await db
      .update(agents)
      .set({ availableModels })
      .where(eq(agents.id, id));

    return NextResponse.json(availableModels);
  } finally {
    await docker.stop(handle);
  }
}

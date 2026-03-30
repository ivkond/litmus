import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agentExecutors } from '@/db/schema';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { env } from '@/lib/env';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [executor] = await db
    .select()
    .from(agentExecutors)
    .where(eq(agentExecutors.agentId, id))
    .limit(1);

  if (!executor) {
    return NextResponse.json({ error: 'No executor configured for this agent' }, { status: 404 });
  }

  if (executor.type !== 'docker') {
    return NextResponse.json(
      { error: `Health check not implemented for executor type: ${executor.type}` },
      { status: 501 },
    );
  }

  const dockerExecutor = new DockerExecutor(env.DOCKER_HOST);
  const healthy = await dockerExecutor.healthCheck();
  return NextResponse.json({ healthy });
}

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agentExecutors } from '@/db/schema';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { env } from '@/lib/env';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';

const RUNTIME_IMAGE = 'litmus/runtime-python';

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

  if (executor.type === 'docker') {
    const dockerExecutor = new DockerExecutor(env.DOCKER_HOST);
    const daemonHealthy = await dockerExecutor.healthCheck();
    if (!daemonHealthy) {
      return NextResponse.json({ healthy: false, reason: 'docker-daemon-unreachable' });
    }

    const imageExists = await dockerExecutor.checkImage(RUNTIME_IMAGE);
    if (!imageExists) {
      return NextResponse.json({ healthy: false, reason: 'runtime-image-missing', image: RUNTIME_IMAGE });
    }

    return NextResponse.json({ healthy: true, image: RUNTIME_IMAGE });
  }

  if (executor.type === 'host') {
    if (!executor.binaryPath) {
      return NextResponse.json({ healthy: false, reason: 'binary-path-not-configured' });
    }

    const binaryExists = existsSync(executor.binaryPath);
    if (!binaryExists) {
      return NextResponse.json({ healthy: false, reason: 'binary-not-found', path: executor.binaryPath });
    }

    try {
      const stats = await stat(executor.binaryPath);
      const isExecutable = (stats.mode & parseInt('111', 8)) !== 0;
      if (!isExecutable) {
        return NextResponse.json({ healthy: false, reason: 'binary-not-executable', path: executor.binaryPath });
      }
    } catch {
      return NextResponse.json({ healthy: false, reason: 'binary-access-error', path: executor.binaryPath });
    }

    return NextResponse.json({ healthy: true, path: executor.binaryPath });
  }

  return NextResponse.json(
    { error: `Health check not implemented for executor type: ${executor.type}` },
    { status: 501 },
  );
}

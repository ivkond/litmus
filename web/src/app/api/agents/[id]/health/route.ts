import { NextResponse } from 'next/server';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { env } from '@/lib/env';

export async function POST() {
  const executor = new DockerExecutor(env.DOCKER_HOST);
  const healthy = await executor.healthCheck();
  return NextResponse.json({ healthy });
}

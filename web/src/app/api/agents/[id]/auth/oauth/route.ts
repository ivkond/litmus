import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors } from '@/db/schema';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import {
  resolveAgentHostDirForDocker,
  resolveWorkHostDirForDocker,
} from '@/lib/orchestrator/docker-bind-paths';
import { env } from '@/lib/env';
import { getDecryptedSecretsForExecutor } from '@/lib/agents/secrets';
import { isOAuthCapable } from '@/lib/agents/auth-discovery';
import type { AcpAuthMethod } from '@/lib/agents/auth-discovery';
import {
  captureOAuthCredentials,
  isCaptureLocked,
  lockCapture,
  unlockCapture,
} from '@/lib/agents/oauth-capture';
import type { OAuthEvent } from '@/lib/agents/oauth-capture';

export async function POST(
  request: Request,
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

  const body = await request.json();
  const { methodId: acpMethodId } = body as { methodId?: string };

  if (!acpMethodId) {
    return NextResponse.json({ error: 'methodId is required' }, { status: 400 });
  }

  const cachedMethods = (executor.authMethods as AcpAuthMethod[] | null) ?? [];
  const method = cachedMethods.find((m) => m.id === acpMethodId);
  if (!method || !isOAuthCapable(method)) {
    return NextResponse.json(
      { error: 'methodId not found or not oauth-capable' },
      { status: 400 },
    );
  }

  if (isCaptureLocked(executor.id)) {
    return NextResponse.json(
      { error: 'OAuth capture already in progress for this executor' },
      { status: 409 },
    );
  }

  const controller = lockCapture(executor.id);

  const docker = new DockerExecutor(env.DOCKER_HOST);
  const agentHostDir = resolveAgentHostDirForDocker(executor.agentType);
  const workHostDir = resolveWorkHostDirForDocker();

  const secrets = await getDecryptedSecretsForExecutor(executor.id);
  const configEnv = (executor.config as Record<string, string>) ?? {};
  const mergedEnv = { ...configEnv, ...secrets, BROWSER: 'echo' };

  let handle: Awaited<ReturnType<typeof docker.start>> | null = null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(streamController) {
      const emit = (event: OAuthEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          streamController.enqueue(encoder.encode(data));
        } catch {
          // Stream may be closed
        }
      };

      try {
        handle = await docker.start({
          image: 'litmus/runtime-python',
          agentHostDir,
          workHostDir,
          runId: 'oauth-capture',
          env: mergedEnv,
          labels: {
            'litmus.managed': 'true',
            'litmus-oauth': 'true',
            'litmus.executor-id': executor.id,
          },
        });

        await captureOAuthCredentials({
          executor: docker,
          handle,
          executorId: executor.id,
          agentType: executor.agentType,
          acpMethodId,
          signal: controller.signal,
          emit,
        });
      } catch (error) {
        emit({
          type: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (handle) {
          try { await docker.stop(handle); } catch { /* best effort */ }
        }
        unlockCapture(executor.id);
        streamController.close();
      }
    },
    cancel() {
      unlockCapture(executor.id);
      if (handle) {
        docker.stop(handle).catch(() => {});
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
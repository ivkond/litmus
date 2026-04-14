import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors, models } from '@/db/schema';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import {
  resolveAgentHostDirForDocker,
  resolveWorkHostDirForDocker,
} from '@/lib/orchestrator/docker-bind-paths';
import { env } from '@/lib/env';
import { getDecryptedSecretsForExecutor } from '@/lib/agents/secrets';
import { collect } from '@/lib/orchestrator/collect';
import { AcpSession } from '@/lib/orchestrator/acp-session';
import { resolveAcpConfig } from '@/lib/orchestrator/acp-config';
import { extractAuthMethods } from '@/lib/agents/auth-discovery';

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

  const agentHostDir = resolveAgentHostDirForDocker(executor.agentType);
  const workHostDir = resolveWorkHostDirForDocker();

  const secrets = await getDecryptedSecretsForExecutor(executor.id);
  const configEnv = (executor.config as Record<string, string>) ?? {};
  const mergedEnv = { ...configEnv, ...secrets };

  const handle = await docker.start({
    image: 'litmus/runtime-python',
    agentHostDir,
    workHostDir,
    runId: 'model-discovery',
    env: mergedEnv,
  });

  try {
    // ── Phase 1: ACP Auth Discovery ──────────────────────────────
    // Start ACP session to extract authMethods from initialize response.
    // If ACP init fails, set authMethods to null and continue with model discovery.
    const acpConfig = resolveAcpConfig(executor.agentType);
    let discoveredAuthMethods: unknown = null;

    try {
      const { session, initResponse } = await AcpSession.startForDiscovery(
        docker, handle, acpConfig,
      );

      // Semantics: [] = discovery succeeded with zero methods; null = discovery
      // not yet performed or failed. We reached this branch only after ACP init
      // succeeded, so we store the array as-is (even when empty).
      discoveredAuthMethods = extractAuthMethods(initResponse);

      // Close ACP session — we only needed the init response
      await session.close();
    } catch (acpError) {
      console.warn(
        `[models] ACP auth discovery failed for agent "${executor.agentType}":`,
        acpError instanceof Error ? acpError.message : String(acpError),
      );
      // discoveredAuthMethods stays null — ACP init failed
    }

    // Cache auth methods to executor row
    await db
      .update(agentExecutors)
      .set({
        authMethods: discoveredAuthMethods,
        authMethodsDiscoveredAt: new Date(),
      })
      .where(eq(agentExecutors.id, executor.id));

    // ── Phase 2: Model Discovery (existing logic) ────────────────
    const result = await collect(docker, handle, ['/opt/agent/models.sh']);

    if (result.exitCode !== 0) {
      return NextResponse.json(
        {
          error: `models.sh failed (exit ${result.exitCode})`,
          stderr: result.stderr || null,
          stdout: result.stdout || null,
        },
        { status: 500 },
      );
    }

    // Strip ANSI escape sequences and non-printable chars that may leak from CLI output
    const sanitized = result.stdout
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    const discovered: DiscoveredModel[] = JSON.parse(sanitized);
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
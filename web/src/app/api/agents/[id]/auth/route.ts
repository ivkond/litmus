import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors, agentSecrets } from '@/db/schema';
import { decrypt, hasEncryptionKey } from '@/lib/encryption';
import { saveSecret, saveCredentialBlob, deleteSecret } from '@/lib/agents/secrets';
import { isOAuthCapable } from '@/lib/agents/auth-discovery';
import type { AcpAuthMethod } from '@/lib/agents/auth-discovery';
import { spawn } from 'child_process';

export class TarMissingError extends Error {
  constructor() {
    super(
      'Host `tar` binary not found. Install tar on the server host ' +
      '(Linux/macOS native, Windows 10 build 17063+, or Git Bash) and restart.',
    );
    this.name = 'TarMissingError';
  }
}

async function validateUploadedTarArchive(tarBuffer: Buffer): Promise<void> {
  const listing = await new Promise<string>((resolve, reject) => {
    const child = spawn('tar', ['-tzvf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new TarMissingError());
      else reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`tar listing failed (exit ${code}): ${stderr}`));
      else resolve(stdout);
    });
    child.stdin.write(tarBuffer);
    child.stdin.end();
  });

  const DRIVE_LETTER = /^[A-Za-z]:[/\\]/;
  for (const rawLine of listing.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const perms = parts[0];
    const nameAndLink = parts.slice(5).join(' ');
    const [name, linkTarget] = nameAndLink.split(' -> ');

    if (name.startsWith('/') || DRIVE_LETTER.test(name)) {
      throw new Error(`absolute path not allowed: "${name}"`);
    }
    const segments = name.split(/[/\\]/);
    if (segments.some((s) => s === '..')) {
      throw new Error(`path traversal not allowed: "${name}"`);
    }
    if (perms.startsWith('l') && linkTarget !== undefined) {
      if (linkTarget.startsWith('/') || DRIVE_LETTER.test(linkTarget)) {
        throw new Error(`symlink target must be relative: "${name}" -> "${linkTarget}"`);
      }
      const linkSegments = linkTarget.split(/[/\\]/);
      if (linkSegments.some((s) => s === '..')) {
        throw new Error(`symlink escapes archive root: "${name}" -> "${linkTarget}"`);
      }
    }
  }
}

async function getExecutor(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;

  const [executor] = await db
    .select()
    .from(agentExecutors)
    .where(eq(agentExecutors.agentId, agentId))
    .limit(1);

  return executor ?? null;
}

function maskJsonValues(encrypted: string): Record<string, string> | null {
  try {
    const decrypted = decrypt(encrypted);
    const parsed = JSON.parse(decrypted);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const masked: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          masked[key] = value.length > 8 ? '••••' + value.slice(-4) : '••••';
        }
      }
      return masked;
    }
  } catch {
    // Old format or decryption failure
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const executor = await getExecutor(id);
  if (!executor) {
    return NextResponse.json({ error: 'Agent or executor not found' }, { status: 404 });
  }

  const cachedMethods = (executor.authMethods as AcpAuthMethod[] | null) ?? [];

  const secrets = await db
    .select({
      acpMethodId: agentSecrets.acpMethodId,
      encryptedValue: agentSecrets.encryptedValue,
      authType: agentSecrets.authType,
    })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentExecutorId, executor.id));

  const secretMap = new Map(secrets.map((s) => [s.acpMethodId, s]));

  const methods = cachedMethods.map((method) => {
    const secret = secretMap.get(method.id);
    const configured = !!secret;
    const oauthCapable = isOAuthCapable(method);

    let maskedValues: Record<string, string> | null = null;
    if (secret && secret.authType === 'api_key') {
      maskedValues = maskJsonValues(secret.encryptedValue);
    }

    return {
      ...method,
      configured,
      oauthCapable,
      maskedValues,
    };
  });

  return NextResponse.json({
    methods,
    discoveryRequired: executor.authMethodsDiscoveredAt == null,
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!hasEncryptionKey()) {
    return NextResponse.json(
      { error: 'No encryption key configured (set LITMUS_ENCRYPTION_KEY or JUDGE_ENCRYPTION_KEY)' },
      { status: 503 },
    );
  }

  const executor = await getExecutor(id);
  if (!executor) {
    return NextResponse.json({ error: 'Agent or executor not found' }, { status: 404 });
  }

  const cachedMethods = (executor.authMethods as AcpAuthMethod[] | null) ?? [];

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const acpMethodId = formData.get('methodId') as string | null;
    const file = formData.get('files') as File | null;
    const credentialPathsRaw = formData.get('credentialPaths') as string | null;

    if (!acpMethodId || !file) {
      return NextResponse.json({ error: 'methodId and files are required for credential_files' }, { status: 400 });
    }

    const credentialPaths: string[] = credentialPathsRaw ? JSON.parse(credentialPathsRaw) : [];

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'Credential file exceeds 10MB limit' }, { status: 413 });
    }

    const method = cachedMethods.find((m) => m.id === acpMethodId);
    if (!method) {
      return NextResponse.json(
        { error: `Auth method "${acpMethodId}" not found. Run model discovery first.` },
        { status: 400 },
      );
    }

    const arrayBuf = await file.arrayBuffer();
    const tarBuffer = Buffer.from(arrayBuf);

    try {
      await validateUploadedTarArchive(tarBuffer);
    } catch (validationError) {
      if (validationError instanceof TarMissingError) {
        return NextResponse.json({ error: validationError.message }, { status: 500 });
      }
      return NextResponse.json(
        {
          error: `Rejected unsafe tar archive: ${
            validationError instanceof Error ? validationError.message : String(validationError)
          }`,
        },
        { status: 400 },
      );
    }

    const base64Tar = tarBuffer.toString('base64');

    await saveCredentialBlob({
      executorId: executor.id,
      acpMethodId,
      base64Tar,
      credentialPaths,
    });

    return NextResponse.json({ methodId: acpMethodId, saved: true }, { status: 201 });
  }

  const body = await request.json();
  const { methodId: acpMethodId, type: authType, values } = body as {
    methodId?: string;
    type?: string;
    values?: Record<string, string>;
  };

  if (!acpMethodId) {
    return NextResponse.json({ error: 'methodId is required' }, { status: 400 });
  }

  const method = cachedMethods.find((m) => m.id === acpMethodId);
  if (!method) {
    return NextResponse.json(
      { error: `Auth method "${acpMethodId}" not found. Run model discovery first.` },
      { status: 400 },
    );
  }

  if (authType === 'api_key') {
    if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
      return NextResponse.json({ error: 'values object is required for api_key type' }, { status: 400 });
    }

    await saveSecret({
      executorId: executor.id,
      acpMethodId,
      values,
      authType: 'api_key',
    });

    return NextResponse.json({ methodId: acpMethodId, saved: true });
  }

  return NextResponse.json({ error: `Unsupported auth type: ${authType}` }, { status: 400 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const executor = await getExecutor(id);
  if (!executor) {
    return NextResponse.json({ error: 'Agent or executor not found' }, { status: 404 });
  }

  const body = await request.json();
  const { methodId: acpMethodId } = body as { methodId?: string };

  if (!acpMethodId) {
    return NextResponse.json({ error: 'methodId is required' }, { status: 400 });
  }

  await deleteSecret(executor.id, acpMethodId);

  return new NextResponse(null, { status: 204 });
}
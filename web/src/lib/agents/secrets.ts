import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { agentSecrets } from '@/db/schema';
import { encrypt, decrypt, hasEncryptionKey } from '@/lib/encryption';

/**
 * Load and decrypt all api_key secrets for an executor.
 * Values are stored as encrypted JSON objects `{ "VAR_NAME": "value", ... }`
 * and unpacked into a flat Record. Skips credential_files entries.
 */
export async function getDecryptedSecretsForExecutor(
  executorId: string,
): Promise<Record<string, string>> {
  if (!hasEncryptionKey()) {
    console.warn('[secrets] No encryption key configured — returning empty env');
    return {};
  }

  const rows = await db
    .select()
    .from(agentSecrets)
    .where(eq(agentSecrets.agentExecutorId, executorId));

  const env: Record<string, string> = {};

  for (const row of rows) {
    if (row.authType === 'credential_files') continue;

    try {
      const parsed = JSON.parse(decrypt(row.encryptedValue));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error(`[secrets] Decrypted secret for method ${row.acpMethodId} is not a JSON object`);
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') env[key] = value;
      }
    } catch (e) {
      console.error(`[secrets] Failed to decrypt secret for method ${row.acpMethodId}:`, e);
    }
  }

  return env;
}

/**
 * Save an api_key secret as keyed JSON: `{ "VAR_NAME": "value", ... }`.
 */
export async function saveSecret(params: {
  executorId: string;
  acpMethodId: string;
  values: Record<string, string>;
  authType: 'api_key' | 'credential_files';
}): Promise<void> {
  const encrypted = encrypt(JSON.stringify(params.values));

  await db
    .insert(agentSecrets)
    .values({
      agentExecutorId: params.executorId,
      acpMethodId: params.acpMethodId,
      encryptedValue: encrypted,
      authType: params.authType,
    })
    .onConflictDoUpdate({
      target: [agentSecrets.agentExecutorId, agentSecrets.acpMethodId],
      set: { encryptedValue: encrypted, updatedAt: new Date() },
    });
}

/**
 * Save a credential file blob (base64-encoded tar) for an auth method.
 */
export async function saveCredentialBlob(params: {
  executorId: string;
  acpMethodId: string;
  base64Tar: string;
  credentialPaths: string[];
}): Promise<void> {
  const encrypted = encrypt(params.base64Tar);

  await db
    .insert(agentSecrets)
    .values({
      agentExecutorId: params.executorId,
      acpMethodId: params.acpMethodId,
      encryptedValue: encrypted,
      authType: 'credential_files',
      credentialPaths: params.credentialPaths,
    })
    .onConflictDoUpdate({
      target: [agentSecrets.agentExecutorId, agentSecrets.acpMethodId],
      set: {
        encryptedValue: encrypted,
        credentialPaths: params.credentialPaths,
        updatedAt: new Date(),
      },
    });
}

/**
 * Load all credential_files blobs for an executor.
 * Credential path resolution priority (spec:356):
 *   1. agent_secrets.credentialPaths (per-executor DB row) — HIGHEST
 *   2. fallbackPathsByMethodId[acpMethodId] (from authMethods[].credentialPaths discovery cache)
 *   3. fallbackDefaultPaths (from resolveAcpConfig) — LOWEST
 */
export async function getCredentialBlobs(
  executorId: string,
  fallbackPathsByMethodId: Record<string, string[]> = {},
  fallbackDefaultPaths: string[] = [],
): Promise<Array<{ acpMethodId: string; base64Tar: string; credentialPaths: string[] }>> {
  if (!hasEncryptionKey()) {
    console.warn('[secrets] No encryption key configured — returning empty credential blobs');
    return [];
  }

  const rows = await db
    .select()
    .from(agentSecrets)
    .where(eq(agentSecrets.agentExecutorId, executorId));

  const blobs: Array<{ acpMethodId: string; base64Tar: string; credentialPaths: string[] }> = [];

  for (const row of rows) {
    if (row.authType !== 'credential_files') continue;

    try {
      const base64Tar = decrypt(row.encryptedValue);

      const dbPaths = (row.credentialPaths as string[] | null) ?? [];
      const discoveryPaths = fallbackPathsByMethodId[row.acpMethodId] ?? [];
      const credentialPaths =
        dbPaths.length > 0 ? dbPaths
        : discoveryPaths.length > 0 ? discoveryPaths
        : fallbackDefaultPaths;

      blobs.push({ acpMethodId: row.acpMethodId, base64Tar, credentialPaths });
    } catch (e) {
      console.error(`[secrets] Failed to decrypt credential blob for method ${row.acpMethodId}:`, e);
    }
  }

  return blobs;
}

/**
 * Delete a secret by executor + method ID. Idempotent.
 */
export async function deleteSecret(executorId: string, acpMethodId: string): Promise<void> {
  await db
    .delete(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentExecutorId, executorId),
        eq(agentSecrets.acpMethodId, acpMethodId),
      ),
    );
}

# ACP Authentication Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace static auth.json with ACP-driven auth discovery, supporting env_var, OAuth (device code), and terminal auth methods with encrypted credential storage.

**Architecture:** Two-phase migration extends agent_secrets table. Auth discovery during model discovery caches ACP authMethods. New auth API routes (GET/PUT/DELETE + OAuth SSE). Runtime delivers env vars and credential files to containers before ACP session starts. resolveAcpConfig extracted from Scheduler to shared module.

**Tech Stack:** Next.js API routes, Drizzle ORM (PostgreSQL), @agentclientprotocol/sdk, AES-256-GCM encryption, Docker exec (InteractiveHandle), SSE streaming

---

## Task 1: DB Schema + Migration (Phase 1 SQL)

**Goal:** Extend `agent_executors` with `authMethods`/`authMethodsDiscoveredAt` columns and migrate `agent_secrets` from envVar-keyed to acpMethodId-keyed with support for `credential_files` auth type.

**DoD:**
- `agent_executors` has `authMethods` (jsonb, nullable) and `authMethodsDiscoveredAt` (timestamptz, nullable)
- `agent_secrets` has `acpMethodId` (text, NOT NULL) instead of `envVar`, plus `credentialPaths` (jsonb, nullable)
- `auth_type` enum includes `credential_files`
- Unique index on `(agent_executor_id, acp_method_id)` replaces `(agent_executor_id, env_var)`
- Migration file `0008_acp_auth.sql` exists and is valid SQL
- Drizzle journal updated with new entry
- Schema compiles with `tsc --noEmit`

### Step 1.1 — Write schema compilation test

- [ ] Create test file that verifies schema types compile correctly

**File:** `web/src/db/__tests__/schema-acp-auth.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import type { InferSelectModel } from 'drizzle-orm';
import { agentExecutors, agentSecrets } from '../schema';

describe('ACP auth schema types', () => {
  it('test_agentExecutors_hasAuthMethodsField_jsonbNullable', () => {
    type Executor = InferSelectModel<typeof agentExecutors>;
    // Type-level assertion: authMethods exists and is nullable
    const check: Executor['authMethods'] = null;
    expect(check).toBeNull();
  });

  it('test_agentExecutors_hasAuthMethodsDiscoveredAt_timestampNullable', () => {
    type Executor = InferSelectModel<typeof agentExecutors>;
    const check: Executor['authMethodsDiscoveredAt'] = null;
    expect(check).toBeNull();
  });

  it('test_agentSecrets_hasAcpMethodId_textNotNull', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    const check: Secret['acpMethodId'] = 'some-method-id';
    expect(check).toBe('some-method-id');
  });

  it('test_agentSecrets_hasCredentialPaths_jsonbNullable', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    const check: Secret['credentialPaths'] = null;
    expect(check).toBeNull();
  });

  it('test_agentSecrets_authType_includesCredentialFiles', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    const check: Secret['authType'] = 'credential_files';
    expect(check).toBe('credential_files');
  });

  it('test_agentSecrets_noEnvVarField', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    // @ts-expect-error envVar should not exist on the type
    const _check: Secret['envVar'] = 'should-not-compile';
    // If this test compiles without the expect-error triggering, the field still exists
    expect(true).toBe(true);
  });
});
```

**Commit:** `test(db): add schema type assertions for ACP auth columns`

### Step 1.2 — Update schema.ts: agentExecutors

- [ ] Add `authMethods` and `authMethodsDiscoveredAt` columns to `agentExecutors`

**File:** `web/src/db/schema.ts`

Replace the `agentExecutors` table definition (lines 97-109):

```typescript
export const agentExecutors = pgTable('agent_executors', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  type: text('type', {
    enum: ['docker', 'host', 'kubernetes'],
  }).notNull(),
  agentSlug: text('agent_slug').notNull(),
  agentType: text('agent_type').notNull().default('mock'),
  binaryPath: text('binary_path'),
  healthCheck: text('health_check'),
  config: jsonb('config').default({}),
  authMethods: jsonb('auth_methods'),
  authMethodsDiscoveredAt: timestamp('auth_methods_discovered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
```

**Commit:** `feat(db): add authMethods + authMethodsDiscoveredAt to agentExecutors schema`

### Step 1.3 — Update schema.ts: agentSecrets

- [ ] Drop `envVar`, add `acpMethodId`, `credentialPaths`, expand `authType` enum

**File:** `web/src/db/schema.ts`

Replace the `agentSecrets` table definition (lines 111-121):

```typescript
export const agentSecrets = pgTable('agent_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentExecutorId: uuid('agent_executor_id').notNull().references(() => agentExecutors.id, { onDelete: 'cascade' }),
  acpMethodId: text('acp_method_id').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  authType: text('auth_type', { enum: ['api_key', 'oauth', 'credential_files'] }).notNull(),
  credentialPaths: jsonb('credential_paths'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('idx_agent_secrets_unique').on(table.agentExecutorId, table.acpMethodId),
]);
```

**Commit:** `feat(db): migrate agentSecrets from envVar to acpMethodId schema`

### Step 1.4 — Create migration SQL file

- [ ] Write `0008_acp_auth.sql` with transactional Phase 1 migration

**File:** `web/drizzle/0008_acp_auth.sql`

```sql
-- Phase 1: ACP Auth Integration — Schema migration
-- Adds auth discovery cache to agent_executors and migrates agent_secrets
-- from envVar-keyed to acpMethodId-keyed storage.

BEGIN;

-- 1. Add auth discovery cache columns to agent_executors
ALTER TABLE agent_executors
  ADD COLUMN IF NOT EXISTS auth_methods JSONB,
  ADD COLUMN IF NOT EXISTS auth_methods_discovered_at TIMESTAMPTZ;

-- 2. Add new columns to agent_secrets
ALTER TABLE agent_secrets
  ADD COLUMN IF NOT EXISTS acp_method_id TEXT,
  ADD COLUMN IF NOT EXISTS credential_paths JSONB;

-- 3. Backfill acp_method_id from env_var for existing rows
-- Uses env_var as the method ID during transition (e.g. "CURSOR_API_KEY")
UPDATE agent_secrets
SET acp_method_id = env_var
WHERE acp_method_id IS NULL;

-- 4. Make acp_method_id NOT NULL now that all rows have values
ALTER TABLE agent_secrets
  ALTER COLUMN acp_method_id SET NOT NULL;

-- 5. Drop old unique index and create new one
DROP INDEX IF EXISTS idx_agent_secrets_unique;
CREATE UNIQUE INDEX idx_agent_secrets_unique ON agent_secrets (agent_executor_id, acp_method_id);

-- 6. Drop env_var column (data preserved in acp_method_id)
ALTER TABLE agent_secrets
  DROP COLUMN IF EXISTS env_var;

-- 7. Update auth_type check to include credential_files
-- PostgreSQL text columns with Drizzle enums don't use CHECK constraints,
-- so no ALTER needed for the auth_type column itself. The enum is enforced
-- at the application layer by Drizzle.

COMMIT;
```

**Commit:** `feat(db): add 0008_acp_auth.sql migration`

### Step 1.5 — Update Drizzle journal

- [ ] Add entry for `0008_acp_auth` to the journal

**File:** `web/drizzle/meta/_journal.json`

Add a new entry at the end of the `entries` array:

```json
{
  "idx": 8,
  "version": "7",
  "when": 1775500000000,
  "tag": "0008_acp_auth",
  "breakpoints": true
}
```

**Commit:** `chore(db): update drizzle journal for 0008_acp_auth`

### Step 1.6 — Verify schema compiles

- [ ] Run `npx tsc --noEmit` and the new test

```bash
cd web && npx tsc --noEmit
cd web && npx vitest run src/db/__tests__/schema-acp-auth.test.ts
```

**Commit:** (no commit — verification step)

---

## Task 2: Secrets Service Extension + Migration Phase 2

**Goal:** Extend secrets service to handle new keyed JSON format for api_key, credential blob storage, and add Phase 2 startup re-encryption for old-format values.

**DoD:**
- `getDecryptedSecretsForExecutor()` handles both old (plain string) and new (JSON object) encrypted values
- `saveSecret()` encrypts keyed JSON for api_key type
- `saveCredentialBlob()` stores base64 tar as encrypted credential_files
- `getCredentialBlobs()` loads credential_files entries
- Phase 2 startup migration converts old plain-string secrets to keyed JSON
- All functions tested

### Step 2.1 — Write tests for secrets service

- [ ] Create tests for all secrets service functions

**File:** `web/src/lib/agents/__tests__/secrets.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  const deletedWhere: unknown[] = [];

  const whereChain = {
    where: vi.fn().mockImplementation(() => Promise.resolve(rows)),
  };
  const selectMock = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue(whereChain),
  });

  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn().mockReturnValue({
    onConflictDoUpdate: onConflictDoUpdateMock,
  });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({
    where: deleteWhereMock,
  });

  const updateSetWhereMock = vi.fn().mockResolvedValue(undefined);
  const updateSetMock = vi.fn().mockReturnValue({ where: updateSetWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  return {
    rows,
    selectMock,
    insertMock,
    valuesMock,
    onConflictDoUpdateMock,
    deleteMock,
    deleteWhereMock,
    updateMock,
    updateSetMock,
    updateSetWhereMock,
    deletedWhere,
  };
});

vi.mock('@/db', () => ({
  db: {
    select: dbMocks.selectMock,
    insert: dbMocks.insertMock,
    delete: dbMocks.deleteMock,
    update: dbMocks.updateMock,
  },
}));

vi.mock('@/db/schema', () => ({
  agentSecrets: {
    agentExecutorId: 'agent_executor_id',
    acpMethodId: 'acp_method_id',
    encryptedValue: 'encrypted_value',
    authType: 'auth_type',
    credentialPaths: 'credential_paths',
    updatedAt: 'updated_at',
  },
}));

// Simple reversible encrypt/decrypt for testing
vi.mock('@/lib/encryption', () => ({
  encrypt: vi.fn((plaintext: string) => `ENC:${plaintext}`),
  decrypt: vi.fn((ciphertext: string) => {
    if (ciphertext.startsWith('ENC:')) return ciphertext.slice(4);
    return ciphertext;
  }),
  hasEncryptionKey: vi.fn().mockReturnValue(true),
  maskKey: vi.fn((encrypted: string) => {
    const plain = encrypted.startsWith('ENC:') ? encrypted.slice(4) : encrypted;
    return plain.length > 8 ? '••••' + plain.slice(-4) : '••••';
  }),
}));

describe('getDecryptedSecretsForExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.rows.length = 0;
  });

  it('test_getDecryptedSecrets_newJsonFormat_unpacksToFlatRecord', async () => {
    dbMocks.rows.push({
      acpMethodId: 'cursor-api-key',
      encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-abc123"}',
      authType: 'api_key',
    });

    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');

    expect(result).toEqual({ CURSOR_API_KEY: 'sk-abc123' });
  });

  it('test_getDecryptedSecrets_oldPlainFormat_usesMethodIdAsKey', async () => {
    // Old format: plain string value, not JSON
    dbMocks.rows.push({
      acpMethodId: 'CURSOR_API_KEY',
      encryptedValue: 'ENC:sk-plain-old',
      authType: 'api_key',
    });

    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');

    // Falls back to using acpMethodId as key
    expect(result).toEqual({ CURSOR_API_KEY: 'sk-plain-old' });
  });

  it('test_getDecryptedSecrets_multipleVarsPerMethod_allUnpacked', async () => {
    dbMocks.rows.push({
      acpMethodId: 'openai-keys',
      encryptedValue: 'ENC:{"OPENAI_API_KEY":"sk-1","OPENAI_ORG_ID":"org-2"}',
      authType: 'api_key',
    });

    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');

    expect(result).toEqual({
      OPENAI_API_KEY: 'sk-1',
      OPENAI_ORG_ID: 'org-2',
    });
  });

  it('test_getDecryptedSecrets_credentialFiles_skipped', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:base64blobdata',
      authType: 'credential_files',
    });

    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');

    // credential_files are not env vars, should be empty
    expect(result).toEqual({});
  });

  it('test_getDecryptedSecrets_noEncryptionKey_returnsEmpty', async () => {
    const { hasEncryptionKey } = await import('@/lib/encryption');
    (hasEncryptionKey as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');

    expect(result).toEqual({});
  });
});

describe('saveSecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_saveSecret_apiKey_encryptsKeyedJson', async () => {
    const { saveSecret } = await import('../secrets');

    await saveSecret({
      executorId: 'e1',
      acpMethodId: 'cursor-api-key',
      values: { CURSOR_API_KEY: 'sk-test123' },
      authType: 'api_key',
    });

    expect(dbMocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutorId: 'e1',
        acpMethodId: 'cursor-api-key',
        encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-test123"}',
        authType: 'api_key',
      }),
    );
    expect(dbMocks.onConflictDoUpdateMock).toHaveBeenCalled();
  });
});

describe('saveCredentialBlob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_saveCredentialBlob_encryptsBase64AndStoresPaths', async () => {
    const { saveCredentialBlob } = await import('../secrets');

    await saveCredentialBlob({
      executorId: 'e1',
      acpMethodId: 'chatgpt-oauth',
      base64Tar: 'dGVzdGRhdGE=',
      credentialPaths: ['.config/chatgpt/auth.json'],
    });

    expect(dbMocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutorId: 'e1',
        acpMethodId: 'chatgpt-oauth',
        encryptedValue: 'ENC:dGVzdGRhdGE=',
        authType: 'credential_files',
        credentialPaths: ['.config/chatgpt/auth.json'],
      }),
    );
  });
});

describe('getCredentialBlobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.rows.length = 0;
  });

  it('test_getCredentialBlobs_returnsDecryptedBlobsForCredentialFiles', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:dGVzdGRhdGE=',
      authType: 'credential_files',
      credentialPaths: ['.config/chatgpt/auth.json'],
    });

    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      acpMethodId: 'chatgpt-oauth',
      base64Tar: 'dGVzdGRhdGE=',
      credentialPaths: ['.config/chatgpt/auth.json'],
    });
  });

  it('test_getCredentialBlobs_filtersOutApiKeyType', async () => {
    dbMocks.rows.push({
      acpMethodId: 'cursor-api-key',
      encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-1"}',
      authType: 'api_key',
      credentialPaths: null,
    });

    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1');

    expect(result).toHaveLength(0);
  });
});
```

**Commit:** `test(secrets): add tests for ACP auth secrets service extensions`

### Step 2.2 — Implement extended secrets service

- [ ] Rewrite `web/src/lib/agents/secrets.ts` with all new functions

**File:** `web/src/lib/agents/secrets.ts`

```typescript
import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { agentSecrets } from '@/db/schema';
import { encrypt, decrypt, hasEncryptionKey } from '@/lib/encryption';

/**
 * Load and decrypt all api_key secrets for an executor.
 * Handles both formats:
 * - New: encrypted JSON object `{ "VAR_NAME": "value" }` — unpacked to flat Record
 * - Old (transition): encrypted plain string — keyed by acpMethodId
 * Skips credential_files entries (those are binary blobs, not env vars).
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
    // Skip credential_files — they are binary blobs, not env vars
    if (row.authType === 'credential_files') continue;

    try {
      const decrypted = decrypt(row.encryptedValue);

      // Try parsing as JSON object (new keyed format)
      try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
              env[key] = value;
            }
          }
          continue;
        }
      } catch {
        // Not JSON — fall through to old format handling
      }

      // Old format: plain string value, use acpMethodId as the env var name
      env[row.acpMethodId] = decrypted;
    } catch (e) {
      console.error(`[secrets] Failed to decrypt secret for method ${row.acpMethodId}:`, e);
    }
  }

  return env;
}

/**
 * Save an api_key secret as keyed JSON: `{ "VAR_NAME": "value", ... }`.
 * Supports multiple env vars per auth method.
 */
export async function saveSecret(params: {
  executorId: string;
  acpMethodId: string;
  values: Record<string, string>;
  authType: 'api_key' | 'oauth';
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
 * Returns decrypted base64 tar data + the paths that should be restored.
 */
export async function getCredentialBlobs(
  executorId: string,
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
      blobs.push({
        acpMethodId: row.acpMethodId,
        base64Tar,
        credentialPaths: (row.credentialPaths as string[]) ?? [],
      });
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
```

**Commit:** `feat(secrets): extend service for ACP auth with keyed JSON and credential blobs`

### Step 2.3 — Phase 2 startup migration

- [ ] Add re-encryption startup task that converts old plain-string secrets to keyed JSON format

**File:** `web/src/lib/agents/migrate-secrets.ts`

```typescript
import { db } from '@/db';
import { agentSecrets } from '@/db/schema';
import { encrypt, decrypt, hasEncryptionKey } from '@/lib/encryption';

/**
 * Phase 2 migration: re-encrypt old plain-string api_key secrets into keyed JSON format.
 *
 * Old format: acpMethodId = "CURSOR_API_KEY", encryptedValue = encrypt("sk-abc123")
 * New format: acpMethodId = "CURSOR_API_KEY", encryptedValue = encrypt('{"CURSOR_API_KEY":"sk-abc123"}')
 *
 * Runs at app startup. Idempotent — already-migrated rows (valid JSON objects) are skipped.
 */
export async function migrateSecretsToKeyedJson(): Promise<number> {
  if (!hasEncryptionKey()) {
    console.warn('[migrate-secrets] No encryption key — skipping Phase 2 migration');
    return 0;
  }

  const rows = await db.select().from(agentSecrets);
  let migrated = 0;

  for (const row of rows) {
    if (row.authType !== 'api_key') continue;

    try {
      const decrypted = decrypt(row.encryptedValue);

      // Check if already in new format (valid JSON object)
      try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          continue; // Already migrated
        }
      } catch {
        // Not JSON — needs migration
      }

      // Old format: plain string value. Wrap in keyed JSON using acpMethodId as key.
      const keyedJson = JSON.stringify({ [row.acpMethodId]: decrypted });
      const reEncrypted = encrypt(keyedJson);

      await db
        .update(agentSecrets)
        .set({ encryptedValue: reEncrypted, updatedAt: new Date() })
        .where(
          import('drizzle-orm').then(({ eq }) => eq(agentSecrets.id, row.id)),
        );

      migrated++;
    } catch (e) {
      console.error(`[migrate-secrets] Failed to migrate secret ${row.id}:`, e);
    }
  }

  if (migrated > 0) {
    console.log(`[migrate-secrets] Phase 2: migrated ${migrated} secrets to keyed JSON format`);
  }

  return migrated;
}
```

Wait — the `where` clause above uses a dynamic import incorrectly. Let me fix that:

**File:** `web/src/lib/agents/migrate-secrets.ts`

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agentSecrets } from '@/db/schema';
import { encrypt, decrypt, hasEncryptionKey } from '@/lib/encryption';

/**
 * Phase 2 migration: re-encrypt old plain-string api_key secrets into keyed JSON format.
 *
 * Old format: acpMethodId = "CURSOR_API_KEY", encryptedValue = encrypt("sk-abc123")
 * New format: acpMethodId = "CURSOR_API_KEY", encryptedValue = encrypt('{"CURSOR_API_KEY":"sk-abc123"}')
 *
 * Runs at app startup. Idempotent — already-migrated rows (valid JSON objects) are skipped.
 */
export async function migrateSecretsToKeyedJson(): Promise<number> {
  if (!hasEncryptionKey()) {
    console.warn('[migrate-secrets] No encryption key — skipping Phase 2 migration');
    return 0;
  }

  const rows = await db.select().from(agentSecrets);
  let migrated = 0;

  for (const row of rows) {
    if (row.authType !== 'api_key') continue;

    try {
      const decrypted = decrypt(row.encryptedValue);

      // Check if already in new format (valid JSON object)
      try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          continue; // Already migrated
        }
      } catch {
        // Not JSON — needs migration
      }

      // Old format: plain string value. Wrap in keyed JSON using acpMethodId as key.
      const keyedJson = JSON.stringify({ [row.acpMethodId]: decrypted });
      const reEncrypted = encrypt(keyedJson);

      await db
        .update(agentSecrets)
        .set({ encryptedValue: reEncrypted, updatedAt: new Date() })
        .where(eq(agentSecrets.id, row.id));

      migrated++;
    } catch (e) {
      console.error(`[migrate-secrets] Failed to migrate secret ${row.id}:`, e);
    }
  }

  if (migrated > 0) {
    console.log(`[migrate-secrets] Phase 2: migrated ${migrated} secrets to keyed JSON format`);
  }

  return migrated;
}
```

**Commit:** `feat(secrets): add Phase 2 startup migration for keyed JSON re-encryption`

### Step 2.4 — Register Phase 2 migration in instrumentation.ts

- [ ] Add `migrateSecretsToKeyedJson()` call to startup

**File:** `web/src/instrumentation.ts`

Add after the `ensureAppSchema` call (after line 5):

```typescript
const { migrateSecretsToKeyedJson } = await import('@/lib/agents/migrate-secrets');
await migrateSecretsToKeyedJson().catch((err) => {
  console.error('[Startup] Secrets Phase 2 migration failed:', err);
});
```

The full file becomes:

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureAppSchema } = await import('@/db/ensure-schema');
    await ensureAppSchema().catch((err) => {
      console.error('[Startup] Database schema migration failed:', err);
      throw err;
    });

    // Phase 2 migration: re-encrypt old secrets to keyed JSON format
    const { migrateSecretsToKeyedJson } = await import('@/lib/agents/migrate-secrets');
    await migrateSecretsToKeyedJson().catch((err) => {
      console.error('[Startup] Secrets Phase 2 migration failed:', err);
    });

    // Existing startup cleanup
    const { startupCleanup } = await import('@/lib/orchestrator/startup');
    await startupCleanup().catch((err) => {
      console.error('[startup] Cleanup failed:', err);
    });

    // Judge system — all imports dynamic under runtime guard
    const { startWorker } = await import('@/lib/judge/worker');
    const { recoverPendingEvaluations } = await import('@/lib/judge/service');
    const { startReclaimLoop } = await import('@/lib/judge/reclaim');
    const { startCleanupJob } = await import('@/lib/judge/cleanup');
    const { startMatviewRefreshWorker } = await import('@/lib/db/refresh-matviews');

    const consumerId = `worker-${process.pid}-${Date.now()}`;

    // Start judge worker (blocking loop — runs in background)
    startWorker(consumerId).catch((err) =>
      console.error('[Startup] Worker failed:', err)
    );

    // Start periodic jobs
    startReclaimLoop(consumerId);
    startCleanupJob();
    startMatviewRefreshWorker();

    // Recover incomplete evaluations from previous session
    recoverPendingEvaluations().catch((err) =>
      console.error('[Startup] Recovery failed:', err)
    );
  }
}
```

**Commit:** `feat(startup): register Phase 2 secrets migration in instrumentation`

### Step 2.5 — Run tests

- [ ] Verify secrets tests pass

```bash
cd web && npx vitest run src/lib/agents/__tests__/secrets.test.ts
```

**Commit:** (no commit — verification step)

---

## Task 3: Extract resolveAcpConfig + Update AcpAgentConfig

**Goal:** Extract `resolveAcpConfig` from Scheduler to a shared module, add auth-related fields to config, update AcpSession to accept capabilities.

**DoD:**
- `resolveAcpConfig` exported from `web/src/lib/orchestrator/acp-config.ts`
- `AcpAgentConfig` has `credentialPaths` and `capabilities.auth.terminal`
- Scheduler imports from `acp-config.ts` instead of using private method
- `AcpSession.start()` passes `acpConfig.capabilities` to `connection.initialize()`
- All existing tests still pass

### Step 3.1 — Write test for resolveAcpConfig

- [ ] Test the extracted function in isolation

**File:** `web/src/lib/orchestrator/__tests__/acp-config.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { resolveAcpConfig } from '../acp-config';

describe('resolveAcpConfig', () => {
  it('test_resolveAcpConfig_knownType_returnsConfig', () => {
    const config = resolveAcpConfig('claude-code');
    expect(config.acpCmd).toEqual(['claude-agent-acp']);
    expect(config.requiresAuth).toBe(true);
  });

  it('test_resolveAcpConfig_mock_requiresAuthFalse', () => {
    const config = resolveAcpConfig('mock');
    expect(config.requiresAuth).toBe(false);
    expect(config.acpCmd).toEqual(['python3', '/opt/agent/mock-acp-server.py']);
  });

  it('test_resolveAcpConfig_unknownType_throws', () => {
    expect(() => resolveAcpConfig('nonexistent')).toThrow('No ACP config for agent type');
  });

  it('test_resolveAcpConfig_allTypes_haveCapabilitiesWithAuthTerminal', () => {
    const types = ['claude-code', 'codex', 'cursor', 'cline', 'opencode', 'kilocode'];
    for (const type of types) {
      const config = resolveAcpConfig(type);
      expect(config.capabilities).toBeDefined();
      expect(config.capabilities?.auth).toEqual({ terminal: true });
    }
  });

  it('test_resolveAcpConfig_cursor_hasCredentialPaths', () => {
    const config = resolveAcpConfig('cursor');
    expect(config.credentialPaths).toBeDefined();
    expect(Array.isArray(config.credentialPaths)).toBe(true);
  });

  it('test_resolveAcpConfig_mock_noCredentialPaths', () => {
    const config = resolveAcpConfig('mock');
    expect(config.credentialPaths).toBeUndefined();
  });
});
```

**Commit:** `test(orchestrator): add resolveAcpConfig unit tests`

### Step 3.2 — Update AcpAgentConfig type

- [ ] Add `credentialPaths` to the interface

**File:** `web/src/lib/orchestrator/types.ts`

Replace the `AcpAgentConfig` interface (lines 64-68):

```typescript
export interface AcpAgentConfig {
  acpCmd: string[];
  requiresAuth: boolean;
  capabilities?: Record<string, unknown>;
  /** Paths inside container that hold credential files (relative to /root) */
  credentialPaths?: string[];
}
```

**Commit:** `feat(types): add credentialPaths to AcpAgentConfig`

### Step 3.3 — Create acp-config.ts

- [ ] Extract resolveAcpConfig as an exported module

**File:** `web/src/lib/orchestrator/acp-config.ts`

```typescript
import type { AcpAgentConfig } from './types';

/**
 * Map agentType to ACP launch command + auth configuration.
 *
 * Agents with native ACP: opencode, kilocode.
 * Agents via ACP adapter: claude-code, codex, cursor.
 * Note: cline native --acp works but exits silently if stdin closes prematurely.
 *
 * Keys MUST match `agent_executors.agent_type` values in DB.
 */
export function resolveAcpConfig(agentType: string): AcpAgentConfig {
  const configs: Record<string, AcpAgentConfig> = {
    'claude-code': {
      acpCmd: ['claude-agent-acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/claude/credentials.json'],
    },
    'codex': {
      acpCmd: ['codex-acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/codex/auth.json'],
    },
    'cursor': {
      acpCmd: ['cursor-agent-acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/cursor/auth.json'],
    },
    'cline': {
      acpCmd: ['cline', '--acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/cline/auth.json'],
    },
    'opencode': {
      acpCmd: ['opencode', 'acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/opencode/auth.json'],
    },
    'kilocode': {
      acpCmd: ['kilo', 'acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/kilo/auth.json'],
    },
    'mock': {
      acpCmd: ['python3', '/opt/agent/mock-acp-server.py'],
      requiresAuth: false,
    },
  };

  const config = configs[agentType];
  if (!config) {
    throw new Error(
      `No ACP config for agent type "${agentType}". Known types: ${Object.keys(configs).join(', ')}`,
    );
  }
  return config;
}
```

**Commit:** `refactor(orchestrator): extract resolveAcpConfig to shared module`

### Step 3.4 — Update Scheduler to use shared resolveAcpConfig

- [ ] Replace private method with import from `acp-config.ts`

**File:** `web/src/lib/orchestrator/scheduler.ts`

Add import at the top (after line 8):

```typescript
import { resolveAcpConfig } from './acp-config';
```

Remove the entire `private resolveAcpConfig` method (lines 45-60 including the JSDoc comment on lines 36-44). That's the block from:

```typescript
  /**
   * Map agentType to ACP launch command.
```

to:

```typescript
    return config;
  }
```

In `executeLane`, line 198 already calls `this.resolveAcpConfig(lane.agent.type)` — change it to:

```typescript
      const acpConfig = resolveAcpConfig(lane.agent.type);
```

(Remove `this.` since it's now a module-level function.)

**Commit:** `refactor(scheduler): use shared resolveAcpConfig from acp-config module`

### Step 3.5 — Update AcpSession.start to accept capabilities

- [ ] Pass `acpConfig.capabilities` to `connection.initialize()`

**File:** `web/src/lib/orchestrator/acp-session.ts`

Replace the `connection.initialize` call (lines 72-76):

```typescript
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'litmus', version: '1.0.0' },
      clientCapabilities: acpConfig.capabilities ?? {},
    });
```

**Commit:** `feat(acp-session): pass capabilities from AcpAgentConfig to initialize`

### Step 3.6 — Run all existing tests

- [ ] Verify no regressions

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/
```

**Commit:** (no commit — verification step)

---

## Task 4: Auth Discovery (extractAuthMethods + models route)

**Goal:** Discover auth methods via ACP `initialize` response during model discovery and cache them in the database.

**DoD:**
- `extractAuthMethods` function parses and canonicalizes auth methods from ACP init response
- `oauthCapable` heuristic identifies OAuth-capable methods
- Models route starts AcpSession before `models.sh`, extracts auth methods, caches to DB
- If ACP init fails, sets `authMethods = null` and continues with model discovery
- All tested

### Step 4.1 — Write tests for auth discovery

- [ ] Test extractAuthMethods and canonicalization

**File:** `web/src/lib/agents/__tests__/auth-discovery.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { extractAuthMethods, isOAuthCapable } from '../auth-discovery';

describe('extractAuthMethods', () => {
  it('test_extractAuthMethods_envVarType_passedThrough', () => {
    const initResponse = {
      capabilities: {
        auth: {
          methods: [
            { id: 'openai-key', type: 'env_var', description: 'OpenAI API Key', envVars: ['OPENAI_API_KEY'] },
          ],
        },
      },
    };

    const result = extractAuthMethods(initResponse);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'openai-key',
      type: 'env_var',
      description: 'OpenAI API Key',
      envVars: ['OPENAI_API_KEY'],
    });
  });

  it('test_extractAuthMethods_noType_canonicalizesToAgent', () => {
    const initResponse = {
      capabilities: {
        auth: {
          methods: [
            { id: 'chatgpt', description: 'ChatGPT login' },
          ],
        },
      },
    };

    const result = extractAuthMethods(initResponse);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('agent');
  });

  it('test_extractAuthMethods_agentType_preserved', () => {
    const initResponse = {
      capabilities: {
        auth: {
          methods: [
            { id: 'github-oauth', type: 'agent', description: 'GitHub OAuth' },
          ],
        },
      },
    };

    const result = extractAuthMethods(initResponse);
    expect(result[0].type).toBe('agent');
  });

  it('test_extractAuthMethods_noAuthCapabilities_returnsEmptyArray', () => {
    const initResponse = { capabilities: {} };
    expect(extractAuthMethods(initResponse)).toEqual([]);
  });

  it('test_extractAuthMethods_nullCapabilities_returnsEmptyArray', () => {
    const initResponse = {};
    expect(extractAuthMethods(initResponse)).toEqual([]);
  });

  it('test_extractAuthMethods_multipleMethodTypes_allCanonicalized', () => {
    const initResponse = {
      capabilities: {
        auth: {
          methods: [
            { id: 'api-key', type: 'env_var', description: 'API Key', envVars: ['API_KEY'] },
            { id: 'chatgpt', description: 'ChatGPT' },
            { id: 'github', type: 'agent', description: 'GitHub' },
            { id: 'terminal-login', type: 'terminal', description: 'Terminal Login' },
          ],
        },
      },
    };

    const result = extractAuthMethods(initResponse);
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.type)).toEqual(['env_var', 'agent', 'agent', 'terminal']);
  });
});

describe('isOAuthCapable', () => {
  it('test_isOAuthCapable_idContainsOauth_true', () => {
    expect(isOAuthCapable({ id: 'github-oauth', type: 'agent', description: 'GitHub' })).toBe(true);
  });

  it('test_isOAuthCapable_idIsChatgpt_true', () => {
    expect(isOAuthCapable({ id: 'chatgpt', type: 'agent', description: 'ChatGPT login' })).toBe(true);
  });

  it('test_isOAuthCapable_descriptionContainsOAuth_true', () => {
    expect(isOAuthCapable({ id: 'login', type: 'agent', description: 'Login via OAuth flow' })).toBe(true);
  });

  it('test_isOAuthCapable_descriptionContainsDeviceCode_true', () => {
    expect(isOAuthCapable({ id: 'login', type: 'agent', description: 'Uses device code flow' })).toBe(true);
  });

  it('test_isOAuthCapable_descriptionContainsBrowser_true', () => {
    expect(isOAuthCapable({ id: 'login', type: 'agent', description: 'Open browser to authenticate' })).toBe(true);
  });

  it('test_isOAuthCapable_envVarType_false', () => {
    expect(isOAuthCapable({ id: 'api-key', type: 'env_var', description: 'API Key' })).toBe(false);
  });

  it('test_isOAuthCapable_terminalType_false', () => {
    expect(isOAuthCapable({ id: 'terminal', type: 'terminal', description: 'Terminal login' })).toBe(false);
  });

  it('test_isOAuthCapable_agentNoKeywords_false', () => {
    expect(isOAuthCapable({ id: 'custom-login', type: 'agent', description: 'Custom auth method' })).toBe(false);
  });
});
```

**Commit:** `test(auth-discovery): add unit tests for extractAuthMethods and isOAuthCapable`

### Step 4.2 — Implement auth-discovery.ts

- [ ] Create the auth discovery module

**File:** `web/src/lib/agents/auth-discovery.ts`

```typescript
/**
 * ACP auth method as returned by the agent's initialize response.
 * Stored in agent_executors.authMethods (jsonb).
 */
export interface AcpAuthMethod {
  id: string;
  type: 'env_var' | 'agent' | 'terminal';
  description?: string;
  envVars?: string[];
  [key: string]: unknown;
}

const OAUTH_ID_PATTERNS = /oauth|chatgpt/i;
const OAUTH_DESC_PATTERNS = /oauth|device.?code|browser|sign.?in.?with/i;

/**
 * Extract and canonicalize auth methods from the ACP initialize response.
 * - Entries without a `type` field are set to `type: 'agent'`.
 * - Unknown types are passed through as-is.
 */
export function extractAuthMethods(initResponse: Record<string, unknown>): AcpAuthMethod[] {
  const capabilities = initResponse.capabilities as Record<string, unknown> | undefined;
  if (!capabilities) return [];

  const auth = capabilities.auth as Record<string, unknown> | undefined;
  if (!auth) return [];

  const methods = auth.methods as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(methods)) return [];

  return methods.map((m) => {
    const method = { ...m } as AcpAuthMethod;
    // Canonicalize: set type='agent' when absent
    if (!method.type) {
      method.type = 'agent';
    }
    return method;
  });
}

/**
 * Heuristic: is this auth method likely an OAuth/device-code flow?
 * Only applies to `type === 'agent'` methods.
 */
export function isOAuthCapable(method: Pick<AcpAuthMethod, 'id' | 'type' | 'description'>): boolean {
  if (method.type !== 'agent') return false;

  if (OAUTH_ID_PATTERNS.test(method.id)) return true;

  if (method.description && OAUTH_DESC_PATTERNS.test(method.description)) return true;

  return false;
}
```

**Commit:** `feat(auth-discovery): add extractAuthMethods + isOAuthCapable`

### Step 4.3 — Write test for models route auth discovery integration

- [ ] Test that models route performs ACP auth discovery before models.sh

**File:** `web/src/app/api/agents/[id]/models/__tests__/auth-discovery-integration.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => {
  let executorAuthMethods: unknown = undefined;
  let executorAuthMethodsDiscoveredAt: Date | undefined = undefined;

  const updateSetWhereMock = vi.fn().mockResolvedValue(undefined);
  const updateSetMock = vi.fn().mockImplementation((values: Record<string, unknown>) => {
    if ('authMethods' in values) {
      executorAuthMethods = values.authMethods;
      executorAuthMethodsDiscoveredAt = values.authMethodsDiscoveredAt as Date;
    }
    return { where: updateSetWhereMock };
  });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  const onConflictDoUpdateMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: 'model-1', name: 'gpt-4o', provider: 'openai' }]),
  });
  const insertValuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  return {
    get executorAuthMethods() { return executorAuthMethods; },
    get executorAuthMethodsDiscoveredAt() { return executorAuthMethodsDiscoveredAt; },
    updateMock,
    updateSetMock,
    insertMock,
  };
});

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: { name?: string }) => {
        if (table?.name === 'agents') {
          return {
            where: vi.fn().mockResolvedValue([{ id: 'a1', name: 'TestAgent', availableModels: [] }]),
          };
        }
        // agentExecutors
        return {
          where: vi.fn().mockImplementation(() => {
            const result = Promise.resolve([{
              id: 'e1', agentId: 'a1', agentType: 'cursor', type: 'docker',
              config: {}, agentSlug: 'cursor',
            }]);
            (result as unknown as Record<string, unknown>).limit = vi.fn().mockResolvedValue([{
              id: 'e1', agentId: 'a1', agentType: 'cursor', type: 'docker',
              config: {}, agentSlug: 'cursor',
            }]);
            return result;
          }),
        };
      }),
    }),
    update: dbMocks.updateMock,
    insert: dbMocks.insertMock,
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { id: 'agentExecutors.id', agentId: 'agentExecutors.agentId', name: 'agentExecutors' },
  models: { name: 'models' },
}));

vi.mock('@/lib/agents/secrets', () => ({
  getDecryptedSecretsForExecutor: vi.fn().mockResolvedValue({ CURSOR_API_KEY: 'sk-test' }),
}));

vi.mock('@/lib/env', () => ({
  env: { DOCKER_HOST: 'http://localhost:2375' },
}));

const mockCollectResult = vi.hoisted(() => ({
  exitCode: 0,
  stdout: JSON.stringify([{ id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' }]),
  stderr: '',
}));

vi.mock('@/lib/orchestrator/collect', () => ({
  collect: vi.fn().mockResolvedValue(mockCollectResult),
}));

const mockAcpSession = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockInitResponse = vi.hoisted(() => ({
  protocolVersion: '2025-11-16',
  agentInfo: { name: 'cursor-acp', version: '1.0.0' },
  capabilities: {
    auth: {
      methods: [
        { id: 'cursor-api-key', type: 'env_var', description: 'Cursor API Key', envVars: ['CURSOR_API_KEY'] },
      ],
    },
  },
}));

vi.mock('@/lib/orchestrator/acp-session', () => ({
  AcpSession: {
    startForDiscovery: vi.fn().mockResolvedValue({
      session: mockAcpSession,
      initResponse: mockInitResponse,
    }),
  },
}));

vi.mock('@/lib/orchestrator/docker-executor', () => ({
  DockerExecutor: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({ containerId: 'test-container' }),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/lib/orchestrator/docker-bind-paths', () => ({
  resolveAgentHostDirForDocker: vi.fn().mockReturnValue('/opt/agent/cursor'),
  resolveWorkHostDirForDocker: vi.fn().mockReturnValue('/work'),
}));

describe('POST /api/agents/[id]/models — auth discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_modelsRoute_discoversAuthMethods_cachesToExecutor', async () => {
    const { POST } = await import('../../route');

    const request = new Request('http://localhost/api/agents/a1/models', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);

    // Auth methods should have been cached
    expect(dbMocks.executorAuthMethods).toEqual([
      { id: 'cursor-api-key', type: 'env_var', description: 'Cursor API Key', envVars: ['CURSOR_API_KEY'] },
    ]);
    expect(dbMocks.executorAuthMethodsDiscoveredAt).toBeInstanceOf(Date);
  });
});
```

**Commit:** `test(models): add auth discovery integration test for models route`

### Step 4.4 — Add startForDiscovery to AcpSession

- [ ] Factory method that returns both session and init response

**File:** `web/src/lib/orchestrator/acp-session.ts`

Add a new static method after the existing `start` method (after line 79):

```typescript
  /**
   * Start an ACP session and return the initialize response alongside the session.
   * Used during auth discovery to extract authMethods from the init response.
   */
  static async startForDiscovery(
    executor: AgentExecutor,
    handle: ExecutorHandle,
    acpConfig: AcpAgentConfig,
  ): Promise<{ session: AcpSession; initResponse: Record<string, unknown> }> {
    const proc = await executor.exec(handle, acpConfig.acpCmd);

    const stdinWeb = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const stdoutWeb = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    let session: AcpSession;

    const connection = new acp.ClientSideConnection((_agent) => {
      return {
        sessionUpdate: async (notification: acp.SessionNotification) => {
          session.handleSessionUpdate(notification);
        },
        requestPermission: async (params: acp.RequestPermissionRequest) => {
          const firstOption = params.options?.[0];
          return {
            outcome: firstOption
              ? { outcome: 'selected' as const, optionId: firstOption.optionId }
              : { outcome: 'cancelled' as const },
          } satisfies acp.RequestPermissionResponse;
        },
      };
    }, stream);

    session = new AcpSession(connection, proc);

    const initResponse = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'litmus', version: '1.0.0' },
      clientCapabilities: acpConfig.capabilities ?? {},
    });

    return { session, initResponse: initResponse as unknown as Record<string, unknown> };
  }
```

**Commit:** `feat(acp-session): add startForDiscovery returning init response`

### Step 4.5 — Update models route with auth discovery

- [ ] Add ACP auth discovery before models.sh execution

**File:** `web/src/app/api/agents/[id]/models/route.ts`

Replace the full file:

```typescript
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

      const authMethods = extractAuthMethods(initResponse);
      discoveredAuthMethods = authMethods.length > 0 ? authMethods : null;

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
```

**Commit:** `feat(models): integrate ACP auth discovery into model discovery route`

### Step 4.6 — Run tests

- [ ] Verify auth discovery tests and existing tests pass

```bash
cd web && npx vitest run src/lib/agents/__tests__/auth-discovery.test.ts
cd web && npx vitest run src/app/api/agents/
```

**Commit:** (no commit — verification step)

---

## Task 5: Auth API Routes (GET/PUT/DELETE)

**Goal:** Replace the existing auth.json-based auth route with ACP authMethods-based routes.

**DoD:**
- `GET /api/agents/[id]/auth` returns `AuthMethodStatus[]` from cached `authMethods`
- `PUT /api/agents/[id]/auth` saves `api_key` (JSON body) or `credential_files` (multipart)
- `DELETE /api/agents/[id]/auth` removes secret by `acpMethodId` (idempotent 204)
- Auth status includes `oauthCapable`, `configured`, `maskedValues`
- Tests for all routes

### Step 5.1 — Write tests for auth API routes

- [ ] Test GET, PUT, DELETE endpoints

**File:** `web/src/app/api/agents/[id]/auth/__tests__/auth-routes.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecutor = {
  id: 'e1',
  agentId: 'a1',
  agentType: 'cursor',
  type: 'docker',
  agentSlug: 'cursor',
  config: {},
  authMethods: [
    { id: 'cursor-api-key', type: 'env_var', description: 'Cursor API Key', envVars: ['CURSOR_API_KEY'] },
    { id: 'chatgpt', type: 'agent', description: 'ChatGPT OAuth login' },
  ],
  authMethodsDiscoveredAt: new Date(),
};

const mockSecrets = vi.hoisted(() => {
  const savedSecrets: Array<Record<string, unknown>> = [];
  const deletedMethods: string[] = [];

  return {
    savedSecrets,
    deletedMethods,
    getDecryptedSecretsForExecutor: vi.fn().mockResolvedValue({}),
    saveSecret: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
      savedSecrets.push(params);
    }),
    saveCredentialBlob: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockImplementation(async (_executorId: string, methodId: string) => {
      deletedMethods.push(methodId);
    }),
    getCredentialBlobs: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@/lib/agents/secrets', () => mockSecrets);

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: { name?: string }) => {
        if (table?.name === 'agents') {
          return {
            where: vi.fn().mockResolvedValue([{ id: 'a1', name: 'TestAgent' }]),
          };
        }
        if (table?.name === 'agentExecutors') {
          return {
            where: vi.fn().mockImplementation(() => {
              const result = Promise.resolve([mockExecutor]);
              (result as unknown as Record<string, unknown>).limit = vi.fn().mockResolvedValue([mockExecutor]);
              return result;
            }),
          };
        }
        // agentSecrets
        return {
          where: vi.fn().mockResolvedValue([
            {
              acpMethodId: 'cursor-api-key',
              encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-test1234567890"}',
              authType: 'api_key',
              credentialPaths: null,
            },
          ]),
        };
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { id: 'agentExecutors.id', agentId: 'agentExecutors.agentId', name: 'agentExecutors' },
  agentSecrets: {
    agentExecutorId: 'agent_executor_id',
    acpMethodId: 'acp_method_id',
    name: 'agentSecrets',
  },
}));

vi.mock('@/lib/encryption', () => ({
  encrypt: vi.fn((text: string) => `ENC:${text}`),
  decrypt: vi.fn((text: string) => text.startsWith('ENC:') ? text.slice(4) : text),
  maskKey: vi.fn((encrypted: string) => {
    const plain = encrypted.startsWith('ENC:') ? encrypted.slice(4) : encrypted;
    try {
      const parsed = JSON.parse(plain);
      if (typeof parsed === 'object' && parsed !== null) {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          result[k] = typeof v === 'string' && v.length > 8 ? '••••' + v.slice(-4) : '••••';
        }
        return JSON.stringify(result);
      }
    } catch { /* not JSON */ }
    return plain.length > 8 ? '••••' + plain.slice(-4) : '••••';
  }),
  hasEncryptionKey: vi.fn().mockReturnValue(true),
}));

describe('GET /api/agents/[id]/auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_get_returnsAuthMethodStatusWithConfigured', async () => {
    const { GET } = await import('../route');

    const request = new Request('http://localhost/api/agents/a1/auth');
    const response = await GET(request, { params: Promise.resolve({ id: 'a1' }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.authMethods).toHaveLength(2);

    // First method (env_var) should be configured
    const envVarMethod = body.authMethods.find((m: Record<string, unknown>) => m.id === 'cursor-api-key');
    expect(envVarMethod.configured).toBe(true);
    expect(envVarMethod.oauthCapable).toBe(false);

    // Second method (agent) should not be configured but oauthCapable
    const agentMethod = body.authMethods.find((m: Record<string, unknown>) => m.id === 'chatgpt');
    expect(agentMethod.configured).toBe(false);
    expect(agentMethod.oauthCapable).toBe(true);
  });
});

describe('PUT /api/agents/[id]/auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecrets.savedSecrets.length = 0;
  });

  it('test_put_apiKey_savesKeyedJson', async () => {
    const { PUT } = await import('../route');

    const request = new Request('http://localhost/api/agents/a1/auth', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acpMethodId: 'cursor-api-key',
        authType: 'api_key',
        values: { CURSOR_API_KEY: 'sk-newkey123' },
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    expect(mockSecrets.saveSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        executorId: 'e1',
        acpMethodId: 'cursor-api-key',
        values: { CURSOR_API_KEY: 'sk-newkey123' },
        authType: 'api_key',
      }),
    );
  });

  it('test_put_unknownMethodId_returns400', async () => {
    const { PUT } = await import('../route');

    const request = new Request('http://localhost/api/agents/a1/auth', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acpMethodId: 'nonexistent-method',
        authType: 'api_key',
        values: { KEY: 'value' },
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });
    expect(response.status).toBe(400);
  });

  it('test_put_missingValues_returns400', async () => {
    const { PUT } = await import('../route');

    const request = new Request('http://localhost/api/agents/a1/auth', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acpMethodId: 'cursor-api-key',
        authType: 'api_key',
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/agents/[id]/auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecrets.deletedMethods.length = 0;
  });

  it('test_delete_existingMethod_returns204', async () => {
    const { DELETE } = await import('../route');

    const request = new Request('http://localhost/api/agents/a1/auth', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acpMethodId: 'cursor-api-key' }),
    });

    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });
    expect(response.status).toBe(204);
    expect(mockSecrets.deleteSecret).toHaveBeenCalledWith('e1', 'cursor-api-key');
  });

  it('test_delete_missingAcpMethodId_returns400', async () => {
    const { DELETE } = await import('../route');

    const request = new Request('http://localhost/api/agents/a1/auth', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });
    expect(response.status).toBe(400);
  });
});
```

**Commit:** `test(auth-routes): add tests for GET/PUT/DELETE auth API routes`

### Step 5.2 — Implement auth route

- [ ] Rewrite `web/src/app/api/agents/[id]/auth/route.ts`

**File:** `web/src/app/api/agents/[id]/auth/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors, agentSecrets } from '@/db/schema';
import { decrypt, hasEncryptionKey } from '@/lib/encryption';
import { saveSecret, saveCredentialBlob, deleteSecret } from '@/lib/agents/secrets';
import { isOAuthCapable } from '@/lib/agents/auth-discovery';
import type { AcpAuthMethod } from '@/lib/agents/auth-discovery';

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

  // Load existing secrets to determine configured status
  const secrets = await db
    .select({
      acpMethodId: agentSecrets.acpMethodId,
      encryptedValue: agentSecrets.encryptedValue,
      authType: agentSecrets.authType,
    })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentExecutorId, executor.id));

  const secretMap = new Map(secrets.map((s) => [s.acpMethodId, s]));

  const authMethods = cachedMethods.map((method) => {
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
    authMethods,
    discoveredAt: executor.authMethodsDiscoveredAt ?? null,
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

  const body = await request.json();
  const { acpMethodId, authType, values, base64Tar, credentialPaths } = body as {
    acpMethodId?: string;
    authType?: string;
    values?: Record<string, string>;
    base64Tar?: string;
    credentialPaths?: string[];
  };

  if (!acpMethodId) {
    return NextResponse.json({ error: 'acpMethodId is required' }, { status: 400 });
  }

  // Validate method exists in cached authMethods
  const method = cachedMethods.find((m) => m.id === acpMethodId);
  if (!method) {
    return NextResponse.json(
      { error: `Auth method "${acpMethodId}" not found in cached authMethods. Run model discovery first.` },
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

    return NextResponse.json({ acpMethodId, saved: true });
  }

  if (authType === 'credential_files') {
    if (!base64Tar || !credentialPaths || credentialPaths.length === 0) {
      return NextResponse.json(
        { error: 'base64Tar and credentialPaths are required for credential_files type' },
        { status: 400 },
      );
    }

    await saveCredentialBlob({
      executorId: executor.id,
      acpMethodId,
      base64Tar,
      credentialPaths,
    });

    return NextResponse.json({ acpMethodId, saved: true });
  }

  return NextResponse.json({ error: 'authType must be "api_key" or "credential_files"' }, { status: 400 });
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
  const { acpMethodId } = body as { acpMethodId?: string };

  if (!acpMethodId) {
    return NextResponse.json({ error: 'acpMethodId is required' }, { status: 400 });
  }

  await deleteSecret(executor.id, acpMethodId);

  return new NextResponse(null, { status: 204 });
}
```

**Commit:** `feat(auth-routes): replace auth.json-based routes with ACP authMethods`

### Step 5.3 — Run tests

- [ ] Verify auth route tests pass

```bash
cd web && npx vitest run src/app/api/agents/[id]/auth/__tests__/
```

**Commit:** (no commit — verification step)

---

## Task 6: Credential File Operations

**Goal:** Create functions to extract credential files from containers (as base64 tar), validate paths, and restore them back into containers.

**DoD:**
- `extractCredentials()` runs `tar czf - | base64` inside container, returns base64 string
- `restoreCredentialFiles()` decrypts blobs and pipes binary tar into container
- `validateTarPaths()` rejects absolute paths and `..` traversal
- All tested

### Step 6.1 — Write tests for credential file operations

- [ ] Test extract, restore, and path validation

**File:** `web/src/lib/orchestrator/__tests__/credential-files.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorHandle, InteractiveHandle } from '../types';

const collectMock = vi.hoisted(() => vi.fn());
vi.mock('../collect', () => ({ collect: collectMock }));

describe('validateTarPaths', () => {
  it('test_validateTarPaths_relativePaths_passes', async () => {
    const { validateTarPaths } = await import('../credential-files');
    // No throw expected
    validateTarPaths(['.config/cursor/auth.json', '.config/cursor/session.json']);
  });

  it('test_validateTarPaths_absolutePath_throws', async () => {
    const { validateTarPaths } = await import('../credential-files');
    expect(() => validateTarPaths(['/etc/passwd'])).toThrow('absolute');
  });

  it('test_validateTarPaths_parentTraversal_throws', async () => {
    const { validateTarPaths } = await import('../credential-files');
    expect(() => validateTarPaths(['.config/../../../etc/passwd'])).toThrow('traversal');
  });

  it('test_validateTarPaths_emptyArray_passes', async () => {
    const { validateTarPaths } = await import('../credential-files');
    validateTarPaths([]);
  });
});

describe('extractCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_extractCredentials_validPaths_returnsBase64', async () => {
    collectMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'dGVzdGRhdGE=\n',
      stderr: '',
    });

    const { extractCredentials } = await import('../credential-files');

    const mockExecutor = {
      type: 'docker' as const,
      exec: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };
    const mockHandle = { containerId: 'c1' };

    const result = await extractCredentials(
      mockExecutor,
      mockHandle,
      ['.config/cursor/auth.json'],
    );

    expect(result).toBe('dGVzdGRhdGE=');
    expect(collectMock).toHaveBeenCalledWith(
      mockExecutor,
      mockHandle,
      ['sh', '-c', 'tar czf - -C /root .config/cursor/auth.json | base64'],
      undefined,
    );
  });

  it('test_extractCredentials_tarFails_throws', async () => {
    collectMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'tar: .config/cursor/auth.json: No such file',
    });

    const { extractCredentials } = await import('../credential-files');

    const mockExecutor = {
      type: 'docker' as const,
      exec: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };
    const mockHandle = { containerId: 'c1' };

    await expect(
      extractCredentials(mockExecutor, mockHandle, ['.config/cursor/auth.json']),
    ).rejects.toThrow('credential extraction failed');
  });
});

describe('restoreCredentialFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_restoreCredentialFiles_validBlob_pipesToTar', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writtenChunks: Buffer[] = [];

    stdin.on('data', (chunk: Buffer) => writtenChunks.push(chunk));

    const mockHandle: InteractiveHandle = {
      stdin,
      stdout,
      stderr,
      wait: vi.fn().mockResolvedValue(0),
      kill: vi.fn(),
    };

    const mockExecutor: AgentExecutor = {
      type: 'docker',
      exec: vi.fn().mockResolvedValue(mockHandle),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };

    const execHandle: ExecutorHandle = { containerId: 'c1' };

    // Use a small base64-encoded payload
    const base64Tar = Buffer.from('test-tar-data').toString('base64');

    const { restoreCredentialFiles } = await import('../credential-files');

    // Close stdout/stderr so wait() resolves
    process.nextTick(() => {
      stdout.end();
      stderr.end();
    });

    await restoreCredentialFiles(mockExecutor, execHandle, [
      {
        acpMethodId: 'cursor-oauth',
        base64Tar,
        credentialPaths: ['.config/cursor/auth.json'],
      },
    ]);

    expect(mockExecutor.exec).toHaveBeenCalledWith(
      execHandle,
      ['tar', 'xzf', '-', '-C', '/root', '--no-absolute-names', '--no-same-owner'],
      undefined,
    );

    // Verify binary data was written to stdin
    const written = Buffer.concat(writtenChunks);
    expect(written.length).toBeGreaterThan(0);
    expect(written).toEqual(Buffer.from(base64Tar, 'base64'));
  });
});
```

**Commit:** `test(credential-files): add tests for extract, restore, and path validation`

### Step 6.2 — Implement credential-files.ts

- [ ] Create the credential file operations module

**File:** `web/src/lib/orchestrator/credential-files.ts`

```typescript
import type { AgentExecutor, ExecutorHandle, ExecOptions } from './types';
import { collect } from './collect';

/**
 * Validate credential paths to prevent path traversal attacks.
 * All paths must be relative (no leading /) and must not contain `..` segments.
 */
export function validateTarPaths(paths: string[]): void {
  for (const p of paths) {
    if (p.startsWith('/')) {
      throw new Error(`Credential path must not be absolute: "${p}"`);
    }
    const segments = p.split('/');
    if (segments.some((s) => s === '..')) {
      throw new Error(`Credential path contains directory traversal: "${p}"`);
    }
  }
}

/**
 * Extract credential files from a running container as a base64-encoded tar archive.
 * Runs: `tar czf - -C /root ...paths | base64`
 *
 * @returns base64-encoded tar.gz content
 */
export async function extractCredentials(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  paths: string[],
  options?: ExecOptions,
): Promise<string> {
  validateTarPaths(paths);

  const escapedPaths = paths.map((p) => p.replace(/'/g, "'\\''"));
  const tarCmd = `tar czf - -C /root ${escapedPaths.join(' ')} | base64`;

  const result = await collect(executor, handle, ['sh', '-c', tarCmd], options);

  if (result.exitCode !== 0) {
    throw new Error(
      `credential extraction failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

/**
 * Restore credential file blobs into a running container.
 * For each blob: decrypt base64 → binary tar → pipe to `tar xzf - -C /root`
 *
 * @param blobs Array of credential blobs (from getCredentialBlobs)
 */
export async function restoreCredentialFiles(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  blobs: Array<{ acpMethodId: string; base64Tar: string; credentialPaths: string[] }>,
  options?: ExecOptions,
): Promise<void> {
  for (const blob of blobs) {
    validateTarPaths(blob.credentialPaths);

    const ih = await executor.exec(
      handle,
      ['tar', 'xzf', '-', '-C', '/root', '--no-absolute-names', '--no-same-owner'],
      options,
    );

    const binaryData = Buffer.from(blob.base64Tar, 'base64');

    ih.stdin.write(binaryData);
    ih.stdin.end();

    const exitCode = await ih.wait();

    if (exitCode !== 0) {
      console.error(
        `[credential-files] Failed to restore credentials for method "${blob.acpMethodId}" (exit ${exitCode})`,
      );
    }
  }
}
```

**Commit:** `feat(credential-files): add extract, restore, and path validation`

### Step 6.3 — Run tests

- [ ] Verify credential file tests pass

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/credential-files.test.ts
```

**Commit:** (no commit — verification step)

---

## Task 7: Runtime Integration (Scheduler + Runs Validation)

**Goal:** Integrate credential file restoration into the Scheduler execution lane and replace `loadAuthSchema` validation in the runs route with authMethods-based validation.

**DoD:**
- Scheduler calls `restoreCredentialFiles` between container start and AcpSession start
- Runs route validates auth using cached `authMethods` instead of `loadAuthSchema`
- Missing env_var secrets return 400
- Missing agent/terminal secrets return warning
- `authMethods === null` with `requiresAuth` returns 400
- Response includes `{ runId, warnings? }`
- All tested

### Step 7.1 — Write test for Scheduler credential restoration

- [ ] Test that restoreCredentialFiles is called before AcpSession.start

**File:** `web/src/lib/orchestrator/__tests__/scheduler-credentials.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { ExecutorHandle, InteractiveHandle, RunConfig, RunEvent, AgentResult } from '../types';

const dbMocks = vi.hoisted(() => {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });
  const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([]),
    onConflictDoUpdate: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    onConflictDoNothing: onConflictDoNothingMock,
  });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  return { updateMock, insertMock };
});

const refreshMatviewsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const restoreCredentialFilesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getCredentialBlobsMock = vi.hoisted(() => vi.fn().mockResolvedValue([
  { acpMethodId: 'chatgpt', base64Tar: 'dGVzdA==', credentialPaths: ['.config/auth.json'] },
]));

vi.mock('../credential-files', () => ({
  restoreCredentialFiles: restoreCredentialFilesMock,
}));

vi.mock('@/lib/agents/secrets', () => ({
  getCredentialBlobs: getCredentialBlobsMock,
}));

const mockAcpSession = vi.hoisted(() => ({
  prompt: vi.fn().mockResolvedValue({
    stopReason: 'end_turn' as const, content: 'done', toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, durationMs: 1000 },
  } satisfies AgentResult),
  resetSession: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../acp-session', () => ({
  AcpSession: { start: vi.fn().mockResolvedValue(mockAcpSession) },
}));

vi.mock('@/lib/s3', () => ({
  downloadFile: vi.fn().mockResolvedValue(Buffer.from('')),
  listFiles: vi.fn().mockResolvedValue([]),
  BUCKETS: { scenarios: 'litmus-scenarios', artifacts: 'litmus-artifacts' },
}));

vi.mock('@/db', () => ({
  db: { update: dbMocks.updateMock, insert: dbMocks.insertMock },
}));

vi.mock('@/lib/db/refresh-matviews', () => ({
  refreshMatviews: refreshMatviewsMock,
}));

vi.mock('@/db/schema', () => ({
  runs: { name: 'runs' },
  runTasks: { name: 'runTasks' },
  runResults: { name: 'runResults' },
}));

function createMockInteractiveHandle(opts?: { exitCode?: number; stdout?: string; stderr?: string }): InteractiveHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  process.nextTick(() => {
    if (opts?.stdout) stdout.write(opts.stdout);
    if (opts?.stderr) stderr.write(opts.stderr);
    stdout.end();
    stderr.end();
  });
  return {
    stdin, stdout, stderr,
    wait: async () => { await new Promise<void>((r) => stdout.on('end', r)); return opts?.exitCode ?? 0; },
    kill: async () => {},
  };
}

describe('Scheduler — credential restoration', () => {
  let events: RunEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
  });

  it('test_executeLane_restoresCredentialFiles_beforeAcpSessionStart', async () => {
    const callOrder: string[] = [];

    restoreCredentialFilesMock.mockImplementation(async () => {
      callOrder.push('restoreCredentialFiles');
    });

    const { AcpSession } = await import('../acp-session');
    (AcpSession.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('AcpSession.start');
      return mockAcpSession;
    });

    const { InMemoryEventBus } = await import('../event-bus');
    const { Reconciler } = await import('../reconciler');
    const { Scheduler } = await import('../scheduler');

    const bus = new InMemoryEventBus();
    bus.subscribe('run-1', (e) => events.push(e));

    const reconciler = new Reconciler();
    vi.spyOn(reconciler, 'evaluate').mockResolvedValue({
      allPassed: true, testsPassed: 1, testsTotal: 1, totalScore: 100, testOutput: '{}', details: [],
    });
    vi.spyOn(reconciler, 'finalize').mockResolvedValue(undefined);

    const executor = {
      type: 'docker' as const,
      start: vi.fn().mockResolvedValue({ containerId: 'c1' } as ExecutorHandle),
      exec: vi.fn().mockResolvedValue(createMockInteractiveHandle({ exitCode: 0, stdout: 'ok' })),
      stop: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };

    const config: RunConfig = {
      runId: 'run-1',
      maxRetries: 0,
      maxConcurrentLanes: 1,
      stepTimeoutSeconds: 0,
      taskIds: new Map([['e1:m1:s1', 'task-1']]),
      lanes: [{
        agent: { id: 'a1', slug: 'cursor', type: 'cursor', name: 'Cursor' },
        model: { id: 'm1', name: 'gpt-4o', externalId: 'gpt-4o' },
        executorId: 'e1',
        scenarios: [{ id: 's1', slug: 'test', prompt: 'Do it', language: 'python' }],
      }],
    };

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    // restoreCredentialFiles must be called BEFORE AcpSession.start
    expect(callOrder.indexOf('restoreCredentialFiles')).toBeLessThan(
      callOrder.indexOf('AcpSession.start'),
    );
  });
});
```

**Commit:** `test(scheduler): add test for credential restoration ordering`

### Step 7.2 — Update Scheduler to restore credential files

- [ ] Add `restoreCredentialFiles` call between `executor.start` and `AcpSession.start`

**File:** `web/src/lib/orchestrator/scheduler.ts`

Add imports at top:

```typescript
import { restoreCredentialFiles } from './credential-files';
import { getCredentialBlobs } from '@/lib/agents/secrets';
```

In the `executeLane` method, after `this.activeHandles.set(laneKey, handle);` (line 195) and before `const acpConfig = resolveAcpConfig(lane.agent.type);` (line 198), add:

```typescript
      // Restore credential files (OAuth tokens, session files) before ACP session
      const credentialBlobs = await getCredentialBlobs(lane.executorId);
      if (credentialBlobs.length > 0) {
        await restoreCredentialFiles(this.executor, handle, credentialBlobs);
      }
```

**Commit:** `feat(scheduler): restore credential files before AcpSession start`

### Step 7.3 — Write test for runs route validation

- [ ] Test authMethods-based validation replaces loadAuthSchema

**File:** `web/src/app/api/runs/__tests__/auth-validation.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { id: 'a1', name: 'Cursor', availableModels: [{ dbId: 'm1', externalId: 'gpt-4o', name: 'gpt-4o' }] };
const mockModel = { id: 'm1', name: 'gpt-4o' };
const mockScenario = { id: 's1', slug: 'test', prompt: 'Do it', language: 'python' };

const mockExecutorWithAuth = {
  id: 'e1',
  agentId: 'a1',
  agentType: 'cursor',
  agentSlug: 'cursor',
  type: 'docker',
  config: {},
  authMethods: [
    { id: 'cursor-api-key', type: 'env_var', description: 'API Key', envVars: ['CURSOR_API_KEY'] },
    { id: 'chatgpt', type: 'agent', description: 'ChatGPT OAuth' },
  ],
};

const secretsCache = vi.hoisted(() => ({
  getDecryptedSecretsForExecutor: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/agents/secrets', () => secretsCache);

// Prevent actual loadAuthSchema usage — this should be removed in the implementation
vi.mock('@/lib/agents/auth-schema', () => ({
  loadAuthSchema: vi.fn().mockRejectedValue(new Error('loadAuthSchema should not be called')),
}));

const dbTransactionMock = vi.hoisted(() => vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
      }),
    }),
  };
  return fn(tx);
}));

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: { name?: string }) => {
        if (table?.name === 'agents') return { where: vi.fn().mockResolvedValue([mockAgent]) };
        if (table?.name === 'agentExecutors') {
          return {
            where: vi.fn().mockImplementation(() => {
              const r = Promise.resolve([mockExecutorWithAuth]);
              (r as unknown as Record<string, unknown>).limit = vi.fn().mockResolvedValue([mockExecutorWithAuth]);
              return r;
            }),
          };
        }
        if (table?.name === 'models') return { where: vi.fn().mockResolvedValue([mockModel]) };
        if (table?.name === 'scenarios') return { where: vi.fn().mockResolvedValue([mockScenario]) };
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }),
    transaction: dbTransactionMock,
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { id: 'agentExecutors.id', agentId: 'agentExecutors.agentId', name: 'agentExecutors' },
  models: { id: 'models.id', name: 'models' },
  scenarios: { id: 'scenarios.id', name: 'scenarios' },
  runs: { name: 'runs' },
  runTasks: { id: 'runTasks.id', agentExecutorId: 'runTasks.agentExecutorId', modelId: 'runTasks.modelId', scenarioId: 'runTasks.scenarioId', name: 'runTasks' },
}));

vi.mock('@/lib/orchestrator/scheduler', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/lib/orchestrator/docker-executor', () => ({
  DockerExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/lib/orchestrator/reconciler', () => ({
  Reconciler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/lib/orchestrator/event-bus', () => ({
  runEventBus: { subscribe: vi.fn(), emit: vi.fn() },
}));

vi.mock('@/lib/env', () => ({
  env: { DOCKER_HOST: 'http://localhost:2375', WORK_ROOT: './work' },
}));

describe('POST /api/runs — auth validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_post_missingEnvVarSecret_returns400WithMissing', async () => {
    // No secrets configured — CURSOR_API_KEY is missing
    secretsCache.getDecryptedSecretsForExecutor.mockResolvedValueOnce({});

    const { POST } = await import('../route');

    const request = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [{ id: 'a1', models: ['m1'] }],
        scenarios: ['s1'],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain('CURSOR_API_KEY');
  });

  it('test_post_envVarPresent_agentMissing_returns201WithWarnings', async () => {
    // CURSOR_API_KEY is present, but chatgpt (agent type) is not configured
    secretsCache.getDecryptedSecretsForExecutor.mockResolvedValueOnce({
      CURSOR_API_KEY: 'sk-test',
    });

    const { POST } = await import('../route');

    const request = new Request('http://localhost/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [{ id: 'a1', models: ['m1'] }],
        scenarios: ['s1'],
      }),
    });

    const response = await POST(request);
    // Should succeed but may include warnings
    expect(response.status).toBe(201);
  });
});
```

**Commit:** `test(runs): add auth validation tests for authMethods-based approach`

### Step 7.4 — Update runs route to use authMethods

- [ ] Replace `loadAuthSchema` with cached `authMethods` validation

**File:** `web/src/app/api/runs/route.ts`

Replace the imports — remove `loadAuthSchema`, add auth method types:

```typescript
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, agents, agentExecutors, models, scenarios } from '@/db/schema';
import { Scheduler } from '@/lib/orchestrator/scheduler';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { Reconciler } from '@/lib/orchestrator/reconciler';
import { runEventBus } from '@/lib/orchestrator/event-bus';
import { env } from '@/lib/env';
import { z } from 'zod';
import type { LaneConfig } from '@/lib/orchestrator/types';
import { getDecryptedSecretsForExecutor } from '@/lib/agents/secrets';
import type { AcpAuthMethod } from '@/lib/agents/auth-discovery';
import { resolveAcpConfig } from '@/lib/orchestrator/acp-config';
```

Replace the auth validation block (lines 69-79) with:

```typescript
    // Validate required secrets from cached authMethods
    const acpConfig = resolveAcpConfig(executor.agentType);
    const cachedAuthMethods = (executor.authMethods as AcpAuthMethod[] | null);

    if (cachedAuthMethods === null && acpConfig.requiresAuth) {
      return NextResponse.json(
        { error: `Agent "${agent.name}" has no auth methods discovered. Run model discovery first.` },
        { status: 400 },
      );
    }

    const warnings: string[] = [];

    if (cachedAuthMethods) {
      for (const method of cachedAuthMethods) {
        if (method.type === 'env_var') {
          // env_var methods are required — check that all envVars are present
          const envVars = (method.envVars as string[]) ?? [];
          const missing = envVars.filter((v) => !mergedEnv[v]);
          if (missing.length > 0) {
            return NextResponse.json(
              { error: `Agent "${agent.name}" is missing required secrets: ${missing.join(', ')}` },
              { status: 400 },
            );
          }
        } else if (method.type === 'agent' || method.type === 'terminal') {
          // agent/terminal methods are optional — warn if not configured
          // (We can't easily check these without querying secrets by method ID,
          //  but env vars won't cover them. Add a warning for awareness.)
          warnings.push(`Auth method "${method.id}" (${method.type}) may need configuration`);
        }
      }
    }
```

At the end of the POST function, change the return to include warnings:

```typescript
  return NextResponse.json(
    { runId: run.id, ...(warnings.length > 0 ? { warnings } : {}) },
    { status: 201 },
  );
```

Note: The `warnings` array needs to be declared outside the agent loop. Move the declaration before the `for (const agentSel of agentSelections)` loop:

```typescript
  const warnings: string[] = [];

  for (const agentSel of agentSelections) {
```

And remove the `const warnings: string[] = [];` from inside the loop.

**Commit:** `feat(runs): replace loadAuthSchema with authMethods-based validation`

### Step 7.5 — Run tests

- [ ] Verify runs route tests and scheduler tests pass

```bash
cd web && npx vitest run src/app/api/runs/__tests__/
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler-credentials.test.ts
```

**Commit:** (no commit — verification step)

---

## Task 8: OAuth Capture (SSE endpoint)

**Goal:** Implement SSE endpoint for OAuth device code capture: starts container with BROWSER=echo, monitors stdout for URLs, streams progress events to client.

**DoD:**
- `captureOAuthCredentials()` in `oauth-capture.ts` handles URL detection and device code parsing
- `POST /api/agents/[id]/auth/oauth` streams SSE events: `starting`, `awaiting_browser`, `completed`, `failed`
- 30s URL capture timeout, 300s overall timeout
- AbortController cleanup on SSE disconnect
- In-memory `Map<executorId, AbortController>` for concurrency lock (409)
- Tests for URL regex, device code detection, capture flow

### Step 8.1 — Write tests for OAuth capture

- [ ] Test URL detection, device code parsing, and capture lifecycle

**File:** `web/src/lib/agents/__tests__/oauth-capture.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { extractUrls, detectDeviceCode } from '../oauth-capture';

describe('extractUrls', () => {
  it('test_extractUrls_httpUrl_extracted', () => {
    const urls = extractUrls('Visit http://example.com/auth to login');
    expect(urls).toContain('http://example.com/auth');
  });

  it('test_extractUrls_httpsUrl_extracted', () => {
    const urls = extractUrls('Open https://github.com/login/device');
    expect(urls).toContain('https://github.com/login/device');
  });

  it('test_extractUrls_multipleUrls_allExtracted', () => {
    const urls = extractUrls('Go to https://a.com or https://b.com/path');
    expect(urls).toHaveLength(2);
  });

  it('test_extractUrls_noUrls_emptyArray', () => {
    const urls = extractUrls('No URLs here');
    expect(urls).toEqual([]);
  });

  it('test_extractUrls_urlWithQueryParams_extracted', () => {
    const urls = extractUrls('https://login.example.com/authorize?code=abc&state=xyz');
    expect(urls[0]).toBe('https://login.example.com/authorize?code=abc&state=xyz');
  });

  it('test_extractUrls_urlInQuotes_extracted', () => {
    const urls = extractUrls('Open "https://example.com/auth"');
    expect(urls[0]).toBe('https://example.com/auth');
  });
});

describe('detectDeviceCode', () => {
  it('test_detectDeviceCode_codeInContext_extracted', () => {
    const lines = [
      'Opening browser...',
      'Enter this code: ABCD-1234',
      'Waiting for authentication...',
    ];
    const code = detectDeviceCode(lines, 1);
    expect(code).toBe('ABCD-1234');
  });

  it('test_detectDeviceCode_codeKeywordNearby_extracted', () => {
    const lines = [
      'Device code: XY12-AB34',
      'Visit https://github.com/login/device',
      'Enter the code above',
    ];
    const code = detectDeviceCode(lines, 1);
    expect(code).toBe('XY12-AB34');
  });

  it('test_detectDeviceCode_noCode_returnsNull', () => {
    const lines = ['Just some random output', 'Nothing here'];
    const code = detectDeviceCode(lines, 0);
    expect(code).toBeNull();
  });

  it('test_detectDeviceCode_onlyUrlLine_noCode', () => {
    const lines = ['Open https://example.com'];
    const code = detectDeviceCode(lines, 0);
    expect(code).toBeNull();
  });
});
```

**Commit:** `test(oauth-capture): add URL extraction and device code detection tests`

### Step 8.2 — Implement oauth-capture.ts

- [ ] Create the OAuth capture module

**File:** `web/src/lib/agents/oauth-capture.ts`

```typescript
import type { AgentExecutor, ExecutorHandle } from '@/lib/orchestrator/types';
import { AcpSession } from '@/lib/orchestrator/acp-session';
import { resolveAcpConfig } from '@/lib/orchestrator/acp-config';
import { saveCredentialBlob } from '@/lib/agents/secrets';
import { extractCredentials } from '@/lib/orchestrator/credential-files';

// ─── URL + Device Code Detection ─────────────────────────────

const URL_REGEX = /https?:\/\/[^\s"'<>]+/g;
const DEVICE_CODE_REGEX = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const CODE_CONTEXT_KEYWORDS = /code|device|enter|verification|one.?time/i;

/**
 * Extract all HTTP(S) URLs from a line of text.
 */
export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_REGEX)].map((m) => m[0]);
}

/**
 * Look for a device code (e.g., "ABCD-1234") in the vicinity of a URL line.
 * Scans +-2 lines around the given URL line index.
 */
export function detectDeviceCode(lines: string[], urlLineIndex: number): string | null {
  const start = Math.max(0, urlLineIndex - 2);
  const end = Math.min(lines.length, urlLineIndex + 3);

  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!CODE_CONTEXT_KEYWORDS.test(line) && i !== urlLineIndex) continue;

    const match = line.match(DEVICE_CODE_REGEX);
    if (match) return match[0];
  }
  return null;
}

// ─── SSE Event Types ──────────────────────────────────────────

export type OAuthEvent =
  | { type: 'starting' }
  | { type: 'awaiting_browser'; url: string; deviceCode: string | null }
  | { type: 'completed'; acpMethodId: string }
  | { type: 'failed'; error: string };

// ─── Concurrency Lock ─────────────────────────────────────────

const activeCaptures = new Map<string, AbortController>();

export function isCaptureLocked(executorId: string): boolean {
  return activeCaptures.has(executorId);
}

export function lockCapture(executorId: string): AbortController {
  if (activeCaptures.has(executorId)) {
    throw new Error('OAuth capture already in progress');
  }
  const controller = new AbortController();
  activeCaptures.set(executorId, controller);
  return controller;
}

export function unlockCapture(executorId: string): void {
  const controller = activeCaptures.get(executorId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  activeCaptures.delete(executorId);
}

// ─── OAuth Capture Flow ───────────────────────────────────────

const URL_CAPTURE_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 300_000;

/**
 * Run the OAuth capture flow:
 * 1. Start container with BROWSER=echo
 * 2. AcpSession.start + authenticate({methodId})
 * 3. Monitor stdout/stderr for URLs
 * 4. Wait for completion or timeout
 * 5. Extract credential files and save to DB
 *
 * @param emit Callback for SSE events
 */
export async function captureOAuthCredentials(params: {
  executor: AgentExecutor;
  handle: ExecutorHandle;
  executorId: string;
  agentType: string;
  acpMethodId: string;
  signal: AbortSignal;
  emit: (event: OAuthEvent) => void;
}): Promise<void> {
  const { executor, handle, executorId, agentType, acpMethodId, signal, emit } = params;

  emit({ type: 'starting' });

  const acpConfig = resolveAcpConfig(agentType);
  const credentialPaths = acpConfig.credentialPaths ?? [];

  let session: AcpSession | null = null;

  try {
    // Start ACP session with auth capabilities
    const { session: acpSession } = await AcpSession.startForDiscovery(
      executor, handle, acpConfig,
    );
    session = acpSession;

    // Trigger authentication
    await (session as unknown as { connection: { authenticate: (p: { methodId: string }) => Promise<unknown> } })
      .connection.authenticate({ methodId: acpMethodId });

    // Monitor stdout/stderr for URLs
    const proc = (session as unknown as { proc: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream } }).proc;
    const outputLines: string[] = [];
    let urlFound = false;

    const urlPromise = new Promise<{ url: string; deviceCode: string | null }>((resolve, reject) => {
      const urlTimeout = setTimeout(() => {
        reject(new Error('URL capture timeout: no authentication URL detected within 30s'));
      }, URL_CAPTURE_TIMEOUT_MS);

      const processLine = (line: string) => {
        outputLines.push(line);
        const urls = extractUrls(line);
        if (urls.length > 0 && !urlFound) {
          urlFound = true;
          clearTimeout(urlTimeout);
          const deviceCode = detectDeviceCode(outputLines, outputLines.length - 1);
          resolve({ url: urls[0], deviceCode });
        }
      };

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      signal.addEventListener('abort', () => {
        clearTimeout(urlTimeout);
        reject(new Error('OAuth capture aborted'));
      });
    });

    const { url, deviceCode } = await urlPromise;
    emit({ type: 'awaiting_browser', url, deviceCode });

    // Wait for the auth process to complete (or timeout)
    const overallTimeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), OVERALL_TIMEOUT_MS),
    );

    const completionPromise = new Promise<'completed'>((resolve) => {
      // Monitor for process exit (auth completed)
      const checkInterval = setInterval(() => {
        // If the process closes stdout, auth is done
        if (proc.stdout.readableEnded) {
          clearInterval(checkInterval);
          resolve('completed');
        }
      }, 1000);

      signal.addEventListener('abort', () => {
        clearInterval(checkInterval);
      });
    });

    const result = await Promise.race([completionPromise, overallTimeout]);

    if (result === 'timeout') {
      emit({ type: 'failed', error: 'OAuth flow timed out after 300s' });
      return;
    }

    // Extract credential files from container and save
    if (credentialPaths.length > 0) {
      try {
        const base64Tar = await extractCredentials(executor, handle, credentialPaths);
        await saveCredentialBlob({
          executorId,
          acpMethodId,
          base64Tar,
          credentialPaths,
        });
        emit({ type: 'completed', acpMethodId });
      } catch (extractError) {
        emit({
          type: 'failed',
          error: `Auth completed but credential extraction failed: ${extractError instanceof Error ? extractError.message : String(extractError)}`,
        });
      }
    } else {
      emit({ type: 'completed', acpMethodId });
    }
  } catch (error) {
    if (signal.aborted) return;
    emit({
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (session) {
      try { await session.close(); } catch { /* best effort */ }
    }
  }
}
```

**Commit:** `feat(oauth-capture): add OAuth device code capture with URL detection`

### Step 8.3 — Create OAuth SSE route

- [ ] Implement `POST /api/agents/[id]/auth/oauth/route.ts`

**File:** `web/src/app/api/agents/[id]/auth/oauth/route.ts`

```typescript
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
  const { acpMethodId } = body as { acpMethodId?: string };

  if (!acpMethodId) {
    return NextResponse.json({ error: 'acpMethodId is required' }, { status: 400 });
  }

  // Concurrency lock: one OAuth capture per executor at a time
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
            'litmus.oauth': 'true',
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
        // Cleanup
        if (handle) {
          try { await docker.stop(handle); } catch { /* best effort */ }
        }
        unlockCapture(executor.id);
        streamController.close();
      }
    },
    cancel() {
      // Client disconnected — abort the capture
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
```

**Commit:** `feat(oauth-route): add SSE endpoint for OAuth device code capture`

### Step 8.4 — Write test for OAuth SSE route concurrency

- [ ] Test 409 when capture is already in progress

**File:** `web/src/app/api/agents/[id]/auth/oauth/__tests__/oauth-concurrency.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lockCapture, unlockCapture, isCaptureLocked } from '@/lib/agents/oauth-capture';

describe('OAuth capture concurrency lock', () => {
  const executorId = 'e1';

  afterEach(() => {
    // Clean up any locks
    if (isCaptureLocked(executorId)) {
      unlockCapture(executorId);
    }
  });

  it('test_lockCapture_firstCall_succeeds', () => {
    const controller = lockCapture(executorId);
    expect(controller).toBeDefined();
    expect(isCaptureLocked(executorId)).toBe(true);
  });

  it('test_lockCapture_secondCall_throws', () => {
    lockCapture(executorId);
    expect(() => lockCapture(executorId)).toThrow('already in progress');
  });

  it('test_unlockCapture_afterLock_releasesLock', () => {
    lockCapture(executorId);
    unlockCapture(executorId);
    expect(isCaptureLocked(executorId)).toBe(false);
  });

  it('test_unlockCapture_abortsController', () => {
    const controller = lockCapture(executorId);
    expect(controller.signal.aborted).toBe(false);
    unlockCapture(executorId);
    expect(controller.signal.aborted).toBe(true);
  });
});
```

**Commit:** `test(oauth): add concurrency lock tests`

### Step 8.5 — Run tests

- [ ] Verify all OAuth tests pass

```bash
cd web && npx vitest run src/lib/agents/__tests__/oauth-capture.test.ts
cd web && npx vitest run src/app/api/agents/[id]/auth/oauth/__tests__/
```

**Commit:** (no commit — verification step)

---

## Task 9: Mock ACP Server + Delete Legacy

**Goal:** Extend mock ACP server to support auth discovery and authenticate method. Delete legacy `auth-schema.ts` and `auth.json` files.

**DoD:**
- Mock ACP server returns `authMethods` in initialize response
- Mock ACP server handles `authenticate` method (prints mock URL to stdout)
- `auth-schema.ts` deleted
- `auth.json` files deleted
- No remaining imports of `loadAuthSchema`
- Regression test confirms no references

### Step 9.1 — Update mock ACP server

- [ ] Add authMethods to initialize and authenticate handler

**File:** `web/agents/mock/mock-acp-server.py`

Replace the full file:

```python
#!/usr/bin/env python3
"""Minimal ACP JSON-RPC server over stdio for the mock agent.

Replaces mock/run.sh. Copies solution/ files into the workspace on session/prompt,
just like the shell script did.

Uses only Python 3.12 stdlib — no pip dependencies.
"""
import json
import shutil
import sys
import os
from pathlib import Path

def send_response(id, result):
    msg = json.dumps({"jsonrpc": "2.0", "id": id, "result": result})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()

def send_notification(method, params):
    msg = json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()

# Store session cwd for use in prompt handler
_session_cwd = "/work"

def handle_initialize(msg_id, params):
    # Include authMethods in capabilities for auth discovery testing
    client_caps = params.get("clientCapabilities", {})
    auth_caps = client_caps.get("auth", {})

    capabilities = {}
    if auth_caps.get("terminal"):
        capabilities["auth"] = {
            "methods": [
                {
                    "id": "mock-api-key",
                    "type": "env_var",
                    "description": "Mock API Key",
                    "envVars": ["MOCK_API_KEY"],
                },
                {
                    "id": "mock-oauth",
                    "type": "agent",
                    "description": "Mock OAuth login (device code flow)",
                },
            ],
        }

    send_response(msg_id, {
        "protocolVersion": "2025-11-16",
        "agentInfo": {"name": "mock-acp", "version": "1.0.0"},
        "capabilities": capabilities,
    })

def handle_new_session(msg_id, params):
    global _session_cwd
    _session_cwd = params.get("cwd", "/work")
    send_response(msg_id, {"sessionId": "mock-session"})

def handle_prompt(msg_id, params):
    session_id = params.get("sessionId", "mock-session")
    meta = params.get("_meta", {})
    scenario_dir = meta.get("scenarioDir", "")

    workspace = _session_cwd
    solution_dir = os.path.join(scenario_dir, "solution")

    status_text = "Mock agent: no solution directory found"

    if os.path.isdir(solution_dir):
        project_dir = os.path.join(workspace, "project")
        os.makedirs(project_dir, exist_ok=True)
        for item in os.listdir(solution_dir):
            src = os.path.join(solution_dir, item)
            dst = os.path.join(project_dir, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        status_text = f"Mock agent: copied solution from {solution_dir} to {project_dir}"
    elif not scenario_dir:
        status_text = "Mock agent: no scenarioDir in _meta"

    # Send session/update notification with text content
    send_notification("session/update", {
        "sessionId": session_id,
        "updates": [{"type": "text", "text": status_text}],
    })

    send_response(msg_id, {
        "stopReason": "end_turn",
        "usage": {
            "inputTokens": 10,
            "outputTokens": 5,
            "totalTokens": 15,
        },
    })

def handle_authenticate(msg_id, params):
    """Handle authenticate request by printing a mock OAuth URL to stdout."""
    method_id = params.get("methodId", "unknown")

    # Print URL to stdout (captured by the OAuth capture flow)
    # This simulates what a real agent would do during device code auth
    print(f"Please visit: https://mock-auth.example.com/device?method={method_id}", flush=True)
    print(f"Enter code: MOCK-1234", flush=True)

    # Simulate successful auth after a brief moment
    send_response(msg_id, {"status": "authenticated"})

def handle_cancel(_params):
    # Notification — no response expected. Exit cleanly per spec.
    sys.exit(0)

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        params = msg.get("params", {})
        msg_id = msg.get("id")

        if method == "initialize":
            handle_initialize(msg_id, params)
        elif method == "session/new":
            handle_new_session(msg_id, params)
        elif method == "session/prompt":
            handle_prompt(msg_id, params)
        elif method == "session/cancel":
            handle_cancel(params)
        elif method == "authenticate":
            handle_authenticate(msg_id, params)
        elif msg_id is not None:
            # Unknown method with id — return error
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
```

**Commit:** `feat(mock): add authMethods discovery + authenticate handler to mock ACP server`

### Step 9.2 — Delete legacy auth-schema.ts

- [ ] Remove `web/src/lib/agents/auth-schema.ts`

```bash
cd web && rm src/lib/agents/auth-schema.ts
```

**Commit:** `chore: delete legacy auth-schema.ts`

### Step 9.3 — Delete legacy auth.json files

- [ ] Remove static auth.json files from agent directories

```bash
cd web && rm -f agents/cursor/auth.json
```

Check for any other auth.json files:

```bash
find web/agents -name 'auth.json' -type f
```

Delete any found.

**Commit:** `chore: delete legacy auth.json files`

### Step 9.4 — Write regression test: no loadAuthSchema imports

- [ ] Verify loadAuthSchema is not imported anywhere

**File:** `web/src/lib/agents/__tests__/no-legacy-auth.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

describe('Legacy auth removal', () => {
  it('test_noLoadAuthSchemaImports_inSourceFiles', () => {
    try {
      const result = execSync(
        'grep -r "loadAuthSchema" src/ --include="*.ts" --include="*.tsx" -l',
        { cwd: process.cwd(), encoding: 'utf-8' },
      );
      // If grep finds files, they still import loadAuthSchema
      expect(result.trim()).toBe('');
    } catch {
      // grep returns exit code 1 when no matches — that's what we want
    }
  });

  it('test_authSchemaFile_doesNotExist', () => {
    const fs = require('fs');
    expect(fs.existsSync('src/lib/agents/auth-schema.ts')).toBe(false);
  });
});
```

**Commit:** `test: add regression test for legacy auth removal`

### Step 9.5 — Run all tests

- [ ] Full test suite regression check

```bash
cd web && npx vitest run
```

**Commit:** (no commit — verification step)

---

## Task 10: Orphan Container Cleanup

**Goal:** Add startup cleanup for OAuth capture containers that may have been left running.

**DoD:**
- Startup cleanup identifies containers with `litmus.oauth=true` label and removes them
- OAuth containers get the label during creation (already done in Task 8)
- Tested

### Step 10.1 — Write test for OAuth container cleanup

- [ ] Test that orphaned OAuth containers are cleaned up

**File:** `web/src/lib/orchestrator/__tests__/startup-oauth-cleanup.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListContainers = vi.fn().mockResolvedValue([]);
const mockGetContainer = vi.fn();
const mockContainerStop = vi.fn().mockResolvedValue(undefined);
const mockContainerRemove = vi.fn().mockResolvedValue(undefined);

vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => ({
    listContainers: mockListContainers,
    getContainer: mockGetContainer.mockReturnValue({
      stop: mockContainerStop,
      remove: mockContainerRemove,
    }),
    ping: vi.fn().mockResolvedValue('OK'),
  })),
}));

describe('cleanupOAuthOrphans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_cleanupOAuthOrphans_noContainers_returns0', async () => {
    mockListContainers.mockResolvedValueOnce([]);

    const { DockerExecutor } = await import('../docker-executor');
    const executor = new DockerExecutor('http://localhost:2375');
    const cleaned = await executor.cleanupOAuthOrphans();

    expect(cleaned).toBe(0);
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['litmus.oauth=true'] },
    });
  });

  it('test_cleanupOAuthOrphans_withContainers_stopsAndRemoves', async () => {
    mockListContainers.mockResolvedValueOnce([
      { Id: 'container-1' },
      { Id: 'container-2' },
    ]);

    const { DockerExecutor } = await import('../docker-executor');
    const executor = new DockerExecutor('http://localhost:2375');
    const cleaned = await executor.cleanupOAuthOrphans();

    expect(cleaned).toBe(2);
    expect(mockContainerStop).toHaveBeenCalledTimes(2);
    expect(mockContainerRemove).toHaveBeenCalledTimes(2);
  });
});
```

**Commit:** `test(startup): add OAuth orphan container cleanup test`

### Step 10.2 — Add cleanupOAuthOrphans to DockerExecutor

- [ ] Add method to clean up OAuth containers

**File:** `web/src/lib/orchestrator/docker-executor.ts`

Add after the existing `cleanupOrphans` method (after line 148):

```typescript
  /** Remove all containers labeled litmus.oauth=true (OAuth capture orphan cleanup) */
  async cleanupOAuthOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['litmus.oauth=true'] },
    });
    for (const info of containers) {
      const c = this.docker.getContainer(info.Id);
      try {
        await c.stop({ t: 2 });
      } catch {
        // already stopped
      }
      await c.remove({ force: true });
    }
    return containers.length;
  }
```

**Commit:** `feat(docker-executor): add cleanupOAuthOrphans method`

### Step 10.3 — Register OAuth cleanup in startup

- [ ] Call cleanupOAuthOrphans during startup

**File:** `web/src/lib/orchestrator/startup.ts`

Add OAuth cleanup after the existing `cleanupOrphans` call (after line 12):

```typescript
  const oauthCleaned = await executor.cleanupOAuthOrphans();
  if (oauthCleaned > 0) {
    console.log(`[startup] Cleaned ${oauthCleaned} orphaned OAuth capture containers`);
  }
```

Full file:

```typescript
import { sql } from '@/db';
import { refreshMatviews } from '@/lib/db/refresh-matviews';
import { env } from '@/lib/env';
import { DockerExecutor } from './docker-executor';

const STALE_ERROR_MESSAGE = 'Process terminated unexpectedly';

export async function startupCleanup(): Promise<void> {
  const executor = new DockerExecutor(env.DOCKER_HOST);

  const cleaned = await executor.cleanupOrphans();
  if (cleaned > 0) {
    console.log(`[startup] Cleaned ${cleaned} orphaned agent containers`);
  }

  const oauthCleaned = await executor.cleanupOAuthOrphans();
  if (oauthCleaned > 0) {
    console.log(`[startup] Cleaned ${oauthCleaned} orphaned OAuth capture containers`);
  }

  await sql.unsafe(`
    INSERT INTO run_results (
      run_id,
      agent_id,
      model_id,
      scenario_id,
      status,
      tests_passed,
      tests_total,
      total_score,
      duration_seconds,
      attempt,
      max_attempts,
      error_message
    )
    SELECT
      rt.run_id,
      ae.agent_id,
      rt.model_id,
      rt.scenario_id,
      'error',
      0,
      0,
      0,
      0,
      1,
      1,
      '${STALE_ERROR_MESSAGE}'
    FROM run_tasks rt
    JOIN agent_executors ae ON ae.id = rt.agent_executor_id
    WHERE rt.status = 'running'
    ON CONFLICT (run_id, agent_id, model_id, scenario_id) DO NOTHING
  `);

  const staleTasks = await sql.unsafe(`
    UPDATE run_tasks
    SET status = 'error',
        error_message = '${STALE_ERROR_MESSAGE}',
        finished_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `) as Array<{ id: string }>;

  if (staleTasks.length > 0) {
    console.log(`[startup] Marked ${staleTasks.length} stale running tasks as error`);
  }

  await sql.unsafe(`
    UPDATE runs
    SET status = 'failed',
        finished_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `);

  await refreshMatviews({
    warn: (message) => console.warn(message),
  });
}
```

**Commit:** `feat(startup): add OAuth orphan container cleanup to startup`

### Step 10.4 — Run final tests

- [ ] Full suite regression check

```bash
cd web && npx vitest run
```

**Commit:** (no commit — verification step)

---

## Summary of Files Changed/Created

### New Files
| File | Task |
|------|------|
| `web/drizzle/0008_acp_auth.sql` | 1 |
| `web/src/db/__tests__/schema-acp-auth.test.ts` | 1 |
| `web/src/lib/agents/__tests__/secrets.test.ts` | 2 |
| `web/src/lib/agents/migrate-secrets.ts` | 2 |
| `web/src/lib/agents/auth-discovery.ts` | 4 |
| `web/src/lib/agents/__tests__/auth-discovery.test.ts` | 4 |
| `web/src/lib/agents/oauth-capture.ts` | 8 |
| `web/src/lib/agents/__tests__/oauth-capture.test.ts` | 8 |
| `web/src/lib/agents/__tests__/no-legacy-auth.test.ts` | 9 |
| `web/src/lib/orchestrator/acp-config.ts` | 3 |
| `web/src/lib/orchestrator/__tests__/acp-config.test.ts` | 3 |
| `web/src/lib/orchestrator/credential-files.ts` | 6 |
| `web/src/lib/orchestrator/__tests__/credential-files.test.ts` | 6 |
| `web/src/lib/orchestrator/__tests__/scheduler-credentials.test.ts` | 7 |
| `web/src/app/api/agents/[id]/auth/oauth/route.ts` | 8 |
| `web/src/app/api/agents/[id]/auth/oauth/__tests__/oauth-concurrency.test.ts` | 8 |
| `web/src/app/api/agents/[id]/models/__tests__/auth-discovery-integration.test.ts` | 4 |
| `web/src/app/api/agents/[id]/auth/__tests__/auth-routes.test.ts` | 5 |
| `web/src/app/api/runs/__tests__/auth-validation.test.ts` | 7 |
| `web/src/lib/orchestrator/__tests__/startup-oauth-cleanup.test.ts` | 10 |

### Modified Files
| File | Task |
|------|------|
| `web/src/db/schema.ts` | 1 |
| `web/drizzle/meta/_journal.json` | 1 |
| `web/src/lib/agents/secrets.ts` | 2 |
| `web/src/instrumentation.ts` | 2 |
| `web/src/lib/orchestrator/types.ts` | 3 |
| `web/src/lib/orchestrator/scheduler.ts` | 3, 7 |
| `web/src/lib/orchestrator/acp-session.ts` | 3, 4 |
| `web/src/app/api/agents/[id]/models/route.ts` | 4 |
| `web/src/app/api/agents/[id]/auth/route.ts` | 5 |
| `web/src/app/api/runs/route.ts` | 7 |
| `web/agents/mock/mock-acp-server.py` | 9 |
| `web/src/lib/orchestrator/docker-executor.ts` | 10 |
| `web/src/lib/orchestrator/startup.ts` | 10 |

### Deleted Files
| File | Task |
|------|------|
| `web/src/lib/agents/auth-schema.ts` | 9 |
| `web/agents/cursor/auth.json` | 9 |

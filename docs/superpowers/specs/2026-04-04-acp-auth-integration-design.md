# ACP Authentication Integration — Design Spec

**Date:** 2026-04-04
**Status:** Draft
**Depends on:** ACP Integration (Phases 1-4) completed

## Problem

Litmus authenticates coding agents via static `auth.json` files that hard-code required env vars per agent type. This has three issues:

1. **Manual maintenance** — each new agent requires a hand-written `auth.json` with known env var names
2. **Only one auth type** — only API keys via env vars. Agents offering OAuth (Cline, Codex ChatGPT) or terminal-based login (OpenCode, KiloCode) cannot be authenticated
3. **Disconnected from agent** — the agent knows its own auth requirements (returned in ACP `InitializeResponse.authMethods`), but Litmus ignores them and maintains a parallel, potentially stale, schema

## Solution

Replace static `auth.json` with **ACP-driven auth discovery**. At model discovery time, Litmus performs an ACP `initialize` handshake (with `clientCapabilities.auth.terminal: true` to receive all method types), caches the agent's declared `authMethods`, and dynamically renders auth UI. Two storage types cover all auth methods:

| ACP authMethod type | Storage | Delivery | User experience |
|---|---|---|---|
| `env_var` | `api_key` (encrypted string) | Env vars at container start | Password input field (same as today) |
| `agent` (OAuth-capable) | `credential_files` (encrypted tar blob) | Credential files restored to `$HOME` | "Sign in" button → device code OAuth → auto-capture |
| `terminal` | `credential_files` (encrypted tar blob) | Credential files restored to `$HOME` | Terminal command run in container → credential file upload |

**Two storage types only:** `api_key` for env var-backed secrets, `credential_files` for everything else. No `oauth_token` type — OAuth agents save tokens as files on disk, which Litmus extracts as tar blobs. This avoids the impossible task of parsing structured tokens from opaque agent credential directories.

### ACP Auth Protocol Summary

The `InitializeResponse` includes an `authMethods` array. ACP defines three discriminated union types (`AuthMethod`):

**`env_var`** — environment variable-based:
- `id: string`, `name: string`, `description?: string`, **`link?: string`** (URL to credential page — **only on `env_var`**)
- `vars: AuthEnvVar[]` — which env vars to set (each has `name: string`, `optional?: boolean`, `secret?: boolean`, `label?: string`)

**`terminal`** (UNSTABLE/experimental in SDK) — terminal-based interactive auth:
- `id: string`, `name: string`, `description?: string` (no `link` field)
- `args?: string[]` — additional args for agent binary during terminal auth
- `env?: Record<string, string>` — additional env vars for agent binary during terminal auth
- **Requires client opt-in:** agent only advertises `terminal` methods when `clientCapabilities.auth.terminal === true` in `InitializeRequest`

**`agent`** (default when `type` absent) — agent handles auth itself (OAuth, browser):
- `id: string`, `name: string`, `description?: string` (no `link` field)

After discovery, the client calls `authenticate({ methodId })` to initiate auth. `AuthenticateRequest` contains only `{ methodId: string, _meta?: Record }` — no additional fields like `code`. The agent then performs auth internally.

**Storage: Litmus stores `authMethods` in DB with minimal canonicalization.** All type-specific fields (`args`, `env`, `vars`, `link`) are preserved as-is — no field stripping. The only canonicalization applied at discovery time:

- **`type` defaulting:** ACP `AuthMethodAgent` has no `type` discriminator in the SDK union (it's the default branch). When storing, Litmus explicitly sets `type: 'agent'` on entries where `type` is absent. This ensures all stored entries have an explicit `type` field, simplifying downstream code. Performed in `auth-discovery.ts` during the `extractAuthMethods` step.

All other fields pass through unchanged. UI and pre-flight logic read `type` from stored JSON.

### Observed authMethods by Agent (from smoke tests)

| Agent | ACP Command | authMethods |
|---|---|---|
| Claude Code | `claude-agent-acp` | `[]` (reads `ANTHROPIC_API_KEY` from env implicitly) |
| Codex | `codex-acp` | `env_var: CODEX_API_KEY`, `env_var: OPENAI_API_KEY`, `agent: chatgpt` (OAuth) |
| Cursor | `cursor-agent-acp` | Pending (adapter starts but needs API key for full init) |
| OpenCode | `opencode acp` | `agent: opencode-login` (terminal: `opencode auth login`) |
| Cline | `cline --acp` | `agent: cline-oauth` (OAuth), `agent: openai-codex-oauth` (ChatGPT OAuth) |
| KiloCode | `kilo acp` | `agent: kilo-login` (terminal: `kilo auth login`) |

---

## Alternatives Considered

1. **Extend `auth.json` with ACP metadata** — keep static auth.json files but enrich them with ACP method IDs and types. Rejected: defeats the purpose of ACP-driven discovery. Every new agent or auth method change still requires manual JSON edits. The whole point is eliminating manual maintenance.

2. **Agent-side credential export API** — instead of tar extraction, ask agents to export credentials via a dedicated ACP method (e.g. `auth/exportCredentials`). Rejected: no such ACP method exists or is proposed. Would require upstream ACP spec changes with uncertain timeline. Tar extraction from known paths works today with any agent.

3. **WebSocket-based auth handshake** — run OAuth entirely server-side via a WebSocket channel between Litmus UI and a dedicated auth service container. Rejected: overengineered for single-tenant use. Adds a new service and protocol layer when SSE + `BROWSER=echo` achieves the same goal with existing infrastructure.

---

## Architecture

### Data Model Changes

**`agent_executors` table — add columns:**
```
authMethods: jsonb('auth_methods')           -- cached from ACP InitializeResponse
authMethodsDiscoveredAt: timestamp('auth_methods_discovered_at')  -- when discovery last ran
```

Populated during model discovery. `null` = discovery not yet run. `authMethodsDiscoveredAt` enables staleness detection — UI can show "Refresh" hint if older than 24h or after agent version changes.

**`agent_secrets` table — extend:**

Current schema:
```
agentExecutorId, envVar, encryptedValue, authType ('api_key' | 'oauth'), createdAt, updatedAt
uniqueIndex on (agentExecutorId, envVar)
```

New schema:
```
agentExecutorId, encryptedValue, authType, acpMethodId, credentialPaths, createdAt, updatedAt
uniqueIndex on (agentExecutorId, acpMethodId)
```

Changes:
- **Drop `envVar` column** — replaced by keyed JSON inside `encryptedValue` (see storage below)
- `authType` values: `'api_key'` (unchanged), `'credential_files'` (new). **No `oauth_token` type.**
- `acpMethodId: text NOT NULL` — links to `authMethods[].id` from ACP (e.g. `"openai-api-key"`, `"cline-oauth"`)
- `credentialPaths: jsonb` — for `credential_files`: JSON array of paths relative to `$HOME` (e.g. `[".config/cline/"]`)
- **Unique constraint:** `unique(agentExecutorId, acpMethodId)` — one secret per auth method per executor

**Why drop `envVar`:** ACP `AuthMethodEnvVar` supports multiple variables per method via `vars: Array<AuthEnvVar>`. Each var has `name`, `optional?`, `secret?`, `label?`. Example: Codex method `"openai-api-key"` can declare `vars: [{ name: "OPENAI_API_KEY" }, { name: "OPENAI_ORG_ID", optional: true }]`. Storing one `envVar` per row can't represent this. Instead, `api_key` secrets store all vars as a JSON object in `encryptedValue`.

Storage by type:
- `api_key`: `encryptedValue` = `encrypt(JSON.stringify({ "OPENAI_API_KEY": "sk-...", "OPENAI_ORG_ID": "org-..." }))` — encrypted JSON object keyed by var name. All vars for the method in one blob. Missing optional vars omitted from object.
- `credential_files`: `encryptedValue` = `encrypt(base64text)` — encrypted base64-encoded tar.gz blob (see Binary Pipeline below)

**Pre-flight validation for `env_var` methods:** Iterate `authMethods[methodId].vars`. For each var where `optional !== true` (default `false` per ACP spec), check that the decrypted JSON contains a non-empty value for that var name. Missing required var → 400.

**Migration plan:**

**Phase 1 (SQL):** All schema changes in a single transaction. The existing inline `UNIQUE(agent_executor_id, env_var)` constraint (from `0005_agent_secrets.sql:9`) is auto-named by PostgreSQL as `agent_secrets_agent_executor_id_env_var_key`.

```sql
BEGIN;
-- 1. Add new columns
ALTER TABLE agent_secrets ADD COLUMN acp_method_id text;
ALTER TABLE agent_secrets ADD COLUMN credential_paths jsonb;

-- 2. Migrate existing api_key rows:
--    envVar "ANTHROPIC_API_KEY" with value "sk-..." becomes
--    acpMethodId = envVar (synthetic), encryptedValue = encrypt({"ANTHROPIC_API_KEY": decrypt(old_value)})
--    NOTE: this step runs in application code (decrypt/re-encrypt requires encryption key)
--    SQL only sets the synthetic acpMethodId; re-encryption is a post-migration app task.
UPDATE agent_secrets SET acp_method_id = env_var WHERE env_var IS NOT NULL;

-- 3. Migrate legacy 'oauth' authType
UPDATE agent_secrets SET auth_type = 'credential_files' WHERE auth_type = 'oauth';

-- 4. Set NOT NULL on acpMethodId (all rows now populated)
ALTER TABLE agent_secrets ALTER COLUMN acp_method_id SET NOT NULL;

-- 5. Drop old constraint, create new index
--    Inline UNIQUE auto-named by PG; also try drizzle-generated name
ALTER TABLE agent_secrets DROP CONSTRAINT IF EXISTS agent_secrets_agent_executor_id_env_var_key;
DROP INDEX IF EXISTS idx_agent_secrets_unique;
CREATE UNIQUE INDEX agent_secrets_executor_method_unique
  ON agent_secrets(agent_executor_id, acp_method_id);

-- 6. Drop envVar column (data migrated into encryptedValue by app)
ALTER TABLE agent_secrets DROP COLUMN env_var;
COMMIT;
```

**This is a two-phase migration:**

- **Phase 1 (SQL transaction above):** Schema-level changes. Deterministic, reversible. After this phase, app can start — `getDecryptedSecretsForExecutor()` handles both old format (plain string) and new format (JSON object) during the transition window.
- **Phase 2 (app startup task):** For each `api_key` secret where `encryptedValue` decrypts to a plain string (not JSON), re-encrypt as `JSON.stringify({ [acpMethodId]: decryptedValue })`. Runs once on first app startup after Phase 1. **Done-when:** zero rows where `auth_type = 'api_key'` and decrypted value doesn't parse as JSON. Logged: `"Migration phase 2: converted N secrets to keyed JSON format"`.

**Rollback policy:**
- Phase 1 rollback (SQL below): fully reversible. `credential_files` rows are deleted (accept-loss — these are new data created after migration, user can re-upload). Reason: credential file blobs have no `envVar` to restore into the old schema.
- Phase 2 rollback: not needed independently. If Phase 1 is rolled back, the re-encrypted values are deleted with the rows or don't matter (old format still works).

**Rollback SQL:**
```sql
BEGIN;
ALTER TABLE agent_secrets ADD COLUMN env_var text;
-- Re-populate envVar from acpMethodId (synthetic = old envVar)
UPDATE agent_secrets SET env_var = acp_method_id WHERE auth_type = 'api_key';
-- credential_files rows have no envVar — delete them (new data, no rollback needed)
DELETE FROM agent_secrets WHERE auth_type = 'credential_files';
ALTER TABLE agent_secrets ALTER COLUMN env_var SET NOT NULL;
ALTER TABLE agent_secrets DROP COLUMN acp_method_id;
ALTER TABLE agent_secrets DROP COLUMN credential_paths;
DROP INDEX IF EXISTS agent_secrets_executor_method_unique;
ALTER TABLE agent_secrets ADD CONSTRAINT agent_secrets_agent_executor_id_env_var_key
  UNIQUE(agent_executor_id, env_var);
COMMIT;
```

On first auth discovery per executor, Litmus reconciles: matches existing secrets to discovered `authMethods` by var names in the decrypted JSON, and updates `acpMethodId` to the real ACP method ID.

### Auth Discovery Flow

Extends `POST /api/agents/[id]/models` (model discovery endpoint):

```
1. executor.start()                    — start container (returns handle)
2. AcpSession.start(executor, handle)  — exec ACP binary, initialize handshake
3. response.authMethods → DB           — cache in agent_executors.authMethods
4. acpSession.close()                  — close ACP process (stdin.end + wait)
5. collect(executor, handle, ['models.sh']) — existing model discovery (same container, new exec)
6. executor.stop()                     — stop container
```

Steps 2-4 and step 5 use the **same container handle** but different `executor.exec()` calls. AcpSession spawns one process (the ACP binary) and closes it; `collect` spawns a separate process (models.sh). The Docker container stays running between steps (`sleep infinity` entrypoint). This is the same pattern used in the scheduler's `executeLane` → `executeScenario` flow.

If ACP initialize fails (binary missing, handshake error), `authMethods` is set to `null`, model discovery continues via `models.sh`.

**Important:** `models.sh` MUST NOT invoke ACP binaries or modify container state that could conflict with a prior/subsequent ACP session. It is a pure shell script that discovers models via agent-specific CLI commands (e.g. `codex models`, `opencode models`).

**Known-auth-required fallback:** If `authMethods == null` (discovery failed) and the agent's `resolveAcpConfig().requiresAuth == true`, the auth UI shows a warning: "Auth discovery failed — configure credentials manually or retry discovery." This prevents silently skipping auth for agents that are known to need it.

### Auth API Routes

**Error response format** (all auth endpoints):
```typescript
{ error: string }  // 4xx/5xx responses
```
Consistent with existing `POST /api/runs` error shape.

**`GET /api/agents/[id]/auth`** — returns auth methods + configured status.
Success: **200** with `{ methods: AuthMethodStatus[], discoveryRequired: boolean }`.

```typescript
interface AuthMethodStatus {
  id: string;                     // ACP method ID (= acpMethodId in agent_secrets)
  type: 'env_var' | 'terminal' | 'agent';  // raw ACP type (no normalization)
  name: string;
  description?: string;
  // Type-specific fields (preserved from raw ACP):
  vars?: Array<{ name: string; optional?: boolean; secret?: boolean; label?: string }>;  // env_var only
  args?: string[];                // terminal only
  env?: Record<string, string>;   // terminal only
  link?: string;                  // env_var only (NOT on terminal or agent — see ACP SDK types)
  configured: boolean;            // secret exists in DB for this acpMethodId
  maskedValues?: Record<string, string>;  // env_var only: { "VAR_NAME": "••••last4" }
  oauthCapable: boolean;          // can Litmus attempt OAuth capture for this method?
}
```

Source: reads raw `agent_executors.authMethods` from DB. If null → returns empty array with `discoveryRequired: true` hint.

**UI mapping from raw ACP type:**
- `env_var` → input fields per `vars[]` entry (password for `secret !== false`, text for `secret === false`). `link` shown as helper URL if present.
- `terminal` → "Run auth command" button (uses `args`/`env` to spawn terminal command in container) + "Upload credentials" fallback.
- `agent` → "Sign in" button (OAuth capture) if `oauthCapable`, else "Upload credentials"

**`oauthCapable` determination** (for `type === 'agent'` only — `env_var` and `terminal` are never OAuth):
1. Method `id` matches known OAuth patterns → `true`
   - Known IDs: `"chatgpt"`, any ID containing `"oauth"`
   - Description keywords: `"OAuth"`, `"browser"`, `"sign in"` (case-insensitive)
2. Otherwise → `false` (show "Upload credentials")

Note: `AuthMethodAgent` in ACP SDK has no `link` field (only `id`, `name`, `description`, `_meta`). The heuristic relies on `id` and `description` only. `link` is available on `env_var` type only (per SDK) and is shown as a helper URL in the UI — not used for `oauthCapable` determination.

If detection fails, credential file upload always works as fallback.

**`PUT /api/agents/[id]/auth`** — save a secret.
Success: **200** (updated existing) or **201** (created new). Error: **400** (validation), **404** (agent not found), **413** (credential file >10MB).

Content-Type routing:
- `Content-Type: application/json` → `api_key` (parsed from `type` field in JSON body)
- `Content-Type: multipart/form-data` → `credential_files` (file in `files` field, `methodId` in form field)
- `credential_files` also saved programmatically after OAuth capture (not via this endpoint)

```typescript
// api_key (application/json) — keyed by var name, supports multiple vars per method:
{ methodId: "openai-api-key", type: "api_key", values: { "OPENAI_API_KEY": "sk-...", "OPENAI_ORG_ID": "org-..." } }
// Stored as: encrypt(JSON.stringify(values)) → agent_secrets.encryptedValue

// credential_files (multipart/form-data):
// field "methodId" = "kilo-login", field "files" = <tar.gz binary>
```

**`DELETE /api/agents/[id]/auth`** — remove a secret.
Success: **204** (idempotent — same whether secret existed or not). Error: **404** (agent not found).
```typescript
{ methodId: "cline-oauth" }
```

**`POST /api/agents/[id]/auth/oauth`** — initiate OAuth capture flow.
Success: **200** (SSE stream). Error: **404** (agent not found), **409** (flow already in progress for this executor), **400** (methodId not oauthCapable).
```typescript
// Request:
{ methodId: "cline-oauth" }

// Response (SSE stream):
{ status: "starting" }
{ status: "awaiting_browser", url: "https://...", deviceCode?: "ABCD-1234" }
{ status: "completed" }
// or:
{ status: "failed", error: "Timeout waiting for auth" }
```

### OAuth Capture Flow (BROWSER=echo + Device Code)

When user clicks "Sign in with {name}" in UI:

**Backend (`POST /api/agents/[id]/auth/oauth`):**

1. Start container with `env: { BROWSER: "echo", ...existingSecrets }`
2. `AcpSession.start()` → `initialize` (with `clientCapabilities: { auth: { terminal: true } }`)
3. Call `connection.authenticate({ methodId })` — SDK `AuthenticateRequest` supports only `{ methodId, _meta? }`, no additional fields
4. **URL capture mechanism (best-effort, not a contract):**
   - **Primary channel:** The ACP binary is the direct child of our `exec()`. Docker exec inherits stdio for the entire process tree, so `BROWSER=echo`'s output *typically* appears on `InteractiveHandle.stdout`. However, this depends on how the agent binary propagates subprocesses' stdio — some agents may redirect child stdout.
   - **Secondary channel:** Some agents may emit auth URLs as ACP JSON-RPC notifications. The capture layer monitors both: (a) raw stdout/stderr line scanning, and (b) ACP notifications from the connection.
   - **If neither channel captures a URL within 30s:** SSE emits `{ status: "url_capture_failed" }` → UI shows "Upload credential files instead" fallback.
   - Deduplication: if the same URL appears in both channels, emit it once.
5. **URL extraction regex:** `https?://[^\s"'<>]+` — applied line-by-line to stdout and stderr.
6. **Device code detection regex:** After URL extraction, scan surrounding lines (±2 lines) for alphanumeric codes matching `[A-Z0-9]{4,}[-]?[A-Z0-9]{4,}` or `[A-Za-z0-9]{6,12}`. Common patterns: `ABCD-EFGH`, `abc123def456`, `123-456-789`.
7. Stream to frontend via SSE: `{ status: "awaiting_browser", url, deviceCode? }`

**Frontend:**
1. Receives `url` + optional `deviceCode`
2. Opens URL in new browser tab
3. If `deviceCode` present → shows code for user to enter on provider page
4. Agent polls provider → receives token → saves to credential directory
5. Litmus detects auth completion: `authenticate()` promise resolves (ACP response)
6. Extracts credential files: `collect(executor, handle, ['sh', '-c', 'tar czf - -C /root ...paths | base64'])`
7. `encrypt(base64text)` → saves to `agent_secrets` with `authType: 'credential_files'`
8. Stops container
9. SSE: `{ status: "completed" }`

**If URL capture fails or redirect-based OAuth doesn't complete:**
- UI shows: "Upload credential files instead" → user authenticates manually in their own browser, downloads/copies credential files, uploads via file upload form.
- No code paste mechanism — `AuthenticateRequest` doesn't support passing a code, and writing to container stdin has no ACP contract guaranteeing the agent reads from it.
- Credential file upload is the universal fallback that always works regardless of agent implementation.

**Timeout:** configurable, default 300s (5 min) for entire OAuth flow. Sub-timeouts: 30s for URL capture (before showing upload fallback), 300s for full flow completion. If exceeded → `{ status: "failed", error: "timeout" }` → stop container.

**SSE disconnect cleanup:** The OAuth SSE endpoint registers an `AbortController`. On client disconnect (`req.signal.aborted`), the controller triggers: (1) `acpSession.cancel()` if still running, (2) `executor.stop(handle)` to remove the container. This prevents orphaned containers from OAuth flows abandoned mid-way.

### Binary Pipeline for Credential Files

**Problem:** `collect()` converts stdout to UTF-8 string (lossy for binary), and `encrypt()`/`decrypt()` operate on strings. A raw tar.gz blob cannot survive this pipeline without corruption.

**Solution:** base64 encode inside the container, transport as UTF-8-safe text, store as base64-in-encrypted-string.

```
Extract:  tar czf - ... | base64  →  collect() (UTF-8 safe)  →  encrypt(base64text)  →  DB
Restore:  decrypt(DB)  →  base64text  →  Buffer.from(text,'base64')  →  pipe to tar xzf
```

This reuses `collect()` and `encrypt()`/`decrypt()` without modification. The base64 overhead (~33%) is acceptable for credential directories (typically <1MB, hard limit 10MB pre-encoding).

### Credential File Extraction

After successful auth (OAuth or terminal), credential files are extracted:

```typescript
async function extractCredentials(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  credentialPaths: string[],  // e.g. ['.config/cline/']
): Promise<string> {  // returns base64 text, ready for encrypt()
  // tar + base64 inside container → UTF-8 safe output via collect()
  const result = await collect(executor, handle, [
    'sh', '-c',
    `tar czf - -C /root ${credentialPaths.map(p => `'${p}'`).join(' ')} | base64`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract credentials: ${result.stderr}`);
  }
  return result.stdout.trim();  // base64 string — safe for encrypt()
}
// Store: encrypt(base64text) → agent_secrets.encryptedValue
```

**Credential path resolution (priority order):**

1. **From ACP `authMethods` response:** If the auth method includes `credentialPaths` (proposed ACP extension), use those directly. This is the ideal source — the agent knows its own credential locations.
2. **From `agent_secrets.credentialPaths`:** If credentials were previously extracted, reuse the same paths.
3. **From `resolveAcpConfig` fallback:** Static defaults for known agents. These are last-resort values used only when ACP doesn't provide paths:

```typescript
'cline':    { ..., credentialPaths: ['.config/cline/'] },
'opencode': { ..., credentialPaths: ['.opencode/'] },
'kilocode': { ..., credentialPaths: ['.config/kilo/'] },
'codex':    { ..., credentialPaths: ['.config/codex/'] },
'cursor':   { ..., credentialPaths: ['.config/cursor/'] },
```

The static fallback is a maintenance burden, but it's only needed until agents adopt the `credentialPaths` extension. When an agent's ACP response includes paths, the fallback is ignored.

### Runtime Auth Delivery

In `Scheduler.executeLane`, after `executor.start()` and before `AcpSession.start()`:

```
1. executor.start({ env: lane.env })       — env vars from api_key secrets injected here
2. restoreCredentialFiles(executor, handle) — decrypt base64 → binary tar → tar xzf via stdin pipe
3. AcpSession.start()                      — initialize (agent finds credentials on disk / env vars)
4. executeLane continues as normal
```

**`lane.env` construction:** `getDecryptedSecretsForExecutor()` is extended to unpack `api_key` JSON blobs into flat `Record<string, string>`. Example: encrypted `{ "OPENAI_API_KEY": "sk-...", "OPENAI_ORG_ID": "org-..." }` → `{ OPENAI_API_KEY: "sk-...", OPENAI_ORG_ID: "org-..." }`. The flat record is merged into `lane.env` (same as today). `credential_files` secrets are not included in `lane.env` — they're handled separately by `restoreCredentialFiles`.

**No `authenticate()` call at runtime.** Credential files and env vars are pre-placed before AcpSession starts. The agent discovers them during `initialize`. If credentials are missing or expired, the agent reports an error at prompt time, which maps to `task:error` "Auth expired, re-authenticate in settings".

**`restoreCredentialFiles`:**
```typescript
async function restoreCredentialFiles(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  blobs: Array<{ acpMethodId: string; encryptedValue: string }>,
  logger: Logger,
): Promise<void> {
  for (const blob of blobs) {
    const base64text = decrypt(blob.encryptedValue);      // base64 string
    const tarData = Buffer.from(base64text, 'base64');     // binary tar.gz

    // Path traversal protection: --no-absolute-names prevents /etc/passwd overwrites,
    // --no-same-owner prevents UID spoofing. Container is ephemeral (destroyed after run),
    // so blast radius is limited, but defense-in-depth applies.
    const ih = await executor.exec(handle, [
      'tar', 'xzf', '-', '-C', '/root', '--no-absolute-names', '--no-same-owner',
    ]);

    // Collect stderr for logging (tar warnings, permission errors)
    const stderrChunks: Buffer[] = [];
    ih.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    ih.stdout.resume();  // drain stdout (tar produces none for extract)

    ih.stdin.write(tarData);
    ih.stdin.end();
    const exitCode = await ih.wait();

    const stderr = Buffer.concat(stderrChunks).toString();
    if (stderr) {
      logger.warn(`tar restore for ${blob.acpMethodId}: ${stderr}`);
    }
    if (exitCode !== 0) {
      throw new Error(`Failed to restore credentials for ${blob.acpMethodId}: exit ${exitCode}`);
    }
  }
}
```

**Upload-time validation:** Before saving a credential file blob, validate the tar contents.
`collect()` can't be used here — it closes stdin immediately and doesn't accept input data. Use `executor.exec` directly:
```typescript
// List tar contents without extracting — using InteractiveHandle directly
const ih = await executor.exec(handle, ['tar', 'tzf', '-']);
ih.stdin.write(tarData);
ih.stdin.end();
const chunks: Buffer[] = [];
ih.stdout.on('data', (c: Buffer) => chunks.push(c));
ih.stderr.resume();
await ih.wait();
const paths = Buffer.concat(chunks).toString().split('\n').filter(Boolean);
// Reject if any path is absolute or contains '..'
if (paths.some(p => p.startsWith('/') || p.includes('..'))) {
  throw new Error('Credential archive contains unsafe paths');
}
```

**Blob ordering:** Blobs are restored in `createdAt` order (oldest first). If two blobs contain overlapping paths (e.g. two methods writing to `.config/`), the newer blob's files overwrite the older. If overlap is detected at save time (comparing `credentialPaths` arrays across methods for the same executor), a warning is logged.
**Pre-flight auth check (`POST /api/runs`):**

1. If `authMethods === null` and `resolveAcpConfig().requiresAuth === true` → 400 "Run auth discovery first for {agentName}"
2. For each `env_var` method in `authMethods`: check that a secret row exists. Then decrypt the JSON object and verify that every var where `optional !== true` has a non-empty value. Missing required var → 400 "Agent {name} missing required credential: {varName} for method {methodId}"
3. For each `agent`/`terminal` method: if no `credential_files` secret exists → **warn in response but allow the run to proceed**. Rationale: some agents work partially without credentials (e.g. free-tier models), and Litmus can't know if credentials are truly required — the agent will report an auth error at prompt time if they are, which maps to `task:error` non-retryable.

This replaces the old `loadAuthSchema()` check.

**`POST /api/runs` response contract** (extends current `{ runId }`):
```typescript
// 201 Created (success, possibly with warnings):
{ runId: string, warnings?: string[] }
// Example with warning:
{ runId: "uuid", warnings: ["Agent Cline: credentials not configured for cline-oauth"] }
// 400 Bad Request (hard block):
{ error: string }
```
Warnings array is only present when non-empty. Frontend can display warnings as dismissible notices.

### Delete auth.json

Remove all `web/agents/*/auth.json` files and `web/src/lib/agents/auth-schema.ts`. The `loadAuthSchema()` function and all references to it are deleted. `POST /api/runs` validation reads from `agent_executors.authMethods` instead.

### resolveAcpConfig Extension

Extend `AcpAgentConfig`:

```typescript
interface AcpAgentConfig {
  acpCmd: string[];
  requiresAuth: boolean;
  capabilities: {
    auth?: { terminal?: boolean };  // opt-in to terminal auth methods
    [key: string]: unknown;
  };
  credentialPaths?: string[];  // relative to $HOME in container (fallback)
}
```

**Extraction:** `resolveAcpConfig` is currently a `private` method on `Scheduler` (`scheduler.ts:45`). Extract it into a standalone exported function in `web/src/lib/orchestrator/acp-config.ts` so that both `Scheduler` and `POST /api/agents/[id]/models` can use it. The function signature is unchanged: `(agentType: string) => AcpAgentConfig`.

**Capabilities change:** All entries now set `capabilities: { auth: { terminal: true } }`. Note: `capabilities` already exists on `AcpAgentConfig` as `Record<string, unknown>` — this change narrows the type to include the specific `auth.terminal` field while keeping the existing open-ended `Record` for forward compatibility.

`AcpSession.start()` passes `acpConfig.capabilities` as `clientCapabilities` to `connection.initialize()`, replacing the current hardcoded `{}`.

---

## What Does NOT Change

- Encryption mechanism (AES-256-GCM) — same key, same `encrypt()`/`decrypt()` string API (binary data handled via base64 encoding)
- `getDecryptedSecretsForExecutor()` — extended but not broken
- Docker executor — no changes
- Existing `api_key` secrets in DB — migrated: `envVar` column dropped, value moved into keyed JSON in `encryptedValue`; `acpMethodId` set from old `envVar` as synthetic ID, reconciled to real ACP method ID on first discovery
- `collect()` utility — used for credential extraction (with base64 encoding for binary safety)
- SSE events, Reconciler, EventBus — unchanged
- Model discovery shell path (models.sh) — unchanged

## What Changes

- **`AcpSession`:** `clientCapabilities` updated from `{}` to `{ auth: { terminal: true } }` to opt-in to terminal auth methods. `authenticate()` method added (thin wrapper over `connection.authenticate`). Core flow (start, prompt, cancel, close) unchanged.
- **`POST /api/runs` validation:** `loadAuthSchema()` replaced with `authMethods`-based validation from DB.

---

## Files to Modify

| File | Change |
|---|---|
| `web/src/db/schema.ts` | Add `authMethods` + `authMethodsDiscoveredAt` to `agentExecutors`; extend `agent_secrets` with `acpMethodId`, `credentialPaths` (jsonb), new `authType` values |
| `web/drizzle/NNNN_acp_auth.sql` | Migration for schema changes |
| `web/src/lib/orchestrator/types.ts` | Add `credentialPaths` to `AcpAgentConfig` |
| `web/src/lib/orchestrator/acp-config.ts` | **New** — extracted `resolveAcpConfig()` (from `Scheduler` private → standalone export) with `capabilities.auth.terminal` and `credentialPaths` |
| `web/src/lib/orchestrator/scheduler.ts` | Import `resolveAcpConfig` from `acp-config.ts`; add `restoreCredentialFiles` before AcpSession.start |
| `web/src/lib/orchestrator/acp-session.ts` | Add `authenticate()` method; change `clientCapabilities` from `{}` to `acpConfig.capabilities` (passed from `resolveAcpConfig`) |
| `web/src/lib/agents/secrets.ts` | Extend for `credential_files` type (base64 blob handling) |
| `web/src/lib/agents/auth-discovery.ts` | **New** — extract + cache authMethods from ACP initialize |
| `web/src/lib/agents/oauth-capture.ts` | **New** — BROWSER=echo + URL capture + device code detection |
| `web/src/lib/agents/credential-files.ts` | **New** — extract/restore credential file blobs |
| `web/src/app/api/agents/[id]/models/route.ts` | Add ACP initialize → authMethods caching during discovery |
| `web/src/app/api/agents/[id]/auth/route.ts` | Rewrite: read from cached authMethods, support 3 authTypes |
| `web/src/app/api/agents/[id]/auth/oauth/route.ts` | **New** — OAuth capture SSE endpoint |
| `web/src/components/settings/agent-auth-section.tsx` | Rewrite: dynamic UI from authMethods, three method type renderers |
| `web/src/app/api/runs/route.ts` | Replace `loadAuthSchema()` validation with `authMethods`-based check; add `authMethods === null` hard block for `requiresAuth` agents |
| `web/src/lib/agents/auth-schema.ts` | **Delete** |
| `web/agents/cursor/auth.json` | **Delete** |
| `web/agents/mock/mock-acp-server.py` | Extend: add `authMethods` in initialize response + `authenticate` handler (prints mock URL to stdout for OAuth capture testing). Mock does not use auth.json — it's self-contained Python. |
| `web/src/instrumentation.ts` (or startup hook) | Add startup cleanup: list Docker containers with label `litmus-oauth=true` older than 10 min, remove them. Prevents orphaned OAuth containers after server crash. |

## Existing Code to Reuse

| Code | Location | Reuse |
|---|---|---|
| `encrypt` / `decrypt` | `lib/encryption.ts` | For credential file blobs (base64-encoded before encrypt, decoded after decrypt) |
| `getDecryptedSecretsForExecutor` | `lib/agents/secrets.ts` | Extended for new types |
| `collect()` | `lib/orchestrator/collect.ts` | For tar extract/restore in containers |
| `DockerExecutor.exec` | `lib/orchestrator/docker-executor.ts` | InteractiveHandle for stdin pipe |
| `AcpSession.start` / `close` | `lib/orchestrator/acp-session.ts` | For OAuth capture container |

---

## Error Handling

### Auth Discovery Errors

| Situation | Behavior |
|---|---|
| ACP initialize fails | `authMethods` = null in DB, model discovery continues, UI shows "Run discovery" hint |
| Agent returns empty authMethods | Save `[]` — agent doesn't require ACP auth |
| Container fails to start | Discovery fails entirely, error to user |

### OAuth Capture Errors

| Situation | Behavior |
|---|---|
| URL not captured within 30s | SSE: `{ status: "url_capture_failed" }` → UI: "Upload credential files instead" |
| Device code expired | Agent error → UI: "Authentication timed out. Try again" |
| Credentials not at expected path | Warning: "Auth may have succeeded but credentials not found at {path}" |
| Overall timeout (300s, configurable) | Stop container → SSE: `{ status: "failed", error: "timeout" }` → UI: "Authentication timed out" |

### Runtime Auth Errors

| Situation | Behavior |
|---|---|
| Credential decrypt fails | `task:error` "Failed to restore credentials", non-retryable within run |
| tar restore fails (exit code ≠ 0) | `task:error` "Failed to restore credentials for {methodId}", non-retryable within run |
| Credentials expired / invalid | Agent returns error at prompt → `task:error` "Auth expired, re-authenticate in settings", non-retryable within run |
| `env_var` method missing required vars | `POST /api/runs` returns 400 "Agent {name} missing required credential: {varName}" |
| `agent`/`terminal` credentials not configured | `POST /api/runs` returns 201 with `warnings` array (see pre-flight check) — run proceeds |
| `authMethods === null` + `requiresAuth` | `POST /api/runs` returns 400 "Run auth discovery first for {agentName}" |

**Principle:** auth errors are non-retryable **within the same run** — credentials don't change between retry attempts. However, credential expiry errors prompt re-authentication in the UI, after which a **new run** can succeed.

**`authMethods == null` + auth configuration attempt:** If a user navigates to auth settings for an agent whose `authMethods` is null (discovery never ran or failed), the UI shows: "Auth methods not yet discovered. Run model discovery first." with a "Discover" button that triggers `POST /api/agents/[id]/models`.

---

## Authentication & Authorization

Litmus is a **single-tenant local tool** — one user per instance, no multi-user auth system. All API routes (existing and new) are **localhost-only**, accessed from the same-origin React UI. There is no session/token-based auth layer.

The new auth endpoints (`/auth`, `/auth/oauth`) manage **agent credentials** (API keys, OAuth tokens), not user credentials. They follow the same guard model as existing sensitive endpoints (`POST /api/runs`, `PUT /api/agents/[id]`): no application-level auth, trust the local user.

**If Litmus gains multi-user support in the future**, all `/auth` endpoints must be gated behind user authentication + ownership verification (user owns the agent). The `agent_secrets` table would need a `userId` column. This is out of scope for the current design.

**Negative test:** Verify that `/auth` endpoints return `404` (not a server error) when the agent ID doesn't exist. This is the only "unauthorized" case in single-tenant mode.

---

## Verification

### Unit Tests
1. `extractAuthMethods` — parse InitializeResponse, preserve raw types (env_var/terminal/agent), preserve terminal `args`/`env` fields, preserve env_var `vars[]` with `optional`/`secret`/`label`, determine `oauthCapable` with known-ID whitelist (`"chatgpt"`, `*oauth*`). Verify `link` NOT expected on `agent` type.
2. `restoreCredentialFiles` — base64 decode + tar binary stdin pipe, `--no-absolute-names --no-same-owner` flags, stderr logging, exit code handling
3. `captureOAuthUrl` — URL extraction regex from stdout/stderr, device code pattern matching with ±2 line window
4. `resolveAuthDelivery` — map authType → delivery mechanism (env_var→env vars, credential_files→tar restore)
5. `reconcileAcpMethodIds` — match existing secrets (synthetic acpMethodId) to discovered authMethods by var names in decrypted JSON
6. **Binary blob round-trip** — `tar czf | base64` → `encrypt()` → `decrypt()` → `Buffer.from(,base64)` → binary identical to original tar
7. **Path traversal rejection** — tar archive with `../../etc/passwd` or absolute `/etc/passwd` → rejected at upload time

### Integration Tests
8. Model discovery + auth caching → authMethods + authMethodsDiscoveredAt in DB, raw ACP types preserved
9. **Capability gating** — initialize with `clientCapabilities: { auth: { terminal: true } }` → agent returns terminal methods; without → agent omits them
10. Env var auth full cycle — save → run → container env var → agent works
11. Credential files round-trip — upload tar.gz → base64 → encrypt → DB → decrypt → base64 decode → restore → files present in container with correct content
12. OAuth capture with mock agent — mock emits URL → `captureOAuthUrl` extracts → credential files extracted post-auth
13. SSE disconnect cleanup — client disconnects mid-OAuth → container is stopped, no orphans
14. Blob size limit enforcement — upload >10MB tar → 413 error
15. Concurrent auth attempts — two simultaneous OAuth flows for same executor → second returns 409
16. DB migration — existing `api_key` secrets get synthetic `acpMethodId`, new unique index works, single-transaction rollback works
17. Pre-flight auth validation — env_var missing required var → 400; `authMethods === null` + `requiresAuth` → 400; env_var method with 2 vars, 1 optional — only non-optional validated; agent/terminal without credentials → 201 with `warnings` array
18. **`POST /api/runs` no longer imports `loadAuthSchema`** — regression test ensuring `auth-schema.ts` is fully deleted

### Contract Tests
19. **ACP auth schema compatibility** — verify `AuthenticateRequest` shape matches SDK types (only `methodId` + `_meta`). This catches SDK updates that add/remove fields.
20. **`AuthMethod` union discrimination** — verify all three ACP types (`env_var`, `terminal`, `agent`) parse correctly from mock JSON

### E2E / Manual
21. Complete auth flow with mock agent — discovery → configure `env_var` → start run → `task:completed`
22. Manual QA: Real OAuth flow per agent during onboarding (`BROWSER=echo` verified per agent; URL capture success/failure documented)

---

## Security

- **Access control:** `agent_secrets` is accessed only through `getDecryptedSecretsForExecutor()` which requires an `executorId`. No bulk export endpoint. All secret values are encrypted at rest (AES-256-GCM).
- **Rate limiting:** `POST /api/agents/[id]/auth/oauth` limited to 1 concurrent flow per executor (in-memory `Map<executorId, AbortController>`). Litmus is single-instance single-tenant — in-memory lock is sufficient. If multi-instance deployment is added, this becomes a DB-level advisory lock.
- **Audit:** Auth events logged at `info` level: `auth.configured(executorId, methodId, type)`, `auth.deleted(executorId, methodId)`, `auth.oauth.started(executorId, methodId)`, `auth.oauth.completed/failed(executorId, methodId)`. No secret values in logs.
- **Blob size limit:** 10MB max for credential file uploads. Enforced at the API route level before encryption.
- **Multi-tenant:** Litmus is single-tenant (one user per instance). Secrets are per-executor, not per-user. If multi-tenant is added later, secrets table needs a `userId` column.

## Performance

- `agent_executors.authMethods` is read on every auth page load and run validation. Since it's a small jsonb column on an already-indexed table (`id` primary key), no additional index is needed.
- `agent_secrets` queries are by `(agentExecutorId)` — covered by the unique index.
- OAuth flows spin up a temporary container (~5s start). This is acceptable for an infrequent settings operation.

---

## Risks

| Risk | Mitigation |
|---|---|
| `BROWSER=echo` not respected by all agents | Three-tier fallback: (1) ACP notification, (2) stdout/stderr scan, (3) credential file upload. 30s URL capture timeout before showing upload fallback. Each agent tested at onboarding. |
| Device code flow not used by all OAuth providers | Credential file upload as universal fallback |
| Credential file paths change between agent versions | Priority: ACP response paths > saved paths > static fallback. Static fallback updated at onboarding. |
| tar.gz blob may be large (SQLite DB files in credential dirs) | 10MB limit enforced at API route (pre-base64); 413 if exceeded |
| Credentials expired, Litmus can't detect pre-run | Agent reports error at prompt time → `task:error` with re-auth hint. No structured token → no pre-flight expiry check for `credential_files`. |
| ACP `authenticate` semantics vary between agents/adapters | Test each agent; document quirks in README; per-agent smoke test in CI |
| OAuth container left running after SSE disconnect | `AbortController` + cleanup handler stops container on disconnect. On server crash (process kill), `AbortController` won't fire — orphaned containers with `sleep infinity` survive. Mitigated by Docker label-based cleanup: OAuth containers get label `litmus-oauth=true`; on startup, Litmus lists and removes containers with this label older than 10 min. |
| Concurrent OAuth attempts for same executor | In-memory lock (single-instance); second attempt returns 409 |
| ACP `AuthMethodTerminal` is UNSTABLE/experimental | Marked in SDK. Litmus stores raw `authMethods` — if type changes, re-run discovery to refresh. |
| Docker exec stdout may not capture subprocess output for URL | Best-effort approach with 30s timeout; credential file upload always works as fallback |
| tar path traversal in uploaded credential files | Upload-time validation rejects absolute paths and `..`; restore uses `--no-absolute-names --no-same-owner` |
| Binary corruption in credential blob pipeline | base64 encode in container before `collect()` → `encrypt()` → DB. Round-trip integrity verified by integration test. |

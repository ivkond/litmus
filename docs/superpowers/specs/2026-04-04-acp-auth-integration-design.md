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

Replace static `auth.json` with **ACP-driven auth discovery**. At model discovery time, Litmus performs an ACP `initialize` handshake, caches the agent's declared `authMethods`, and dynamically renders auth UI. Three auth types are supported:

| ACP authMethod type | Delivery mechanism | User experience |
|---|---|---|
| `env_var` | Env vars at container start | Password input field (same as today) |
| `agent` (OAuth-capable) | Device code flow / manual code paste | "Sign in" button → browser OAuth → auto-completion |
| `agent` (terminal-only) | Credential file upload → encrypted blob in DB | Instructions + file upload |

### ACP Auth Protocol Summary

The `InitializeResponse` includes an `authMethods` array. Each entry has:
- `id: string` — unique method identifier (e.g. `"openai-api-key"`, `"cline-oauth"`)
- `type?: "env_var" | "terminal"` — when absent, treated as `"agent"` (interactive/OAuth)
- `name: string` — human-readable label
- `description?: string` — how to authenticate
- `vars?: AuthEnvVar[]` — for `env_var` type: which env vars to set (each has `name: string`)
- `link?: string` — URL to credential acquisition page

After discovery, the client can call `authenticate({ methodId })` to initiate auth. For `env_var` methods, the agent simply checks if the env vars are set. For `agent` methods, the agent attempts interactive auth (OAuth, browser, terminal).

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

## Architecture

### Data Model Changes

**`agent_executors` table — add column:**
```
authMethods: jsonb('auth_methods')  -- cached from ACP InitializeResponse
```

Populated during model discovery. `null` = discovery not yet run.

**`agent_secrets` table — extend:**

Current schema:
```
agentExecutorId, envVar, encryptedValue, authType ('api_key'), createdAt, updatedAt
```

New schema:
```
agentExecutorId, envVar, encryptedValue, authType, acpMethodId, credentialPaths, createdAt, updatedAt
```

Changes:
- `authType` enum: `'api_key' | 'oauth_token' | 'credential_files'`
- `acpMethodId: text` — links to `authMethods[].id` from ACP (e.g. `"cline-oauth"`)
- `credentialPaths: text` — for `credential_files`: comma-separated paths relative to `$HOME` that were archived
- `envVar` nullable — only set for `api_key` type

Storage by type:
- `api_key`: `envVar` = env var name, `encryptedValue` = encrypted API key string
- `oauth_token`: `envVar` = null, `encryptedValue` = encrypted JSON `{ accessToken, refreshToken, expiresAt }`
- `credential_files`: `envVar` = null, `encryptedValue` = encrypted tar.gz blob of credential directory

### Auth Discovery Flow

Extends `POST /api/agents/[id]/models` (model discovery endpoint):

```
1. executor.start()                    — start container
2. AcpSession.start()                  — ACP initialize
3. response.authMethods → DB           — cache in agent_executors.authMethods
4. acpSession.close()                  — close ACP connection
5. collect(executor, handle, models.sh) — existing model discovery
6. executor.stop()                     — stop container
```

If ACP initialize fails (binary missing, handshake error), `authMethods` is set to `null` and model discovery continues via `models.sh` as before.

### Auth API Routes

**`GET /api/agents/[id]/auth`** — returns auth methods + configured status:

```typescript
interface AuthMethodStatus {
  id: string;                    // ACP method ID
  type: 'env_var' | 'agent';    // normalized (no 'terminal' — mapped to 'agent')
  name: string;
  description?: string;
  vars?: { name: string }[];     // for env_var
  link?: string;
  configured: boolean;           // secret exists in DB for this method
  maskedValue?: string;          // last 4 chars (env_var only)
  oauthSupported: boolean;       // heuristic: can Litmus handle OAuth capture?
}
```

Source: reads `agent_executors.authMethods` from DB. If null → returns empty array with hint to run discovery.

`oauthSupported` heuristic: `type === 'agent'` AND (`description` contains "OAuth" / "browser" / "sign in" OR `link` is present). This determines whether UI shows "Sign in" button vs "Upload credentials".

**`PUT /api/agents/[id]/auth`** — save a secret:

Request body varies by type:
```typescript
// env_var:
{ methodId: "openai-api-key", type: "env_var", envVar: "OPENAI_API_KEY", value: "sk-..." }

// credential_files:
{ methodId: "kilo-login", type: "credential_files", files: <multipart tar.gz> }

// oauth_token (set programmatically after OAuth capture):
{ methodId: "cline-oauth", type: "oauth_token", token: { accessToken, refreshToken, expiresAt } }
```

**`DELETE /api/agents/[id]/auth`** — remove a secret:
```typescript
{ methodId: "cline-oauth" }
```

**`POST /api/agents/[id]/auth/oauth`** — initiate OAuth capture flow:
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
2. `AcpSession.start()` → `initialize`
3. Call `connection.authenticate({ methodId })`
4. Agent attempts to "open browser" → `echo` prints URL to container stdout
5. Litmus captures URL from `proc.stderr` stream (ACP agents typically write user-facing messages to stderr)
6. **Device code detection:** parse output for pattern matching — URL + alphanumeric code
7. Stream to frontend via SSE: `{ status: "awaiting_browser", url, deviceCode? }`

**Frontend:**
1. Receives `url` + optional `deviceCode`
2. Opens URL in new browser tab
3. If `deviceCode` present → shows code for user to enter on provider page
4. Agent polls provider → receives token → saves to credential directory
5. Litmus detects auth completion (authenticate() resolves or agent writes credentials)
6. Extracts credential files: `collect(executor, handle, ['tar', 'czf', '-', ...credentialPaths])`
7. Encrypts tar blob → saves to `agent_secrets` with `authType: 'credential_files'`
8. Stops container
9. SSE: `{ status: "completed" }`

**If device code flow not detected (redirect-based OAuth):**
- URL is shown to user
- User completes OAuth → browser redirects to `localhost:PORT/callback` → error page in browser
- URL bar contains `?code=AUTH_CODE`
- UI prompts: "Paste the authorization code from the URL"
- User pastes code → Litmus writes to container stdin (or stores as credential)
- Fallback: if code paste doesn't work → "Upload credential files" option

**Timeout:** 120s for entire OAuth flow. If exceeded → `{ status: "failed", error: "timeout" }` → stop container.

### Credential File Extraction

After successful auth (any type), credential files are extracted:

```typescript
async function extractCredentials(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  credentialPaths: string[],  // e.g. ['.config/cline/']
): Promise<Buffer> {
  // tar the credential directories from $HOME
  const tarResult = await collect(executor, handle, [
    'tar', 'czf', '-', '-C', '/root', ...credentialPaths,
  ]);
  if (tarResult.exitCode !== 0) {
    throw new Error(`Failed to extract credentials: ${tarResult.stderr}`);
  }
  return Buffer.from(tarResult.stdout, 'binary');
}
```

Credential paths per agent (in `resolveAcpConfig`):
```typescript
'cline':    { ..., credentialPaths: ['.config/cline/'] },
'opencode': { ..., credentialPaths: ['.opencode/'] },
'kilocode': { ..., credentialPaths: ['.config/kilo/'] },
'codex':    { ..., credentialPaths: ['.config/codex/'] },
'cursor':   { ..., credentialPaths: ['.config/cursor/'] },
```

### Runtime Auth Delivery

In `Scheduler.executeLane`, after `executor.start()` and before `AcpSession.start()`:

```
1. executor.start({ env: lane.env })       — env vars (api_key secrets) injected here
2. restoreCredentialFiles(executor, handle) — decrypt blob → tar xzf via stdin pipe
3. AcpSession.start()                      — initialize (agent finds credentials)
4. authenticate({ methodId }) if needed    — for oauth_token type
5. executeLane continues as normal
```

**`restoreCredentialFiles`:**
```typescript
async function restoreCredentialFiles(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  blobs: Array<{ encryptedValue: string }>,
): Promise<void> {
  for (const blob of blobs) {
    const tarData = decrypt(blob.encryptedValue);  // AES-256-GCM
    const ih = await executor.exec(handle, ['tar', 'xzf', '-', '-C', '/root']);
    ih.stdout.resume();  // drain stdout
    ih.stderr.resume();
    ih.stdin.write(tarData);
    ih.stdin.end();
    await ih.wait();
  }
}
```

**When to call `authenticate()`:** Only if `agent_secrets` contains an `oauth_token` entry for this executor. In that case, call `connection.authenticate({ methodId: secret.acpMethodId })` after initialize. For `credential_files` and `api_key`, the agent finds credentials automatically (files on disk / env vars set).

### Delete auth.json

Remove all `web/agents/*/auth.json` files and `web/src/lib/agents/auth-schema.ts`. The `loadAuthSchema()` function and all references to it are deleted. `POST /api/runs` validation reads from `agent_executors.authMethods` instead.

### resolveAcpConfig Extension

Add `credentialPaths` to `AcpAgentConfig`:

```typescript
interface AcpAgentConfig {
  acpCmd: string[];
  requiresAuth: boolean;
  capabilities?: Record<string, unknown>;
  credentialPaths?: string[];  // relative to $HOME in container
}
```

---

## What Does NOT Change

- Encryption mechanism (AES-256-GCM) — same key, same algorithm
- `getDecryptedSecretsForExecutor()` — extended but not broken
- Docker executor — no changes
- `collect()` utility — used for credential extraction/restoration
- AcpSession core (start, prompt, cancel, close) — unchanged
- SSE events, Reconciler, EventBus — unchanged
- Model discovery shell path (models.sh) — unchanged

---

## Files to Modify

| File | Change |
|---|---|
| `web/src/db/schema.ts` | Add `authMethods` to `agentExecutors`; extend `agent_secrets` with `acpMethodId`, `credentialPaths`, new `authType` values |
| `web/drizzle/NNNN_acp_auth.sql` | Migration for schema changes |
| `web/src/lib/orchestrator/types.ts` | Add `credentialPaths` to `AcpAgentConfig` |
| `web/src/lib/orchestrator/scheduler.ts` | Add `restoreCredentialFiles` before AcpSession.start; update `resolveAcpConfig` with credential paths |
| `web/src/lib/orchestrator/acp-session.ts` | Add `authenticate()` method (thin wrapper over connection.authenticate) |
| `web/src/lib/agents/secrets.ts` | Extend for credential_files and oauth_token types |
| `web/src/lib/agents/auth-discovery.ts` | **New** — extract + cache authMethods from ACP initialize |
| `web/src/lib/agents/oauth-capture.ts` | **New** — BROWSER=echo + URL capture + device code detection |
| `web/src/lib/agents/credential-files.ts` | **New** — extract/restore credential file blobs |
| `web/src/app/api/agents/[id]/models/route.ts` | Add ACP initialize → authMethods caching during discovery |
| `web/src/app/api/agents/[id]/auth/route.ts` | Rewrite: read from cached authMethods, support 3 authTypes |
| `web/src/app/api/agents/[id]/auth/oauth/route.ts` | **New** — OAuth capture SSE endpoint |
| `web/src/components/settings/agent-auth-section.tsx` | Rewrite: dynamic UI from authMethods, three method type renderers |
| `web/src/lib/agents/auth-schema.ts` | **Delete** |
| `web/agents/cursor/auth.json` | **Delete** |
| `web/agents/mock/mock-acp-server.py` | Extend: add authMethods + authenticate handler |

## Existing Code to Reuse

| Code | Location | Reuse |
|---|---|---|
| `encrypt` / `decrypt` | `lib/encryption.ts` | For credential file blobs |
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
| `BROWSER=echo` not respected | Timeout 30s → UI: "Could not capture URL. Try credential file upload" |
| Device code expired | Agent error → UI: "Authentication timed out. Try again" |
| User pastes invalid code | Agent rejects → UI: "Invalid code. Try again" |
| Credentials not at expected path | Warning: "Auth may have succeeded but credentials not found at {path}" |
| Timeout (120s) | Stop container → UI: "Authentication timed out" |

### Runtime Auth Errors

| Situation | Behavior |
|---|---|
| Credential decrypt fails | `task:error` "Failed to restore credentials", non-retryable |
| `authenticate()` rejected | `task:error` "Authentication failed: {reason}", non-retryable |
| Token expired | Agent returns error at prompt → `task:error` "Auth expired, re-authenticate in settings" |
| Required env var missing | `POST /api/runs` returns 400 (existing validation, updated to read from authMethods) |

**Principle:** auth errors are always non-retryable. Credentials don't change between retry attempts.

---

## Verification

1. **Unit:** `extractAuthMethods` — parse InitializeResponse, normalize types, detect oauthSupported
2. **Unit:** `restoreCredentialFiles` — tar blob stdin pipe, correct tar command
3. **Unit:** `captureOAuthUrl` — URL extraction from stdout, device code pattern matching
4. **Unit:** `resolveAuthDelivery` — map authType → delivery mechanism
5. **Integration:** Model discovery + auth caching → authMethods in DB
6. **Integration:** Env var auth full cycle — save → run → container env var → agent works
7. **Integration:** Credential files round-trip — upload → encrypt → DB → decrypt → restore → files present
8. **Integration:** OAuth capture with mock agent — mock prints URL → captureOAuthUrl extracts
9. **E2E:** Complete auth flow with mock agent — discovery → configure env_var → start run → task:completed
10. **Manual QA:** Real OAuth flow per agent during onboarding

---

## Risks

| Risk | Mitigation |
|---|---|
| `BROWSER=echo` not respected by all agents | Fallback to credential file upload; test each agent at onboarding |
| Device code flow not used by all OAuth providers | Manual code paste fallback from redirect URL |
| Credential file paths change between agent versions | credentialPaths in resolveAcpConfig, update at onboarding |
| tar.gz blob may be large (SQLite DB files in credential dirs) | Limit blob size to 10MB, warn if exceeded |
| Token expiry not visible to Litmus | Agent reports error at prompt time; UI can show "re-authenticate" hint |
| ACP `authenticate` semantics vary between agents/adapters | Test each agent; document quirks in README |

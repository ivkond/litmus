# ACP Integration into Scheduler/Runner — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Approach:** ACP SDK Client in Scheduler. Target: full replacement of `run.sh` with ACP for all agents. Delivered incrementally — each phase compiles and passes tests. Note: Phases 1-2 pass existing tests (no ACP runtime path yet); Phase 3 introduces `run-acp-lifecycle.test.ts` which becomes the ACP integration proof gate from that point on.

## Problem

The orchestrator runs coding agents via shell scripts (`run.sh`) inside Docker containers, capturing raw stdout/stderr and exit codes. This is fragile:

- Agent result is opaque: Scheduler sees only exitCode + raw stdout/stderr, with no structured indication of what the agent did or why it stopped
- No structured error semantics — only magic exit codes (2 = infra error, 124 = timeout)
- Each new agent requires a bespoke shell script (`run.sh`) wiring CLI flags, which breaks on CLI updates
- Token usage, tool calls, and agent plans are invisible to the orchestrator — no telemetry path exists

> **Note:** The Python CLI (`agents.py`) has its own stdout parsers (`_parse_lines`, `_parse_aider`, `_parse_cursor`), but the web orchestrator does not use them — it relies entirely on the exit-code + `test-results.json` flow. This spec addresses the web orchestrator only.

## Solution

Replace stdout-parsing with **Agent Client Protocol (ACP)** — JSON-RPC 2.0 over stdio. All 6 target agents have ACP protocol support (verified below); runtime readiness (CLIs installed, env wired, smoke-tested) is delivered in Phase 4. This spec covers the orchestrator-side ACP integration + mock agent.

ACP support by agent:

| Agent | ACP command | Binary | In runtime? | Source |
|---|---|---|---|---|
| Cursor | `cursor agent --acp` | `cursor` | Yes (Dockerfile line 10) | [cursor.com/blog/jetbrains-acp](https://cursor.com/blog/jetbrains-acp) |
| Claude Code | `claude --acp` | `claude` | **No** — must install | [zed-industries/claude-agent-acp](https://github.com/zed-industries/claude-agent-acp) |
| Codex | `codex acp` | `codex` | **No** — must install | [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) |
| OpenCode | `opencode acp` | `opencode` | **No** — must install | [opencode.ai/docs/acp](https://opencode.ai/docs/acp/) |
| Cline | `cline --acp` | `cline` | **No** — must install | [docs.cline.bot/cline-cli/acp-editor-integrations](https://docs.cline.bot/cline-cli/acp-editor-integrations) |
| KiloCode | `kilo acp` | `kilo` | **No** — must install | [deepwiki.com/Kilo-Org/kilocode/13.3-acp-protocol](https://deepwiki.com/Kilo-Org/kilocode/13.3-acp-protocol) |

**Current runtime:** `litmus/runtime-python` (Dockerfile: `web/agents/runtime/Dockerfile`) contains only `cursor` CLI. All other agent binaries must be added to this image in Phase 4 (single fat image — see Runtime Prerequisites).

**Protocol:** ACP v0.11.4, [spec](https://agentclientprotocol.com/protocol/overview), TypeScript SDK: [@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk).

### Relationship to Phase 2 Run-Engine Spec

This spec supersedes the `run.sh` contract defined in `docs/superpowers/specs/2026-03-27-web-phase2-run-engine-design.md` (sections: "Script architecture", key decision row "Reference agent", deviation #1 "Script split"). Specifically:

- **`run.sh` superseded by ACP for currently onboarded agents** (`cursor`, `mock`) — the `init.sh` + `run.sh` + `test.sh` split becomes `init.sh` + ACP session + `test.sh`. Future agents adopt ACP upon onboarding; their `run.sh` scripts (if any) are replaced at that point
- **Mock agent contract changes** — `mock/run.sh` (copy solution files) becomes `mock-acp-server.py` (same logic, ACP protocol)
- **`models.sh` unchanged** — model discovery stays as shell scripts via `collect`
- **E2E test path preserved** — `run-pipeline.test.ts` continues to use `agentSlug: 'mock'`; only the execution mechanism changes

The Phase 2 spec's orchestrator architecture (Scheduler, DockerExecutor, Reconciler, EventBus) remains the foundation. This spec modifies the agent communication layer only.

---

## Architecture

### New Types

**File:** `web/src/lib/orchestrator/types.ts`

```typescript
// ---- ACP Agent Result ----

/** Unified structured result from an ACP agent session */
interface AgentResult {
  stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'error';
  content: string;
  toolCalls: AgentToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    durationMs: number;
  };
}

interface AgentToolCall {
  name: string;
  status: 'completed' | 'failed';
  input: Record<string, unknown>;
  output?: string;
}

/** ACP launch config per agent */
interface AcpAgentConfig {
  acpCmd: string[];
  requiresAuth: boolean;
  capabilities?: Record<string, unknown>;
}

// ---- Interactive Handle ----

/** Bidirectional process handle for ACP JSON-RPC communication */
interface InteractiveHandle {
  stdin: import('stream').Writable;
  stdout: import('stream').Readable;
  stderr: import('stream').Readable;
  wait(): Promise<number>;
  kill(): Promise<void>;
}

// ---- Updated Executor Interface ----
// The `exec` method now returns InteractiveHandle (bidirectional)
// instead of the old ExecResult (collected stdout/stderr).

interface AgentExecutor {
  type: 'docker' | 'host' | 'kubernetes';
  start(config: ExecutorConfig): Promise<ExecutorHandle>;
  exec(handle: ExecutorHandle, cmd: string[], options?: ExecOptions): Promise<InteractiveHandle>;
  stop(handle: ExecutorHandle): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

`ExecResult` stays — used by `collect` return type.

### DockerExecutor — `exec` Returns InteractiveHandle

**File:** `web/src/lib/orchestrator/docker-executor.ts`

The method changes from fire-and-forget (collect all stdout, return ExecResult) to bidirectional streaming (return InteractiveHandle with stdin/stdout/stderr).

Key implementation details:
- Docker attach mode: `AttachStdin: true`, `hijack: true, stdin: true`, `Tty: false`
- Demux multiplexed Docker stream into separate stdout/stderr PassThrough streams
- `InteractiveHandle.stdin` = write to the multiplexed Docker stream (routed to process stdin)
- `InteractiveHandle.wait` = await stream end + `dockerExec.inspect` for exit code
- `InteractiveHandle.kill` = `stream.destroy` + reuse existing `killOrphanedProcesses`
- Timeout management moves to caller (AcpSession or collect utility)

### `collect` Utility

**New file:** `web/src/lib/orchestrator/collect.ts`

Free function that wraps the executor for one-shot commands (init.sh, test scripts, models.sh):

```typescript
async function collect(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  cmd: string[],
  options?: ExecOptions,
): Promise<ExecResult>
```

Behavior:
- Calls `executor.exec` to get InteractiveHandle
- Closes stdin immediately (no input needed)
- Collects stdout/stderr into buffers
- Handles timeout race (if `options.timeoutMs` set): race `wait` vs setTimeout, kill on timeout, return exitCode 124
- Returns `ExecResult { exitCode, stdout, stderr }` — same shape as old method

### AcpSession — ACP Client

**New file:** `web/src/lib/orchestrator/acp-session.ts`

Core ACP integration class. Wraps `@agentclientprotocol/sdk`'s `ClientSideConnection`.

**Lifecycle:** One AcpSession per lane (container). Reused across scenarios within the lane.

```
AcpSession.start(executor, container, acpConfig)
  -> executor.exec(container, acpConfig.acpCmd)
  -> new ClientSideConnection(proc.stdout, proc.stdin)
  -> connection.initialize({ clientInfo, capabilities })
  -> return AcpSession

acpSession.prompt(text, model, workspaceDir, scenarioDir, timeoutMs?)
  -> session/new (if no active session)
  -> session/prompt({
       message,
       configuration: { model, workspaceDir },
       _meta: { scenarioDir }
     })
  -> collect response -> mapResponse -> AgentResult

acpSession.resetSession
  -> clears sessionId (next prompt creates new session)

acpSession.cancel
  -> sends session/cancel notification
  -> waits up to 5s for agent to finish current prompt
  -> force proc.kill if agent doesn't stop

acpSession.close
  -> connection.close (no cancel — session must be idle)
  -> proc.wait
```

**Two distinct shutdown paths:**

1. **`cancel()`** — abort an in-flight prompt. Sends `session/cancel` ACP notification, waits up to 5s for the agent to respond with `stopReason: "cancelled"`, then force-kills if unresponsive. Used by: `acpSession.prompt` on timeout, `scheduler.cancel` for user-initiated cancellation.

2. **`close()`** — graceful shutdown of an idle session. Closes the JSON-RPC connection and waits for the process to exit. Used by: `executeLane` finally block after all scenarios complete normally.

**Response mapping:** `mapResponse` extracts:
- `content` — concatenated text content from response messages
- `toolCalls` — structured tool call records (name, status, input, output)
- `stopReason` — mapped from ACP stop reasons
- `usage` — token counts and duration (if provided)

### Telemetry Persistence

`AgentResult.toolCalls` and `AgentResult.usage` are collected but the DB schema (`run_results`) has no columns for them. Rather than adding a migration, the Scheduler writes a **per-attempt** telemetry file to the session directory:

```
{sessionDir}/acp-telemetry-attempt-1.json
{sessionDir}/acp-telemetry-attempt-2.json
...
```

Each file contains:

```json
{
  "attempt": 1,
  "stopReason": "end_turn",
  "usage": { "inputTokens": 1200, "outputTokens": 800, "durationMs": 4500 },
  "toolCalls": [
    { "name": "fs/write_text_file", "status": "completed", "input": { "path": "main.py" } }
  ]
}
```

Per-attempt naming ensures retry history is preserved (`maxRetries > 0`). All files are automatically uploaded to S3 by `Reconciler.finalize` (which walks the entire session directory). No DB schema change, no SSE event change. Telemetry is queryable via S3/artifact viewer.

**Future:** When dashboard needs inline telemetry, add `usage_json JSONB` column to `run_results` — a single-column migration, not a schema redesign.

### Scheduler Integration

**File:** `web/src/lib/orchestrator/scheduler.ts`

**`executeLane` changes:**
- After `executor.start`, create `AcpSession.start(executor, handle, acpConfig)`
- AcpSession lives for entire lane, passed to each `executeScenario` call
- `resetSession` before each scenario
- `acpSession.close` in finally block (before container stop)

**`executeScenario` changes:**
- `init.sh` invocation: `collect(this.executor, handle, [...])` instead of `this.executor.exec(handle, [...])`
- Agent call: `acpSession.prompt(text, model, sessionDir, scenarioStagedPath, timeout)` replaces shell script invocation
- Test script: `collect(this.executor, handle, [...])` instead of direct executor call
- Error detection: `stopReason` replaces exit code checks

> **`scenarioDir` in ACP:** The current `run.sh` receives `--scenario-dir` so agents can access scenario files (e.g., mock agent needs `solution/`). In ACP mode, `scenarioDir` is passed via the `_meta` extension field in the prompt request (not in `configuration`). ACP spec [explicitly reserves `_`-prefixed fields for custom extensions](https://agentclientprotocol.com/protocol/extensibility) — conformant agents MUST ignore unknown `_meta` fields without error. The mock ACP server reads `_meta.scenarioDir` to locate `solution/`.
>
> **Risk mitigation for `_meta` rejection:** ACP spec requires conformant agents to ignore unknown `_`-prefixed fields. If a specific agent violates this and rejects `_meta.scenarioDir` with a JSON-RPC error, that agent **cannot be onboarded** until the adapter is fixed upstream or a workaround is found (e.g., embedding scenarioDir in the prompt text itself). This is a hard blocker detected during Phase 4 per-agent smoke tests. There is no transparent runtime fallback — container env is set at start time and cannot vary per-prompt within a lane, making env-based fallback architecturally impossible.

**New `resolveAcpConfig` method:**
```
claude-code -> ['claude', '--acp']
codex       -> ['codex', 'acp']
opencode    -> ['opencode', 'acp']
cline       -> ['cline', '--acp']
kilocode    -> ['kilo', 'acp']
cursor      -> ['cursor', 'agent', '--acp']
mock        -> ['python3', '/opt/agent/mock-acp-server.py']
```

> **Note on Cursor:** The binary is `cursor`, not `agent`. Current `run.sh` calls `cursor agent -p ...`; ACP mode is `cursor agent --acp`.
> Commands must match actual binary names installed in the Docker image (see Runtime Prerequisites).

### Error Mapping

| ACP stopReason | Trigger | Scheduler action |
|---|---|---|
| `end_turn` | Agent finished normally | Continue to test phase |
| `error` | Agent internal error | Emit `task:error`, non-retryable |
| `refusal` | Agent refused the prompt | Emit `task:error`, non-retryable |
| `cancelled` (from timeout) | `stepTimeoutSeconds` expired | Emit `task:error` with "Agent timed out", non-retryable |
| `cancelled` (from user cancel) | `scheduler.cancel()` called | Emit `task:cancelled` (existing cancelled semantics) |
| `max_tokens` | Agent ran out of context | Treat as attempt failure, **retryable** |

**Distinguishing cancel sources:** The Scheduler knows whether `cancelled` came from a timeout (inside `acpSession.prompt`) or from user cancellation (the `this.cancelled` flag is set). When `this.cancelled` is true, emit `task:cancelled`; otherwise emit `task:error`.

`max_tokens` is retryable because the agent may have partially written code that passes tests.

### Model Discovery Route

**File:** `web/src/app/api/agents/[id]/models/route.ts`

Replace direct executor call with `collect(docker, handle, [...])`. No other changes — model discovery stays as one-shot shell command (`models.sh`). ACP doesn't standardize model listing.

### Docker Images

- **Delete:** `web/agents/cursor/run.sh` — replaced by ACP
- **Delete:** `web/agents/mock/run.sh` — replaced by mock ACP server (see below)
- **Keep:** `web/agents/init.sh` — workspace preparation is infra, not agent protocol
- **Keep:** `web/agents/*/models.sh` — one-shot model discovery
- **Requirement: API keys via container env.** Currently **NOT wired end-to-end.** The DB has `agent_executors.config` (JSONB) which can store env/keys, but:
  1. `POST /api/runs` reads the executor row yet does not extract `config.env` into `LaneConfig` ([runs/route.ts:45-103](web/src/app/api/runs/route.ts))
  2. `LaneConfig` has no `env` field ([types.ts:198](web/src/lib/orchestrator/types.ts))
  3. `Scheduler.executeLane` passes `env: {}` to `executor.start` ([scheduler.ts:146](web/src/lib/orchestrator/scheduler.ts))

  **This must be fixed before Phase 4** (real agents need API keys to authenticate). Required changes:
  - Add `env?: Record<string, string>` to `LaneConfig`
  - `POST /api/runs`: read `executor.config.env` and include it in the lane config
  - `Scheduler.executeLane`: pass `lane.env ?? {}` to `executor.start({ env })`

  These are small plumbing changes (~3 files, ~10-15 lines of production code + tests) and belong at the beginning of Phase 4, before agent smoke tests. Phase 4 DoD is unreachable without this.

### Runtime Prerequisites

**File:** `web/agents/runtime/Dockerfile`

Current image has only `cursor` CLI. For full ACP support, each agent needs its binary in the image.

**Decision: single fat image.** All 6 agent CLIs are installed into `litmus/runtime-python`. This is the only strategy the current architecture supports — `LaneConfig` has no `image` field, `POST /api/runs` does not build per-agent image references, and `Scheduler.executeLane` hardcodes `litmus/runtime-python`. Per-agent images would require changes to types, API route, and Scheduler that are out of scope for this spec.

The orchestrator only requires that the binary from `acpCmd[0]` is in PATH inside the running container.

### Mock ACP Server

**New file:** `web/agents/mock/mock-acp-server.py`

A minimal Python script that speaks ACP JSON-RPC over stdio, replacing `mock/run.sh`. Python 3.12 is guaranteed to be in the runtime image (`python:3.12-slim` base).

Contract:

1. Responds to `initialize` with `{ capabilities: {} }`
2. Responds to `session/new` with `{ id: "mock-session" }`
3. On `session/prompt`:
   - Reads `configuration.workspaceDir` and `_meta.scenarioDir` from the prompt request (no env fallback — `_meta` is the sole mechanism, see risk mitigation above)
   - Copies `{scenarioDir}/solution/*` into `{workspaceDir}/project/` (same logic as current `mock/run.sh`)
   - Returns response with `stopReason: "end_turn"`, `content: "Mock agent: copied solution"`, empty `toolCalls`
4. Responds to `session/cancel` by exiting cleanly
5. Exits on stdin close

Uses only Python stdlib (`json`, `sys`, `shutil`) — no pip dependencies. Lives at `web/agents/mock/mock-acp-server.py` on the host, mounted into the container at `/opt/agent/mock-acp-server.py` via the existing bind mount (`agentHostDir:/opt/agent:ro` — see `docker-executor.ts:29`).

The `resolveAcpConfig` entry for `mock` is: `['python3', '/opt/agent/mock-acp-server.py']` (path inside container, via bind mount).

E2E tests (`web/e2e/run-pipeline.test.ts`) continue to register `agentSlug: 'mock'` — no changes to the test orchestration, only the execution path changes from shell to ACP.

---

### Cancellation Flow

**File:** `web/src/lib/orchestrator/scheduler.ts`

`cancel` method changes:
- New `activeSessions` map: `Map<string, AcpSession>` alongside existing `activeHandles`
- On cancel: iterate `activeSessions`, call `acpSession.cancel()` (sends `session/cancel`, waits 5s, then kills) before stopping containers
- `executeLane` registers/unregisters sessions in `activeSessions`

```
cancel(runId):
  this.cancelled = true
  for session in activeSessions: await session.cancel()   // abort in-flight prompts
  for handle in activeHandles:   await executor.stop(handle)  // stop containers
  activeSessions.clear()
  activeHandles.clear()
```

### Timeout Semantics

`RunConfig.stepTimeoutSeconds` applies differently per call type:
- **ACP agent calls:** passed as `timeoutMs` to `acpSession.prompt` — triggers `session/cancel` + 5s grace + kill
- **Shell commands (init.sh, tests):** passed as `timeoutMs` to `collect` — triggers kill + exitCode 124

Update the JSDoc comment on `RunConfig.stepTimeoutSeconds` in `types.ts` and the Zod schema comment in `runs/route.ts` to reflect the new semantics.

---

## What Does NOT Change

- `ExecResult` type — stays for `collect` utility
- `EvalResult`, `TestDetail`, `TaskMeta` — untouched
- All SSE event types (`RunEvent` union) — same types and payloads
- `Reconciler.evaluate` / `finalize` — reads test-results.json as before
- `EventBus` / `InMemoryEventBus` — unchanged
- `Scheduler.buildRetryPrompt` — same retry prompt text
- `Scheduler.persistTaskError` — same DB writes
- `Scheduler.resolveTestScript` — same test runner resolution
- Lane concurrency model — same maxConcurrentLanes workers
- DB schema — no migrations needed
- S3 artifacts — same upload path
- `startup.ts` — calls `cleanupOrphans` on DockerExecutor + SQL inserts/updates for stale tasks + matview refresh; none of this uses the `exec` method, so unaffected by interface change
- `agents/[id]/health/route.ts` — only calls `healthCheck`, unaffected

---

## Implementation Phases

### Phase 1: Types + DockerExecutor + collect + migrate all call sites (atomic)

> Changing `AgentExecutor.exec` return type breaks every call site. ALL callers must switch to `collect()` in the same phase, otherwise the project won't compile.

1. `npm install @agentclientprotocol/sdk`
2. Add all new types to `types.ts`: `InteractiveHandle`, `AgentResult`, `AgentToolCall`, `AcpAgentConfig`; update `AgentExecutor` interface
3. Rewrite `DockerExecutor.exec` to return `InteractiveHandle` (hijack mode)
4. Create `web/src/lib/orchestrator/collect.ts` with `collect` function
5. **Migrate all existing call sites to `collect`:**
   - `scheduler.ts` — every `this.executor.exec(handle, [...])` call (init.sh, run.sh, test scripts) becomes `collect(this.executor, handle, [...])`
   - `agents/[id]/models/route.ts` — `docker.exec(handle, [...])` becomes `collect(docker, handle, [...])`
6. Rewrite `docker-executor.test.ts` — all assertions expect InteractiveHandle, not ExecResult
7. Rewrite `scheduler.test.ts` — mock executor returns InteractiveHandle; all assertions use `collect`-based flow
8. Tests: contract tests for `collect` with mock InteractiveHandle; integration test for DockerExecutor bidirectional streams

> **After Phase 1:** The project compiles and works exactly as before — all agent calls still go through `run.sh` via `collect()`. The only difference is the plumbing: `exec` returns streams instead of collected output, and `collect` reassembles them. This is a pure refactoring phase with zero behavior change.

### Phase 2: AcpSession
1. Create `web/src/lib/orchestrator/acp-session.ts`
2. Implement `start`, `prompt`, `cancel`, `resetSession`, `close`
3. Tests: unit tests with mock ClientSideConnection, contract tests for AgentResult mapping

### Phase 3: Mock ACP server + Scheduler migration (shell→ACP)

> Mock ACP server must be created BEFORE switching the Scheduler to ACP, otherwise `agentSlug: 'mock'` breaks between steps.

1. Create `web/agents/mock/mock-acp-server.py` (Python 3, stdlib only, ACP over stdio)
2. Add `resolveAcpConfig` (including `mock` entry)
3. Add `activeSessions` map, update `cancel` method (use `acpSession.cancel`, not `close`)
4. Update `executeLane` — create AcpSession per lane, register in `activeSessions`
5. Update `executeScenario` — replace `collect(this.executor, handle, ['/opt/agent/run.sh', ...])` with `acpSession.prompt` for agent calls; `collect` stays for init.sh and test scripts
6. Write `acp-telemetry-attempt-{N}.json` to session dir after each agent call (see Telemetry Persistence section)
7. Update `stepTimeoutSeconds` JSDoc in `types.ts` and Zod comment in `runs/route.ts`
8. Update `scheduler.test.ts` — replace `run.sh`-based mock patterns with mock AcpSession
9. New tests: ACP error scenarios (refusal, max_tokens, timeout-cancel vs user-cancel), AcpSession.start failure in executeLane
10. Verify existing `run-pipeline.test.ts` (pack/import/register) still passes — no regression
11. **New** E2E test (`run-acp-lifecycle.test.ts`): full ACP run lifecycle with mock agent — POST /api/runs -> SSE events -> init.sh -> ACP prompt -> test script -> task:completed -> run_results in DB (see Verification #5)

### Phase 4: Agent onboarding + Docker cleanup

**DoD:** Every agent in `resolveAcpConfig` can complete `AcpSession.start` → `initialize` handshake in a running container. This is the hard acceptance criterion — if a binary is missing or an ACP adapter rejects the handshake, Phase 4 is not done.

1. **Wire env plumbing** (prerequisite — see Runtime Prerequisites): add `env?` to `LaneConfig`, read `executor.config.env` in `POST /api/runs`, pass `lane.env` in `Scheduler.executeLane` → `executor.start({ env })`
2. Install all 6 agent CLIs into `litmus/runtime-python` Dockerfile (single fat image — see Runtime Prerequisites)
3. For each agent: run smoke test — `AcpSession.start` succeeds, `session/prompt` with trivial prompt returns `end_turn`
4. Delete `web/agents/cursor/run.sh` and `web/agents/mock/run.sh`
5. Document per-agent quirks (if any) in `web/agents/README.md`

---

## Files to Modify

| File | Change |
|---|---|
| `web/src/lib/orchestrator/types.ts` | Add InteractiveHandle, AgentResult, AgentToolCall, AcpAgentConfig; update AgentExecutor; add `env?: Record<string, string>` to `LaneConfig` (Phase 4) |
| `web/src/lib/orchestrator/docker-executor.ts` | Rewrite `exec` -> InteractiveHandle with hijack mode |
| `web/src/lib/orchestrator/collect.ts` | **New** — `collect` utility |
| `web/src/lib/orchestrator/acp-session.ts` | **New** — AcpSession class |
| `web/src/lib/orchestrator/scheduler.ts` | AcpSession for agents, `collect` for shell scripts |
| `web/src/app/api/agents/[id]/models/route.ts` | Use `collect` |
| `web/agents/cursor/run.sh` | **Delete** |
| `web/agents/mock/run.sh` | **Delete** — replaced by mock-acp-server.py |
| `web/agents/mock/mock-acp-server.py` | **New** — mock ACP agent for E2E tests |
| `web/package.json` | Add `@agentclientprotocol/sdk` |
| `web/agents/runtime/Dockerfile` | Add all 6 agent CLIs (single fat image) |
| `web/src/lib/orchestrator/__tests__/scheduler.test.ts` | Rewrite: mock AcpSession instead of run.sh exec, mock executor returns InteractiveHandle |
| `web/e2e/run-acp-lifecycle.test.ts` | **New** — ACP run lifecycle E2E test (Phase 3) |
| `web/src/lib/orchestrator/__tests__/docker-executor.test.ts` | Rewrite: assertions expect InteractiveHandle, not ExecResult |
| `web/src/app/api/runs/route.ts` | Update Zod schema comment (remove `run.sh` reference); read `executor.config.env` into lane config (Phase 4) |

## Existing Code to Reuse

| Code | Location | Reuse |
|---|---|---|
| `killOrphanedProcesses` | `docker-executor.ts:126` | In InteractiveHandle.kill |
| `cleanupOrphans` | `docker-executor.ts:148` | Unchanged |
| `buildRetryPrompt` | `scheduler.ts:393` | Unchanged |
| `resolveTestScript` | `scheduler.ts:440` | Used with `collect` |
| `persistTaskError` | `scheduler.ts:398` | Unchanged |
| `Reconciler` | `reconciler.ts` | Unchanged |
| `EventBus` / `InMemoryEventBus` | `event-bus.ts` | Unchanged |

---

## Verification

1. **Unit:** AcpSession with mocked ClientSideConnection — handshake, prompt, timeout/cancel, error mapping
2. **Unit:** `collect` with mock InteractiveHandle — stdout/stderr collection, timeout
3. **Integration:** DockerExecutor hijack mode — bidirectional streams with real Docker
4. **Integration:** Scheduler with InMemoryEventBus + mock AcpSession — lane/scenario lifecycle, retries, SSE events
5. **E2E:** Full run lifecycle with mock ACP agent — **new test** (not covered by existing `run-pipeline.test.ts` which only tests pack/import/register). Must verify: POST /api/runs -> SSE task:started -> init.sh -> ACP prompt (mock copies solution) -> test script -> task:completed SSE -> run_results row in DB with status='completed' and totalScore=100. This is the critical ACP integration proof.
6. **E2E:** Model discovery POST endpoint still works via `collect`
7. **E2E:** Cancellation triggers session/cancel -> graceful shutdown
8. **Unit:** AcpSession.start failure (binary not in PATH, handshake rejected) — falls into executeLane catch block, all remaining scenarios get task:error

## Risks

| Risk | Mitigation |
|---|---|
| ACP SDK v0.11 pre-1.0, API may change | Pin exact version, AcpSession wraps all SDK calls (single change point) |
| Docker hijack mode stream quirks | Integration test in Phase 1, before building AcpSession on top |
| Agent ACP implementations vary | Test each agent in Phase 4 E2E, document quirks per agent |
| `max_tokens` retryable may produce broken code | Same risk as current shell approach — mitigated by test runner |

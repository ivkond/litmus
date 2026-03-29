# Litmus Web Phase 2: Run Engine — Design Spec

**Date:** 2026-03-27
**Status:** Draft
**Parent spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md`
**Phase 1 plan:** `docs/superpowers/plans/2026-03-26-web-phase1-foundation.md` (completed)

## Goal

Enable end-to-end benchmark execution: user selects agent×model×scenario matrix → system orchestrates Docker containers → collects results → streams progress in real time. This is the core value proposition of Litmus Web.

## Approach

**Vertical slice, two waves:**

1. **Wave 1 — Backend engine:** Orchestrator, Docker executor, reconciler, scheduler, API routes, SSE streaming. Testable via `curl` before any UI exists.
2. **Wave 2 — UI:** Matrix Builder page + Progress View page, connected to real API endpoints.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Execution strategy | Vertical slice (end-to-end first) | Integration risk is highest — Docker socket, dockerode exec, streaming. Surface issues early. |
| Runtime image | `python:3.12-slim` + pytest | All seed scenarios are Python. Polyglot devcontainer deferred until multi-language scenarios exist. |
| Reference agent | Cursor CLI (`cursor agent -p`) | Headless, `CURSOR_API_KEY` env auth, `--model` flag, `--force --trust` for non-interactive. |
| Container data sharing | Shared bind mount (`./work`) | Reconciler reads files via `fs.readFile()`, not Docker API. Host-dev compatible. Maps to K8s PVC in production. |
| Script architecture | `init.sh` + `run.sh` + `test.sh` | Separation of concerns: workspace prep, agent execution, test verification. Retry loop in scheduler. |
| Model discovery | `models.sh` + ephemeral container + DB cache | Agents expose models via script. Cached in `agents.available_models` JSONB. Refresh on demand. |
| Scenario provisioning | `.litmus-pack` import + `pack.ts` script | Scenarios version-controlled in repo, packed into ZIP, imported via API. Full CRUD deferred to Phase 3. |
| E2e testing | Mock agent + `__test__/` scenarios | Deterministic, free, fast. Real Cursor agent for manual runs. |
| SSE transport | In-process `EventEmitter` | Sufficient for single-instance Docker Compose. Redis pub/sub on scaling roadmap. |

### Deviations from Master Spec

These changes are intentional improvements over the master spec's design:

1. **Script split** — Master spec has a single `run.sh` handling agent execution, testing, and retries. Phase 2 splits into `init.sh` + `run.sh` + `test.sh` with retry loop in the scheduler. Better separation of concerns.
2. **Shared bind mount** — Master spec implies `container.getArchive()` for result collection. Phase 2 uses a shared bind mount (`./work`), visible to both host-dev Next.js and agent containers. Maps to K8s PVC in production. This also removes the need for the `collectArtifacts()` method from `AgentExecutor`.
3. **Lower-level `exec` API** — Master spec's `exec(handle, scenario)` is scenario-aware and returns `testsPassed/testsTotal`. Phase 2's `exec(handle, cmd[], env?)` is a generic command runner — the scheduler composes the right commands, and the reconciler handles parsing. This enables the script split.
4. **`models.sh` discovery** — Not in master spec. Added to solve the real problem of agents having different model catalogs (KiloCode has 300+).
5. **`.litmus-pack` only** — No Scenarios CRUD in Phase 2. Scenarios are imported via pack files.
6. **Python-only runtime** — Master spec describes a polyglot devcontainer. Phase 2 uses `python:3.12-slim` for vertical slice speed.
7. **Cursor CLI as reference agent** — Master spec mentions Claude Code. Phase 2 uses Cursor CLI (`cursor agent -p`).
8. **`run.sh` receives `--scenario-dir`** — Added to give agents access to scenario files (e.g., mock agent needs `solution/`).

---

## Architecture

### Orchestrator Core

```
src/lib/orchestrator/
├── types.ts              # AgentExecutor interface, Handle, ExecResult, SSE events
├── docker-executor.ts    # DockerExecutor implements AgentExecutor
├── host-executor.ts      # HostExecutor (stub — future phase)
├── reconciler.ts         # test-results.json → DB + S3
└── scheduler.ts          # Lane-based task scheduling + retry loop
```

### AgentExecutor Interface

```typescript
interface AgentExecutor {
    type: 'docker' | 'host' | 'kubernetes';

    // Create the execution environment (container or process)
    start(config: ExecutorConfig): Promise<Handle>;

    // Run a command inside the environment (argument array — no shell injection)
    exec(handle: Handle, cmd: string[], env?: Record<string, string>): Promise<ExecResult>;

    // Tear down the environment
    stop(handle: Handle): Promise<void>;

    // Verify the agent is available
    healthCheck(): Promise<boolean>;
}

interface ExecResult {
    exitCode: number;       // 0 = success, 1 = tests failed, 2 = agent/infra error
    stdout: string;
    stderr: string;
}

interface ExecutorConfig {
    image: string;                          // e.g. "litmus/runtime-python"
    agentHostDir: string;                   // HOST-VALID path to agent scripts (see Path Model below)
    workHostDir: string;                    // HOST-VALID path to shared work directory (bind mount)
    runId: string;                          // for session dir construction
    env: Record<string, string>;            // CURSOR_API_KEY, MODEL, etc.
    labels?: Record<string, string>;        // container labels (litmus.managed, litmus.run-id)
    limits?: { memory: number; cpus: number };
    network?: string;                       // default: "litmus-agents"
    timeoutSeconds?: number;                // per-exec timeout (default: 600 = 10 min)
}
```

**Note on command safety:** The `exec` method accepts a `string[]` (argument array), never a shell string. This prevents command injection from scenario prompts or agent output. The dockerode `exec` API and Node.js `execFile` both use argument arrays natively.

### DockerExecutor

Connects to Docker socket proxy (`tcp://docker-socket-proxy:2375`) via `dockerode`. Creates containers in the `litmus-agents` network (isolated from infrastructure).

```typescript
class DockerExecutor implements AgentExecutor {
    type = 'docker' as const;

    async start(config: ExecutorConfig): Promise<ContainerHandle> {
        const container = await this.docker.createContainer({
            Image: config.image,
            Cmd: ['sleep', 'infinity'],
            Env: Object.entries(config.env).map(([k, v]) => `${k}=${v}`),
            Labels: {
                'litmus.managed': 'true',
                'litmus.run-id': config.runId,
                ...(config.labels ?? {}),
            },
            HostConfig: {
                Binds: [
                    `${config.agentHostDir}:/opt/agent:ro`,  // host-valid path
                    `${config.workHostDir}:/work`,            // bind mount to shared ./work
                ],
                NetworkMode: config.network ?? 'litmus-agents',
                Memory: (config.limits?.memory ?? 4) * 1024 * 1024 * 1024,
                NanoCpus: (config.limits?.cpus ?? 2) * 1e9,
            },
        });
        await container.start();
        return { containerId: container.id, container };
    }

    async exec(handle: ContainerHandle, cmd: string[], env?: Record<string, string>): Promise<ExecResult> {
        const execution = await handle.container.exec({
            Cmd: cmd,
            Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
            AttachStdout: true,
            AttachStderr: true,
        });
        const stream = await execution.start({});
        // Collect stdout/stderr from demuxed stream...
        const info = await execution.inspect();
        return { exitCode: info.ExitCode, stdout, stderr };
    }

    async stop(handle: ContainerHandle): Promise<void> {
        await handle.container.stop();
        await handle.container.remove();
    }
}
```

### Shared Directory & Path Model

Agent containers and `litmus-web` share a **host bind mount** (`./work`), not a Docker named volume. This is critical: in host-dev mode (primary dev workflow), Next.js runs on the host and must read results via `fs.readFile()`. A Docker named volume is invisible to host processes. A bind mount to `./work/` is visible to everyone.

```
Docker Compose:
  bind mount: ./work → /work (agent containers)
  bind mount: ./work → /var/litmus/work (litmus-web container)

Kubernetes (future):
  PersistentVolumeClaim (ReadWriteMany) mounted to /work
```

**How it works in each mode:**

| Mode | litmus-web reads from | Agent container writes to | Physical storage |
|------|----------------------|--------------------------|------------------|
| Host-dev (primary) | `./work/runs/...` (host filesystem) | `/work/runs/...` (bind mount to `./work`) | `web/work/` on host |
| Containerized (`--profile full`) | `/var/litmus/work/runs/...` (bind mount to `./work`) | `/work/runs/...` (bind mount to `./work`) | `web/work/` on host |

**The scheduler resolves paths using `WORK_ROOT` env var:**
- Host-dev: `WORK_ROOT=./work`
- Containerized: `WORK_ROOT=/var/litmus/work`
- Agent containers always use `/work` (hardcoded in bind mount)

**Docker Compose changes** (replace named volume with bind mount):
```yaml
# docker-compose.yml — litmus-web service
volumes:
  - ./agents:/opt/agent:ro        # for containerized profile only
  - ./work:/var/litmus/work       # shared workspace (bind mount)

# DockerExecutor creates agent containers with:
#   Binds: [
#     `${agentHostDir}:/opt/agent:ro`,
#     `${workHostDir}:/work`,        # bind mount to same ./work directory
#   ]
```

`agentHostDir` and `workHostDir` are host-valid paths:
- Host-dev: `agentHostDir = path.resolve('./agents', agentSlug)`, `workHostDir = path.resolve('./work')`
- Containerized: from `AGENTS_HOST_DIR` and `WORK_HOST_DIR` env vars (set in docker-compose.yml from host context)

```yaml
# docker-compose.yml
litmus-web:
  environment:
    AGENTS_HOST_DIR: ${AGENTS_HOST_DIR:-.}  # host path to web/ directory
    WORK_HOST_DIR: ${WORK_HOST_DIR:-./work} # host path to work/ directory
    WORK_ROOT: /var/litmus/work             # container-local path to work/
```

**`web/work/` is gitignored.** Add to `.gitignore`: `work/`

**Session directory layout:**
```
{WORK_ROOT}/runs/{run_id}/{agent_slug}/{model_slug}/{scenario_slug}/
├── project/              # copied by init.sh from scenario (starter code)
│   └── main.py           # agent modifies these files directly
├── test.py               # copied by init.sh from scenario
├── logs/
│   └── agent.log         # agent interaction log (written by run.sh)
└── test-results.json     # written by test.sh
```

**Workspace contract (canonical, no ambiguity):**
- `init.sh` copies ALL scenario files into workspace root (project/, test.py, etc.)
- The agent works directly in workspace root — modifies `project/main.py`, creates new files alongside `project/`
- `test.sh` runs from workspace root: `cd $WORKSPACE && pytest test.py`
- `finalize()` uploads the entire workspace directory to S3 as artifacts
- Mock agent copies `solution/*` into `$WORKSPACE/project/` (replacing starter code, same location real agent would modify)

### Reconciler

The reconciler has two modes:

**`reconciler.evaluate()`** — called after each test.sh execution (including retries):
1. Reads `test-results.json` from session directory via `fs.readFile()`
2. Parses: `tests_passed`, `tests_total`, computes `total_score` (0-100%)
3. Returns parsed result + SSE event payload (does NOT write to DB or S3)

**`reconciler.finalize(sessionDir, taskMeta, evalResult)`** — called once per (scenario, agent, model) after the final attempt:
1. Inserts row into `run_results` table (single INSERT — no upsert needed since there's exactly one finalize per combo)
2. Uploads the entire workspace directory to Garage at `artifacts/{run_id}/{agent}/{model}/{scenario}/`
3. Updates `run_tasks.status` to `completed`, `failed`, or `error`

These are the ONLY two reconciler methods. There is no `process()` method.

**After ALL scenarios for a container complete** (managed by scheduler, not reconciler):
1. Container stopped and removed
2. When all containers in a run complete → update `runs.status` to `completed` → refresh materialized views
3. Cleanup: `rm -rf {WORK_ROOT}/runs/{run_id}/`

---

## Script Architecture

Orchestration logic (retry loop, prompt composition, flow control) lives in the **Scheduler**, not in shell scripts. Scripts are pure, single-purpose executables.

### Contract Scripts

```
agents/
├── init.sh                     # Prepare workspace (shared across agents)
├── cursor/
│   ├── run.sh                  # Run Cursor agent
│   └── models.sh               # Discover available models
├── mock/
│   └── run.sh                  # Deterministic mock (copies solution/)
└── tests/
    ├── python.sh               # pytest → test-results.json
    ├── javascript.sh           # jest → test-results.json (future)
    └── go.sh                   # go test → test-results.json (future)
```

### `init.sh` — Workspace Preparation

```
INPUT:  --scenario <path> --workspace <path>
ACTION: Copy ALL files from scenario into workspace (project/, test.py, etc.),
        create logs/ directory, install deps if needed (pip install -r requirements.txt)
EXIT:   0 = ready, 2 = error
```

### `run.sh` — Agent Execution

```
INPUT:  --model <model> --prompt <text-or-file> --workspace <path> --scenario-dir <path>
ACTION: Run agent (Cursor/Aider/etc.), agent modifies files in workspace
EXIT:   0 = done, 2 = agent error (crash, API failure)
```

The `--scenario-dir` argument gives the agent access to the original scenario files (e.g., mock agent reads `solution/` from there). Most real agents ignore it.

Agent-specific implementation. For Cursor:
```bash
cursor agent -p "$PROMPT" \
    --model "$MODEL" \
    --workspace "$WORKSPACE" \
    --force --trust --print
```

Auth: `CURSOR_API_KEY` passed as container environment variable.

### `test.sh` — Test Verification

```
INPUT:  --workspace <path> --output <path-to-test-results.json>
ACTION: Run tests (pytest/jest/go test), write test-results.json
EXIT:   0 = all pass, 1 = some fail, 2 = infra error
```

Language-specific. For Python:
```bash
cd "$WORKSPACE"
pytest test.py --json-report --json-report-file="$OUTPUT" -q
```

### `models.sh` — Model Discovery

```
INPUT:  (env: agent-specific API keys, e.g. CURSOR_API_KEY)
OUTPUT: JSON to stdout: [{"id": "gpt-4o", "name": "GPT-4o", "provider": "OpenAI"}, ...]
EXIT:   0 = success, 2 = error
```

Runs in an ephemeral container (`docker run --rm`). Result cached in `agents.available_models` JSONB column. Refreshed on demand via `POST /api/agents/[id]/models`.

### `test-results.json` Format

```json
{
    "tests_passed": 4,
    "tests_total": 5,
    "framework": "pytest",
    "details": [
        {"name": "test_insert", "status": "passed", "duration_ms": 120},
        {"name": "test_delete", "status": "failed", "message": "AssertionError..."}
    ]
}
```

---

## Scheduler

**File:** `src/lib/orchestrator/scheduler.ts`

The scheduler is the central coordinator. It receives a run configuration (agent×model×scenario matrix), creates containers, manages the retry loop, and emits SSE events.

### Lanes

Each (agent, model) combination = one **lane** = one container. Lanes run in parallel (configurable `maxConcurrentLanes`, default: 3). Scenarios within a lane run sequentially.

```
Run #42: 2 agents × 2 models × 3 scenarios = 4 lanes

Lane 1: [Cursor × GPT-4o]       ──▶ scenario-1 → scenario-2 → scenario-3
Lane 2: [Cursor × Sonnet-4]     ──▶ scenario-1 → scenario-2 → scenario-3
Lane 3: [Aider × GPT-4o]        ──▶ scenario-1 → scenario-2 → scenario-3
Lane 4: [Aider × Sonnet-4]      ──▶ (waits for lane slot) → scenario-1 → ...
```

### Lane Execution Flow (per scenario)

```
1. emit SSE: task:started (attempt=1, maxAttempts)
2. exec init.sh --scenario <path> --workspace <session-dir>
3. prompt = read scenario/prompt.txt
4. for attempt in 1..maxAttempts:
     exec run.sh --model MODEL --prompt <prompt> --workspace <session-dir> --scenario-dir <path>
     exec test.sh --workspace <session-dir> --output test-results.json
     evalResult = reconciler.evaluate(sessionDir)
     if evalResult.allPassed →
       emit SSE: task:completed (attempt, maxAttempts, final=true, score, tests)
       break
     else if attempt == maxAttempts →
       emit SSE: task:failed (attempt, maxAttempts, final=true, score)
     else →
       emit SSE: task:retrying (attempt, maxAttempts, testOutput)
       prompt = buildRetryPrompt(originalPrompt, evalResult.testOutput)
5. reconciler.finalize(sessionDir, taskMeta, evalResult)
   → INSERT run_results, upload workspace to S3, update run_tasks.status
```

**Retry behavior:** The workspace is NOT reset between retries. The agent sees its own previous modifications, enabling iterative fixing. The retry prompt includes test output so the agent knows what failed. This is intentional — agents work best when they can iterate on their own code rather than starting from scratch.

**Timeout:** Each `exec` call (init.sh, run.sh, test.sh) is subject to `ExecutorConfig.timeoutSeconds` (default: 600s = 10 min). If exceeded, the exec is killed and the task is marked as `error`.

**Reconciler and retries:** The reconciler writes `run_results` only once per (run, agent, model, scenario) — after the final attempt (whether pass, fail, or error). It uses INSERT (not upsert) since there is exactly one write. SSE events with `attempt`/`maxAttempts` fields are emitted on every attempt so the UI shows live progress including retries.

**Test script selection:** The scheduler selects the test script based on the scenario's `language` field: `python` → `agents/tests/python.sh`, `javascript` → `agents/tests/javascript.sh`, etc.

### Retry Prompt

On retry, the scheduler composes a new prompt:
```
Original task: {original prompt}

Previous attempt failed. Test output:
{pytest stdout/stderr}

Fix the code to make all tests pass.
```

### Run Cancellation

`DELETE /api/runs/[runId]` → Scheduler stops all active lanes, kills containers, marks run and pending/running tasks as `cancelled`. The run and its results remain in the DB for history. Hard deletion (removing from DB) is deferred to Phase 4.

### SSE Events

Scheduler pushes events to an in-process `EventEmitter`. The API route `GET /api/runs/[runId]/stream` subscribes and streams to the client.

```typescript
// Task lifecycle events (include attempt tracking):
{ type: 'task:started', runId, taskId, agent, model, scenario, attempt: 1, maxAttempts: 4, timestamp }
{ type: 'task:retrying', runId, taskId, agent, model, scenario, attempt: 1, maxAttempts: 4, testOutput: "..." }
{ type: 'task:completed', runId, taskId, agent, model, scenario, attempt: 2, maxAttempts: 4, score, testsPassed, testsTotal, duration, final: true }
{ type: 'task:failed', runId, taskId, agent, model, scenario, attempt: 4, maxAttempts: 4, score, errorMessage, final: true }
{ type: 'task:error', runId, taskId, agent, model, scenario, errorMessage }

// Aggregate events:
{ type: 'container:finished', runId, agent, model, completedCount, failedCount, errorCount }
{ type: 'run:completed', runId, totalTasks, completedTasks, failedTasks, errorTasks, cancelledTasks }
{ type: 'run:cancelled', runId, completedTasks, cancelledTasks }
```

**Event semantics:**
- `task:retrying` = intermediate failure, another attempt will follow. UI shows amber "retrying" state.
- `task:failed` with `final: true` = all retries exhausted. UI shows red final state.
- `task:completed` with `final: true` = tests passed (possibly after retries). UI shows green.
- `task:error` = infra failure, no retry possible. UI shows red error icon.
- `run:cancelled` = user cancelled via DELETE. Distinct from `run:completed`.

> **Scaling note:** In-process `EventEmitter` is sufficient for single-instance Docker Compose deployment. For horizontal scaling (multiple litmus-web instances), replace with Redis pub/sub. This is tracked on the roadmap as a Phase 5+ item.

### SSE Reconnection

On reconnect, the SSE endpoint queries `run_tasks` (joined with `run_results` for completed/failed tasks) and emits synthetic terminal-state events for tasks that already finished. Then it switches to live streaming for in-progress tasks.

**What is restored:** Terminal states (completed scores, failed results, error messages) — enough to rebuild the progress matrix.

**What is lost:** In-flight retry state (`task:retrying` events, current attempt number, intermediate test output). A task that is mid-retry will appear as `running` until the next real event arrives. This is acceptable for Phase 2 — the visual impact is minimal (cell shows "running" instead of "retrying attempt 2/4" for a few seconds until the next event).

### Startup Cleanup

On `litmus-web` startup, the scheduler checks for orphaned agent containers (labeled `litmus.managed=true`) from previous crashes and removes them. It also marks any `run_tasks` with status `running` as `error` (since the process that was running them is gone).

---

## Runtime Image

### `litmus/runtime-python`

Minimal Python-only image for Phase 2 vertical slice.

```dockerfile
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pytest pytest-json-report

# Cursor CLI
RUN curl -fsSL https://www.cursor.com/install.sh | bash

WORKDIR /work
CMD ["sleep", "infinity"]
```

~200MB. Contains: Python 3.12, pytest, git, curl, Cursor CLI.

**Agent CLI provisioning strategy:**

Phase 2 bakes Cursor CLI into the runtime image because there is only one agent. This is an intentional shortcut — NOT the long-term pattern. When multiple agents are added (Aider, OpenCode, KiloCode), the approach changes to one of:
- Per-agent images (e.g., `litmus/runtime-cursor`, `litmus/runtime-aider`) — each extends the base runtime
- CLI installation in `init.sh` — agent scripts install their own CLI on first run
- CLI in the mounted agent directory (`/opt/agent/bin/`) — pre-built binary, no install step

The decision is deferred to Phase 4 when multiple agents are actually needed.

> **Note on Cursor CLI install:** The `curl | bash` install is convenient but fragile (no version pinning, URL may change). In production, pin a specific version or use a checksum. For Phase 2 vertical slice this is acceptable.

**Volume mount per agent:** Each agent has its own directory (`agents/cursor/`, `agents/mock/`). The DockerExecutor mounts the specific agent directory as `/opt/agent:ro` (e.g., `./agents/cursor:/opt/agent:ro`). The existing `docker-compose.yml` mount (`./agents:/opt/agent:ro`) for `litmus-web` service mounts the entire agents directory — only used in containerized deployment profile for `models.sh` discovery. The DockerExecutor creates per-agent mounts programmatically.

> **Note on `VOLUMES: 0` in socket proxy:** The proxy's `VOLUMES: 0` denies explicit volume CRUD APIs (create/list/inspect/delete), NOT container creation with bind mounts. Containers can still use bind mounts — the restriction only prevents creating or deleting named volumes via the API. Phase 2 uses bind mounts exclusively, so this setting is safe.

**Migration path to polyglot:** When multi-language scenarios are needed, switch to Dev Container Features image (`litmus/runtime-polyglot`). This is a single-line change in executor config (`image: "litmus/runtime-polyglot"`). No other code changes required.

---

## Scenarios

### Source Scenarios (version-controlled)

```
agents/scenarios/
├── 1-data-structure/
│   ├── prompt.txt              # "Implement a binary search tree..."
│   ├── project/
│   │   └── main.py             # Starter code
│   └── test.py                 # pytest tests (what the agent must satisfy)
├── 2-simple-api/
│   └── ...
└── __test__/                   # Deterministic scenarios for e2e tests
    └── 1-trivial-pass/
        ├── prompt.txt
        ├── project/
        │   └── main.py
        ├── test.py
        └── solution/           # Pre-built correct answer (used by mock agent)
            └── main.py
```

### `.litmus-pack` Format

ZIP archive with `manifest.json` + scenario directories (as defined in master spec).

### `scripts/pack.ts` — Pack Generator

Reads a local scenarios directory, generates `manifest.json` from structure, outputs ZIP:

```bash
npm run pack -- ./agents/scenarios -o scenarios.litmus-pack
```

### Import Flow

```bash
curl -F "file=@scenarios.litmus-pack" http://localhost:3000/api/scenarios/import
```

API extracts manifest → for each scenario: create/update `scenarios` row in Postgres, upload files to `litmus-scenarios/{slug}/` in Garage.

### Scenarios CRUD

Full CRUD (create, edit, delete via UI) is deferred to Phase 3. Phase 2 provides:
- `POST /api/scenarios/import` — `.litmus-pack` import
- `GET /api/scenarios` — list all scenarios (read-only)

---

## API Routes

### Phase 2 Routes

```
POST   /api/runs                    Create run (matrix → run_tasks → start scheduler)
GET    /api/runs                    List runs with pagination
GET    /api/runs/[runId]            Run status + task summary
GET    /api/runs/[runId]/stream     SSE progress stream
DELETE /api/runs/[runId]            Cancel a running run (sets status to 'cancelled')

GET    /api/agents                  List agents with executors + cached models
POST   /api/agents                  Add agent + executor config
PUT    /api/agents/[id]             Update agent/executor
POST   /api/agents/[id]/health      Run health check
POST   /api/agents/[id]/models      Discover models (ephemeral container)

GET    /api/scenarios               List all scenarios
POST   /api/scenarios/import        Import .litmus-pack
```

### `POST /api/runs` — Request Body

```typescript
{
    agents: [
        { id: string, models: string[] }   // agent ID + selected model IDs
    ],
    scenarios: string[],                    // scenario IDs
    maxRetries: number,                     // default: 3
    maxConcurrentLanes: number              // default: 3
}
```

Response: `{ runId: string }`

Creates `runs` row (status: pending) + `run_tasks` rows for each (agent, model, scenario) combination. Starts scheduler asynchronously.

**Agent → executor resolution:** The API resolves each `agents[].id` to its `agent_executor_id` by selecting the agent's executor with `type = 'docker'` (first match). If no docker executor exists for an agent, the API returns 400. Multi-executor selection (e.g., choosing between docker and host) is deferred — Phase 2 only supports docker executors.

### `POST /api/agents/[id]/models` — Model Discovery

Launches ephemeral container with agent's `models.sh`. Caches result in `agents.available_models`. Also upserts discovered models into the `models` table (so they can be referenced by `run_tasks.model_id` foreign key).

Response: `[{ id: string, name: string, provider?: string }, ...]`

---

## Schema Changes

### Migration 1: Extend status enums

The Phase 1 schema allows `pending|running|completed|failed` for both `runs.status` and `run_tasks.status`. Phase 2 needs `error` (infra failure, timeout, crash) and `cancelled` (user cancellation):

```sql
-- runs.status: add 'error' and 'cancelled'
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'error', 'cancelled'));

-- run_tasks.status: add 'error' and 'cancelled'
ALTER TABLE run_tasks DROP CONSTRAINT IF EXISTS run_tasks_status_check;
ALTER TABLE run_tasks ADD CONSTRAINT run_tasks_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'error', 'cancelled'));
```

**Status semantics — `run_tasks`** (individual scenario execution):

| Status | Meaning | Set by |
|--------|---------|--------|
| `pending` | Waiting to start | API on creation |
| `running` | Currently executing (including retries) | Scheduler on start |
| `completed` | Tests passed (possibly after retries) | Reconciler.finalize() |
| `failed` | Agent ran, tests failed after all retries exhausted | Reconciler.finalize() |
| `error` | Infrastructure failure: timeout, crash, container error | Scheduler / startup cleanup |
| `cancelled` | User cancelled before task completed | DELETE API route |

**Status semantics — `runs`** (orchestration-level, different meaning than tasks):

| Status | Meaning | Set by |
|--------|---------|--------|
| `pending` | Run created, scheduler not yet started | API on creation |
| `running` | Scheduler is actively executing lanes | Scheduler on start |
| `completed` | Orchestration finished — all tasks reached terminal state (may include failed/error tasks) | Scheduler on all-done |
| `failed` | Scheduler itself crashed (not individual task failures) | Startup cleanup |
| `error` | Critical infrastructure failure preventing orchestration | Scheduler |
| `cancelled` | User cancelled via `DELETE /api/runs/[runId]` | DELETE API route |

**Key distinction:** `runs.status = 'completed'` means "orchestration is done", NOT "all tests passed". A completed run may contain a mix of completed, failed, and error tasks. The dashboard shows task-level stats for run quality.

Update Drizzle schema: change `enum` arrays in `runs.status` and `runTasks.status` to include `'error'` and `'cancelled'`.

### Migration 2: Add `available_models` to `agents`

```sql
ALTER TABLE agents ADD COLUMN available_models JSONB DEFAULT '[]';
```

`available_models` stores: `[{ dbId: "uuid", externalId: "gpt-4o", name: "GPT-4o", provider: "OpenAI" }, ...]`

This requires both:
1. A Drizzle migration (SQL above)
2. Updating the Drizzle schema definition in `src/db/schema.ts` — add `availableModels: jsonb('available_models').default([])` to the `agents` table

### Model Identity Contract

`models.sh` returns agent-local identifiers (e.g., `gpt-4o`). The model discovery endpoint (`POST /api/agents/[id]/models`) upserts these into the `models` table by `name` (unique constraint). The `available_models` JSONB stores the mapping between DB UUIDs and external IDs so the UI can show names and submit UUIDs.

- `POST /api/runs` accepts DB UUIDs in `agents[].models[]` (not external keys)
- The UI reads `available_models` JSONB for display, sends `dbId` values
- If two agents report the same model name (e.g., both support "gpt-4o"), they share one `models` row — this is correct since model identity is by name

---

## UI — Wave 2

### Matrix Builder (`/run`)

Two-column layout:

**Left column — Agents & Models:**
- Agent cards loaded from `GET /api/agents`
- Model chips from cached `available_models`
- "Refresh models" button per agent (calls `POST /api/agents/[id]/models`)
- Selected agents highlighted with accent border

**Right column — Scenarios:**
- Checklist loaded from `GET /api/scenarios`
- "Select all" toggle
- Selected count badge ("6 of 8 selected")

**Bottom — Summary Bar:**
- Live formula: `N agents × M models × K scenarios = X runs`
- "Start Run" button → `POST /api/runs` → redirect to `/run/{runId}`

### Progress View (`/run/[runId]`)

Real-time matrix fill via SSE (`EventSource` → `GET /api/runs/[runId]/stream`):

- **Progress bar:** `completed / total` tasks + linear ETA estimate
- **Now running indicator:** `Cursor × GPT-4o × scenario-3 (42s)`
- **Matrix table:** rows = agent×model, columns = scenarios
  - Cell states:
    - Pending: `—` (muted)
    - Running: amber pulse animation
    - Retrying: amber pulse + attempt badge (`2/4`)
    - Completed: score (color-coded by 5-point scale from design system)
    - Failed: score + warning icon
    - Error: red X icon
    - Cancelled: grey dash + slash icon
  - First column (agent×model) sticky on horizontal scroll

---

## E2E Testing

### Mock Agent (`agents/mock/run.sh`)

Copies pre-built solution from scenario's `solution/` directory into workspace. Deterministic, free, instant.

```bash
#!/bin/bash
# Mock agent: copies prepared solution into project/ (same location real agent modifies)
# Uses --scenario-dir to find the solution/ directory
cp -r "$SCENARIO_DIR/solution/"* "$WORKSPACE/project/"
```

### Test Scenarios (`agents/scenarios/__test__/`)

Each test scenario includes a `solution/` directory with the correct implementation. Combined with the mock agent, this provides deterministic e2e verification.

### E2E Test Flow

```
1. Pack __test__/ scenarios → .litmus-pack
2. Import via POST /api/scenarios/import
3. Create run with mock agent via POST /api/runs
4. Subscribe to SSE stream, wait for run:completed
5. Assert:
   - run_results rows in DB with expected scores
   - Artifacts uploaded to S3
   - run.status = 'completed'
   - Materialized views refreshed
```

### Test File

```
e2e/
└── run-pipeline.test.ts        # Full pipeline e2e test
```

---

## File Map

```
web/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── runs/
│   │   │   │   ├── route.ts
│   │   │   │   └── [runId]/
│   │   │   │       ├── route.ts
│   │   │   │       └── stream/route.ts
│   │   │   ├── agents/
│   │   │   │   ├── route.ts
│   │   │   │   └── [id]/
│   │   │   │       ├── route.ts
│   │   │   │       ├── health/route.ts
│   │   │   │       └── models/route.ts
│   │   │   └── scenarios/
│   │   │       ├── route.ts
│   │   │       └── import/route.ts
│   │   ├── run/
│   │   │   ├── page.tsx                    # Matrix Builder
│   │   │   └── [runId]/page.tsx            # Progress View
│   │   └── scenarios/page.tsx              # Update stub → list from DB
│   ├── lib/
│   │   └── orchestrator/
│   │       ├── types.ts
│   │       ├── docker-executor.ts
│   │       ├── host-executor.ts            # stub
│   │       ├── reconciler.ts
│   │       └── scheduler.ts
│   ├── components/
│   │   ├── matrix-builder/
│   │   │   ├── agent-card.tsx
│   │   │   ├── scenario-list.tsx
│   │   │   └── summary-bar.tsx
│   │   └── progress/
│   │       ├── progress-matrix.tsx
│   │       ├── progress-bar.tsx
│   │       └── now-running.tsx
│   └── db/
│       └── schema.ts                       # + available_models column
├── agents/
│   ├── runtime/
│   │   └── Dockerfile                      # litmus/runtime-python
│   ├── cursor/
│   │   ├── run.sh
│   │   └── models.sh
│   ├── mock/
│   │   └── run.sh
│   ├── tests/
│   │   └── python.sh
│   ├── init.sh
│   └── scenarios/
│       ├── 1-data-structure/
│       │   ├── prompt.txt
│       │   ├── project/main.py
│       │   └── test.py
│       └── __test__/
│           └── 1-trivial-pass/
│               ├── prompt.txt
│               ├── project/main.py
│               ├── test.py
│               └── solution/main.py
├── scripts/
│   └── pack.ts                             # .litmus-pack generator
└── e2e/
    └── run-pipeline.test.ts                # e2e: pack → import → run → assert
```

---

## Deferred to Later Phases

| Item | Phase |
|------|-------|
| Scenarios CRUD (create/edit/delete via UI) | Phase 3 |
| `.litmus-pack` export | Phase 3 |
| Compare APIs + Leaderboard/Heatmap | Phase 3 |
| HostExecutor implementation | Phase 4 |
| KubernetesExecutor | Phase 5+ |
| Polyglot runtime (devcontainer.json) | When multi-language scenarios exist |
| Redis pub/sub (replace EventEmitter) | Phase 5+ (horizontal scaling) |
| Mobile-responsive Matrix Builder | Phase 4 |
| Settings page | Phase 4 |

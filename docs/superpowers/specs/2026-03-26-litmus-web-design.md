# Litmus Web: Independent Benchmarking Service

**Date:** 2026-03-26
**Status:** Approved
**Supersedes:** `2026-03-26-ux-redesign-design.md` (TUI→Web concept)

## Problem

Current Litmus exists as a Rust TUI and legacy Python CLI. Both are local-only tools that require all agents installed on the user's machine, store results in SQLite, and lack proper comparison capabilities. Team leads evaluating agent+model combinations need a web-based service with persistent storage, container-based agent execution, and rich data visualization.

## Target Users

- **Team lead / tech lead** choosing an agent+model combination for their team
- **Researcher** running comparisons and publishing results

## Architecture Decision

Litmus Web is a **fully independent service** — no shared code with the Rust or Python versions. It reads the same scenario format (`template/` structure) but manages its own storage, execution, and UI.

### Explicitly Dropped from Original Spec

The following features from `2026-03-26-ux-redesign-design.md` are intentionally omitted:

- **Radar chart view toggle** — heatmap + leaderboard are sufficient; radar adds complexity without insight for dense matrices
- **CLI launcher** (`litmus` opens browser) — out of scope; this is a standalone Docker Compose service, not a CLI wrapper
- **Auto-migration from SQLite** — no automatic import; a manual `scripts/import-sqlite.ts` migration script will be provided (see Migration section)

### Auth Model

**Unauthenticated, single-tenant, deploy behind a firewall/VPN.** Litmus Web is a team-internal tool, not a public SaaS. No login, no sessions, no RBAC. All API routes are open. S3 pre-signed URLs are not needed — Garage is accessed only from the `litmus-web` container via internal Docker network.

If multi-tenant deployment is needed later, add an auth middleware layer (e.g., NextAuth.js) — the API surface is compatible.

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Frontend** | Next.js 15 (App Router), React, Tailwind CSS | Server components for dashboard aggregations, single deployment |
| **ORM** | Drizzle ORM | SQL-first, type-safe, great for complex aggregations (leaderboard, heatmap) |
| **Database** | PostgreSQL 16 | Normalized schema, materialized views for aggregations |
| **Object Storage** | Garage (S3-compatible) + garage-web | Scenarios, artifacts, logs, packs |
| **Charts** | Recharts + custom heatmap component | Data-viz for scores, heatmaps, leaderboards |
| **Deployment** | Docker Compose | litmus-web + postgres + garage |
| **Agent Execution** | Testcontainers-inspired orchestrator | Docker containers or host processes |

## Container Architecture

```
docker-compose.yml
├── litmus-web          (Next.js :3000)          ── litmus-internal network
├── postgres            (PostgreSQL 16 :5432)    ── litmus-internal network
├── garage              (S3 :3900, Web :3902)    ── litmus-internal network
├── docker-socket-proxy (tecnativa :2375)        ── litmus-internal network
└── [on-demand]         litmus/runtime-polyglot   ── litmus-agents network (isolated)
                        + /opt/agent mount (claude|aider|opencode|kilocode)
                        + sleep infinity + docker exec per scenario
```

### Data Flows

1. **litmus-web → postgres**: scores, metrics, aggregations, agent/scenario metadata
2. **litmus-web → garage**: scenario files (prompts, tests, project/), run artifacts (logs, code)
3. **litmus-web → host**: agent execution via Docker socket or host process
4. **agent container → litmus-web**: results reconciliation callback on completion

### Docker Socket Security

Mounting `/var/run/docker.sock` into `litmus-web` grants root-equivalent host access. This is necessary for agent orchestration but is a security boundary concern, especially since agent containers run LLM-generated code.

**Required mitigations (both are mandatory):**

1. **Socket proxy:** `tecnativa/docker-socket-proxy` with whitelist limited to container lifecycle APIs (`CONTAINERS=1`, `IMAGES=1`, `NETWORKS=1`, `EXEC=1`; deny `VOLUMES`, `SWARM`, `NODES`, `SERVICES`). The `litmus-web` container connects to the proxy, never to the raw Docker socket.
2. **Network isolation:** Agent containers run in an isolated `litmus-agents` Docker network with no access to the `litmus-internal` network (where `litmus-web`, `postgres`, and `garage` communicate). Agent containers have outbound internet access (for LLM API calls) but cannot reach infrastructure services.

**Optional additional hardening:**
- Rootless Docker / Podman for defense-in-depth
- CPU/memory limits on agent containers (`--cpus`, `--memory`)
- Read-only root filesystem for agent containers with writable tmpfs for `/work`

## Database Schema (PostgreSQL)

### Reference Tables

```sql
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    version TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    provider TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,        -- e.g. "1-data-structure"
    name TEXT NOT NULL,
    description TEXT,
    version TEXT DEFAULT 'v1',
    language TEXT,
    tags TEXT[],
    max_score INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
    -- S3 key is derived: litmus-scenarios/{slug}/
    -- No separate s3_key column to avoid slug/path divergence
);
```

### Run Results

```sql
CREATE TABLE runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    config_snapshot JSONB             -- frozen matrix selection at run start
);

CREATE TABLE run_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id),
    model_id UUID NOT NULL REFERENCES models(id),
    scenario_id UUID NOT NULL REFERENCES scenarios(id),
    agent_version TEXT,               -- agent version snapshot at time of run
    scenario_version TEXT,            -- scenario version snapshot at time of run
    status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed', 'failed', 'error')),
    tests_passed INTEGER NOT NULL DEFAULT 0,
    tests_total INTEGER NOT NULL DEFAULT 0,
    total_score REAL NOT NULL DEFAULT 0,
        -- NORMALIZATION: total_score is ALWAYS stored as 0-100 percentage
        -- regardless of scenario max_score. Computed as:
        -- (raw_score / max_score) * 100 at insertion time.
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    judge_scores JSONB,               -- {"code_correctness": 9, "tool_efficiency": 7, ...}
    judge_model TEXT,
    artifacts_s3_key TEXT,            -- path in garage: artifacts/{run_id}/{agent}/{model}/{scenario}/
    error_message TEXT,               -- populated when status = 'failed' or 'error'
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_run_results_run ON run_results(run_id);
CREATE INDEX idx_run_results_agent_model ON run_results(agent_id, model_id);
CREATE INDEX idx_run_results_scenario ON run_results(scenario_id);
CREATE UNIQUE INDEX idx_run_results_unique_combo ON run_results(run_id, agent_id, model_id, scenario_id);
```

**Result states:**
- `completed` — agent ran successfully, scores populated
- `failed` — agent ran but produced failing tests or zero score; `error_message` may describe the failure
- `error` — agent crashed, Docker pull failed, timeout, etc.; no meaningful score; `error_message` required

The UI shows: completed = score cell, failed = score cell with warning indicator, error = red X icon.

### Agent Orchestration

```sql
CREATE TABLE agent_executors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    type TEXT NOT NULL CHECK (type IN ('docker', 'host', 'kubernetes')),
    -- For type='docker': agent scripts mounted from agents/scripts/{agent_slug}/
    agent_slug TEXT NOT NULL,          -- maps to agents/scripts/{slug}/ directory
    -- For type='host': binary path on the host machine
    binary_path TEXT,
    health_check TEXT,                 -- command to verify agent availability
    config JSONB DEFAULT '{}',         -- executor-specific settings (timeout, memory, cpu, etc.)
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**Agent invocation:** All executors call the same `run.sh` contract script. For Docker: `/opt/agent/run.sh` (volume-mounted). For Host: `agents/scripts/{slug}/run.sh` (local path). Arguments are always passed as an **argument array** (separate `argv` elements), never via shell string concatenation — prevents command injection from scenario prompts.

```sql
CREATE TABLE run_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_executor_id UUID NOT NULL REFERENCES agent_executors(id),
    model_id UUID NOT NULL REFERENCES models(id),
    scenario_id UUID NOT NULL REFERENCES scenarios(id),
    status TEXT DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    container_id TEXT,                 -- docker container ID (if applicable)
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    exit_code INTEGER,
    error_message TEXT
);

CREATE INDEX idx_run_tasks_run ON run_tasks(run_id);
CREATE INDEX idx_run_tasks_status ON run_tasks(status);
```

### Aggregation Views

```sql
-- Latest result per (agent, model, scenario) combo
-- Only includes completed/failed results (not errors)
CREATE MATERIALIZED VIEW latest_results AS
SELECT DISTINCT ON (agent_id, model_id, scenario_id)
    id, run_id, agent_id, model_id, scenario_id,
    agent_version, scenario_version, status,
    tests_passed, tests_total, total_score,
    duration_seconds, judge_scores, judge_model,
    artifacts_s3_key, created_at
FROM run_results
WHERE status IN ('completed', 'failed')
ORDER BY agent_id, model_id, scenario_id, created_at DESC;

CREATE UNIQUE INDEX idx_latest_results_pk
    ON latest_results(agent_id, model_id, scenario_id);

-- Model leaderboard: avg score across all agents and scenarios
CREATE MATERIALIZED VIEW score_by_model AS
SELECT
    model_id,
    AVG(total_score) AS avg_score,
    COUNT(DISTINCT agent_id) AS agent_count,
    COUNT(DISTINCT scenario_id) AS scenario_count,
    COUNT(*) AS result_count
FROM latest_results
GROUP BY model_id;

CREATE UNIQUE INDEX idx_score_by_model_pk ON score_by_model(model_id);

-- Agent leaderboard: avg score across all models and scenarios
CREATE MATERIALIZED VIEW score_by_agent AS
SELECT
    agent_id,
    AVG(total_score) AS avg_score,
    COUNT(DISTINCT model_id) AS model_count,
    COUNT(DISTINCT scenario_id) AS scenario_count,
    COUNT(*) AS result_count
FROM latest_results
GROUP BY agent_id;

CREATE UNIQUE INDEX idx_score_by_agent_pk ON score_by_agent(agent_id);
```

Heatmap queries use `latest_results` directly (no separate `score_matrix` view — it would be a redundant 1:1 copy).

**Materialized view refresh:** Views are refreshed via `REFRESH MATERIALIZED VIEW CONCURRENTLY` (requires unique indexes above). Refresh is **debounced**: a background job coalesces refresh requests within a 5-second window. If two runs complete near-simultaneously, only one refresh executes. This prevents lock contention under concurrent load.

## Agent Orchestration

### Libraries

| Library | npm Package | Role |
|---------|-------------|------|
| **dockerode** | `dockerode` (~2.7M dl/wk) | `DockerExecutor` — container create, exec, logs, volumes |
| **execa** | `execa` (millions dl/wk) | `HostExecutor` — subprocess on host, argument array safety |
| **@kubernetes/client-node** | `@kubernetes/client-node` (~1.2M dl/wk) | `KubernetesExecutor` — future, pods/exec/PVC |

No unified Docker+K8S abstraction exists. Our `AgentExecutor` interface IS the abstraction; each executor is a thin wrapper over one library.

### AgentExecutor Interface

```typescript
interface AgentExecutor {
    type: 'docker' | 'host' | 'kubernetes';

    // Create the execution environment (container or process)
    start(config: ExecutorConfig): Promise<Handle>;

    // Run a single scenario inside the running environment
    exec(handle: Handle, scenario: ScenarioTask): Promise<ExecResult>;

    // Collect artifacts from the session directory
    collectArtifacts(handle: Handle, scenario: ScenarioTask): Promise<ArtifactBundle>;

    // Tear down the environment
    stop(handle: Handle): Promise<void>;

    // Verify the agent is available
    healthCheck(): Promise<boolean>;
}

interface ExecResult {
    exitCode: number;       // 0 = success, 1 = tests failed, 2 = agent error
    testsPassed: number;
    testsTotal: number;
    durationSeconds: number;
}
```

### Container Lifecycle

**One container per (agent, model, run).** Scenarios run sequentially inside via `docker exec`.

```
+-- Run #42: Claude x Sonnet 4 x [scenario-1, scenario-2, scenario-3] --+
|                                                                         |
|  1. docker run -d litmus/runtime-polyglot sleep infinity                |
|     mount: /opt/agent (claude run.sh), /work (workspace)               |
|                                                                         |
|  2. docker exec -> /opt/agent/run.sh --scenario /work/1-data-struct    |
|     agent session: prompt -> code -> test -> fix -> test -> done        |
|     exit 0 -> reconciler writes run_results (completed)                |
|     artifacts uploaded to Garage                                        |
|                                                                         |
|  3. docker exec -> /opt/agent/run.sh --scenario /work/2-simple-arch    |
|     agent session: prompt -> code -> test -> done                      |
|     exit 1 -> reconciler writes run_results (failed)                   |
|     artifacts uploaded to Garage                                        |
|                                                                         |
|  4. docker exec -> /opt/agent/run.sh --scenario /work/3-api-design     |
|     ...                                                                 |
|                                                                         |
|  5. All scenarios done -> docker stop + docker rm                       |
|     enqueue materialized view refresh                                   |
+-------------------------------------------------------------------------+
```

**Key design decisions:**
- Container stays alive between scenarios (`sleep infinity` as PID 1) — no cold-start overhead per scenario
- Agent is **volume-mounted** (`/opt/agent/`), not baked into the image — one universal runtime image, agents swapped via mount
- Each scenario gets its own **session directory** (`/work/sessions/{scenario-slug}/`) — agent retains context within a scenario (e.g., retry loops when tests fail) but starts fresh for the next scenario
- Parallel execution: multiple (agent, model) containers can run concurrently; scenarios within a container are sequential

### Agent Runner Contract (`run.sh`)

Each agent implements a single entry script with a unified interface:

```bash
#!/bin/bash
# /opt/agent/run.sh — Litmus Agent Runner Contract
#
# INPUTS:
#   --model <model-name>          LLM model to use (e.g. "sonnet-4", "gpt-4o")
#   --scenario <path>             Path to scenario dir (contains prompt.txt, project/, test.py)
#   --session-dir <path>          Working directory for this scenario session
#   --max-retries <N>             Max retry attempts when tests fail (default: 3)
#
# EXIT CODES:
#   0  — success (tests passed)
#   1  — failure (tests did not pass after all retries)
#   2  — agent error (crash, timeout, API failure)
#
# EXPECTED BEHAVIOR:
#   1. Copy project/ from scenario dir into session-dir
#   2. Read prompt.txt, send to agent with --model
#   3. Agent generates/modifies code in session-dir
#   4. Run tests (pytest/jest/go test/etc. depending on scenario language)
#   5. If tests fail and retries remain: send failure output back to agent, goto 3
#   6. Write results to session-dir/test-results.json
#
# OUTPUT ARTIFACTS (written to --session-dir):
#   session-dir/code/              Generated/modified source code
#   session-dir/logs/agent.log     Full agent interaction log
#   session-dir/test-results.json  Unified test results format:
#     {
#       "tests_passed": 4,
#       "tests_total": 5,
#       "framework": "pytest",
#       "details": [
#         {"name": "test_insert", "status": "passed", "duration_ms": 120},
#         {"name": "test_delete", "status": "failed", "message": "AssertionError..."}
#       ]
#     }
```

Adding a new agent = writing one `run.sh` that follows this contract. The orchestrator does not change.

### Runtime Image: Dev Container Features

Instead of maintaining per-agent or per-language Dockerfiles, the universal runtime image is built using [Dev Container Features](https://containers.dev/features) — composable, independently-versioned runtime installers:

```jsonc
// agents/devcontainer.json
{
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": {
        "ghcr.io/devcontainers/features/python:1":  { "version": "3.12" },
        "ghcr.io/devcontainers/features/node:1":    { "version": "22" },
        "ghcr.io/devcontainers/features/go:1":      { "version": "1.23" },
        "ghcr.io/devcontainers/features/java:1":    { "version": "21" },
        "ghcr.io/devcontainers/features/common-utils:2": {}
    },
    "postCreateCommand": "bash /opt/setup/install-test-frameworks.sh"
}
```

```bash
# agents/setup/install-test-frameworks.sh
pip install pytest pytest-json-report
npm install -g jest
# Go test is built-in
# JUnit comes with Gradle (installed via java feature)
# Kotlin compiler installed via SDKMAN in java feature
apt-get install -y gcc g++ cmake  # C++ toolchain
```

**Build the image:**
```bash
npx @devcontainers/cli build \
    --workspace-folder ./agents \
    --image-name litmus/runtime-polyglot
```

**Result:** One ~3GB OCI image with all 6 language runtimes (Python, Node, Go, JDK/Kotlin, C++). Cached as a single Docker layer. Agent-specific tools (claude-code, aider) are NOT in the image — they are mounted at runtime via `/opt/agent/`.

**Adding a new language:** Add one line to `devcontainer.json` features, rebuild. All agents automatically get access.

**Dev Containers as build tool only:** The devcontainers CLI produces a standard OCI image. At runtime it is just a regular Docker image — no devcontainer dependency. This means the same image works in Docker Compose, Kubernetes, ECS, or any OCI-compatible runtime.

### Docker Executor (dockerode)

```typescript
// Simplified flow — actual implementation in lib/orchestrator/docker-executor.ts
import Docker from 'dockerode';

class DockerExecutor implements AgentExecutor {
    type = 'docker' as const;
    private docker = new Docker({ socketPath: '/var/run/docker-proxy.sock' });

    async start(config: ExecutorConfig): Promise<ContainerHandle> {
        const container = await this.docker.createContainer({
            Image: 'litmus/runtime-polyglot',
            Cmd: ['sleep', 'infinity'],
            HostConfig: {
                Binds: [
                    `${config.agentDir}:/opt/agent:ro`,
                    `${config.workspaceDir}:/work`,
                ],
                NetworkMode: 'litmus-agents',    // isolated network
                Memory: 4 * 1024 * 1024 * 1024,  // 4GB limit
                NanoCpus: 2 * 1e9,               // 2 CPU cores
            },
        });
        await container.start();
        return { containerId: container.id, container };
    }

    async exec(handle: ContainerHandle, scenario: ScenarioTask): Promise<ExecResult> {
        const execution = await handle.container.exec({
            Cmd: ['/opt/agent/run.sh',
                '--model', scenario.model,
                '--scenario', `/work/scenarios/${scenario.slug}`,
                '--session-dir', `/work/sessions/${scenario.slug}`,
                '--max-retries', '3',
            ],
            AttachStdout: true,
            AttachStderr: true,
        });
        const stream = await execution.start({});
        // stream logs to Garage in real-time...
        const info = await execution.inspect();
        return parseExecResult(info.ExitCode, `/work/sessions/${scenario.slug}`);
    }

    async stop(handle: ContainerHandle): Promise<void> {
        await handle.container.stop();
        await handle.container.remove();
    }
}
```

### Host Executor (execa)

```typescript
import { execa } from 'execa';

class HostExecutor implements AgentExecutor {
    type = 'host' as const;

    async exec(handle: ProcessHandle, scenario: ScenarioTask): Promise<ExecResult> {
        // Argument array — never shell string concatenation
        const result = await execa(handle.binaryPath, [
            'run', '--model', scenario.model,
            '--scenario', scenario.scenarioDir,
            '--session-dir', scenario.sessionDir,
            '--max-retries', '3',
        ], {
            timeout: 600_000,  // 10 min per scenario
            reject: false,     // don't throw on non-zero exit
        });
        return parseExecResult(result.exitCode, scenario.sessionDir);
    }
}
```

### Kubernetes Executor (future — @kubernetes/client-node)

Drop-in replacement when scaling beyond a single host. Same `run.sh` contract, same `sleep infinity` + exec pattern:

- `docker run` becomes `kubectl run` (or Pod/Job creation via API)
- `docker exec` becomes `kubectl exec` (or exec API call)
- Volume mounts become PVC or ConfigMap
- Agent mount via ConfigMap or init container

Implementation deferred to Phase 2. The `AgentExecutor` interface and `run.sh` contract are designed to support this without changes to the scheduler or reconciler.

### Results Reconciliation

After each scenario `exec` completes:

1. Executor reads `test-results.json` from the session directory
2. Artifacts (code/, logs/, test-results.json) uploaded to Garage at `artifacts/{run_id}/{agent}/{model}/{scenario}/`
3. `run_results` row inserted into PostgreSQL (status = completed | failed | error)
4. `run_tasks` status updated
5. SSE event emitted to connected clients

After ALL scenarios for a container complete:

6. Container stopped and removed
7. When all containers in a run complete -> enqueue materialized view refresh

### SSE Event Format

```typescript
// Scenario started within a container
{ type: 'task:started', runId, taskId, agent, model, scenario, timestamp }

// Scenario completed successfully
{ type: 'task:completed', runId, taskId, agent, model, scenario, score, testsPassed, testsTotal, duration }

// Scenario failed (agent ran but tests did not pass)
{ type: 'task:failed', runId, taskId, agent, model, scenario, score, errorMessage }

// Scenario error (agent crash, infra failure)
{ type: 'task:error', runId, taskId, agent, model, scenario, errorMessage }

// All scenarios done for one (agent, model)
{ type: 'container:finished', runId, agent, model, completedCount, failedCount, errorCount }

// Entire run complete
{ type: 'run:completed', runId, totalTasks, completedTasks, failedTasks, errorTasks }
```

## Screen Architecture

### Navigation

Compact pill-bar at the top (replaces the sidebar from the original spec). This maximizes horizontal space for data tables and heatmaps — critical for the "Lab Instrument" data density aesthetic. 5 items: Dashboard, Run, Compare, Scenarios, Settings.

Pill-bar height: 48px. On narrow viewports (<768px), collapses to a hamburger menu (deferred to Phase 4: Polish; desktop-only in initial implementation).

### 1. Dashboard

**Empty state:** Two prominent cards — "New Run" and "Compare" (disabled).

**With data:** 4 stat cards (Total Runs, Agents, Models, Avg Score) + quick-action cards (New Run, Compare) + Recent Activity table (run ID, agent×model combos, scenarios count, pass rate, date). Each row represents one run; the agent×model column aggregates all tested combinations as a comma-separated list.

### 2. Run Screen

#### 2a. Matrix Builder

Two-column layout replacing multi-step wizard:

**Left — Agents & Models:**
- Auto-detected agents as expandable cards
- Model chips (selectable tags) inside each agent card
- Text filter per agent for narrowing models
- "Show selected only" toggle
- Selected agents marked with accent-colored left border
- "+ Add agent" at bottom

**Right — Scenarios:**
- Checklist with "Select all" toggle
- Name + short description tag per scenario
- Selected count ("6 of 8 selected")

**Bottom — Summary Bar:**
- Live formula: "N agents × M models × K scenarios = **X runs**"
- "Start Run" button

#### 2b. Progress View

> **Note:** This layout supersedes the original spec's "rows=agents, columns=models, cells=scenario progress" design. The new layout provides per-scenario granularity which is more useful for identifying slow or failing scenarios.

Real-time matrix fill via SSE:

- Progress bar with completion count and ETA
- "Now running" indicator (Agent × Model × Scenario + elapsed time)
- Matrix table: rows = agent×model, columns = scenarios
  - Cells: completed score (color-coded), running (amber pulse), pending (dash), **failed** (score + warning icon), **error** (red X icon)
- First column (agent×model) is sticky on horizontal scroll for wide matrices (many scenarios)

### 3. Compare Screen

#### 3a. Lens Picker

2×2 grid of comparison modes:

| | Ranking (aggregated) | Detailed (anchor one) |
|---|---|---|
| **Models** | "Which model is best overall?" | "Agent × Models" — fix agent, vary models |
| **Agents** | "Which agent is best overall?" | "Model × Agents" — fix model, vary agents |

Each card shows data availability stats.

#### 3b. Leaderboard (Rankings lenses)

- Ranked list with medals, avg score, agent/model count
- Coverage bar per entry
- Warning icon when entity tested in ≤1 counterpart
- "Run more tests" link → prefilled Matrix Builder

#### 3c. Heatmap (all lenses)

- Rows = scenarios, columns = entities being compared
- Color-coded cells (5-point continuous scale)
- Best-in-row highlighted with accent outline
- TOTAL row with averages
- "—" for missing data
- Click any cell → drill-down

#### 3d. Detailed View (Agent × Models / Model × Agents)

Same heatmap as aggregated, plus:
- Filter bar at top to select the anchor entity (dropdown)
- **Winner callout** at bottom: "Best model for {agent}: {model} ({score}% avg)"

#### 3e. Drill-down (click cell)

**Left — Scores:**
- pytest results (N/M passed)
- Judge scores by criterion (if available)

**Right — Run Lineage:**
- All runs for this (agent, model, scenario), ordered by date
- Latest run (green badge, "used for scores") with: ID, date, agent version, scenario version, duration, links to Logs/Code in Garage
- Previous runs with diff indicators
- Trend: "+7% from previous run"

### 4. Scenarios Screen

#### 4a. Library

Grid of scenario cards: name, version badge, description, tags (language, category), usage stats.

Top actions: "Import pack" (from `.litmus-pack`), "+ New scenario".

#### 4b. Scenario Detail

Tabs: Prompt / Task / Scoring / Project files / Tests

Left: content viewer/editor. Right sidebar: metadata + performance stats (avg score, best/worst result).

### 5. Settings Screen

**Agents:** list with executor type (docker/host), version, status indicator, health check button.

**LLM Judge:** model, API key (masked), base URL. Toggle: "Auto-run judge after benchmark" (default: off). When enabled, the reconciler automatically submits completed results to the LLM judge.

**General:** Theme toggle (light/dark/system), parallel execution toggle.

## `.litmus-pack` Format

A ZIP archive for importing/exporting scenario bundles:

```
my-scenarios.litmus-pack          # actually a .zip
├── manifest.json
├── 1-data-structure/
│   ├── prompt.txt
│   ├── task.txt
│   ├── scoring.csv
│   └── project/
│       ├── main.py
│       └── test.py
├── 2-simple-architecture/
│   └── ...
└── ...
```

### manifest.json

```json
{
    "version": 1,
    "kind": "scenarios",
    "created_at": "2026-03-26T12:00:00Z",
    "scenarios": [
        {
            "slug": "1-data-structure",
            "name": "Data Structure",
            "version": "v1",
            "language": "python",
            "description": "Implement a binary search tree"
        }
    ]
}
```

**Import flow:** Upload `.litmus-pack` → extract manifest → for each scenario: create/update `scenarios` row in Postgres, upload files to `litmus-scenarios/{slug}/` in Garage.

**Export flow:** Select scenarios → fetch files from Garage → build ZIP with manifest → download.

## API Routes

```
POST   /api/runs                    Create a new run (matrix selection → run_tasks)
GET    /api/runs                    List runs with pagination and filters
GET    /api/runs/[runId]            Run status + task summary
GET    /api/runs/[runId]/stream     SSE progress stream
DELETE /api/runs/[runId]            Cancel/delete a run

GET    /api/compare/models          Model leaderboard (from score_by_model view)
GET    /api/compare/agents          Agent leaderboard (from score_by_agent view)
GET    /api/compare/heatmap         Heatmap matrix (from latest_results, with filter params)
GET    /api/compare/drilldown       Cell detail (all runs for agent×model×scenario)

GET    /api/scenarios               List all scenarios
POST   /api/scenarios               Create scenario (metadata + upload to S3)
GET    /api/scenarios/[id]          Scenario detail + files
PUT    /api/scenarios/[id]          Update scenario
DELETE /api/scenarios/[id]          Delete scenario + S3 cleanup
POST   /api/scenarios/import        Import .litmus-pack
GET    /api/scenarios/export        Export selected scenarios as .litmus-pack

GET    /api/agents                  List agents with executors
POST   /api/agents                  Add agent + executor config
PUT    /api/agents/[id]             Update agent/executor
POST   /api/agents/[id]/health      Run health check

GET    /api/settings                Get settings (judge config, preferences)
PUT    /api/settings                Update settings
```

## Design System

Aesthetic direction: **Lab Instrument** — precise, data-dense, monospace-accented. Inspired by oscilloscopes, scientific notebooks, Bloomberg Terminal.

Full design system saved in `docs/superpowers/specs/design-system/`.

### Typography

| Role | Font | Usage |
|------|------|-------|
| Data / Numbers / Labels | JetBrains Mono | Tables, scores, code, navigation labels |
| UI / Body | DM Sans | Descriptions, headings, body text |

### Dark Theme Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-base` | `#0C0E12` | Page background |
| `--bg-raised` | `#12151B` | Cards, panels |
| `--bg-overlay` | `#1A1D25` | Modals, dropdowns |
| `--bg-hover` | `#22252F` | Interactive hover states |
| `--text-primary` | `#E8E9ED` | Main text |
| `--text-secondary` | `#8B8FA3` | Secondary text |
| `--text-muted` | `#555970` | Tertiary, labels |
| `--accent` | `#D4A041` | Amber accent (warm, instrumental) |
| `--accent-dim` | `rgba(212,160,65,0.12)` | Active nav items, selected states |
| `--lens-ranking` | `#6B8AFF` | Ranking lens cards |
| `--lens-detail` | `#5EC4B6` | Detail lens cards |

### Light Theme Tokens (Pastel)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-base` | `#FAF9F7` | Warm ivory page background |
| `--bg-raised` | `#FFFFFF` | Cards, panels |
| `--bg-overlay` | `#F3F1ED` | Modals, dropdowns |
| `--bg-hover` | `#EBE9E4` | Interactive hover states |
| `--text-primary` | `#2C2C30` | Main text |
| `--text-secondary` | `#6E6E7A` | Secondary text |
| `--text-muted` | `#A5A5B0` | Tertiary, labels |
| `--accent` | `#C49335` | Deeper amber for light backgrounds |
| `--accent-dim` | `rgba(196,147,53,0.08)` | Active nav items |
| `--lens-ranking` | `#7B96E8` | Ranking lens (pastel blue) |
| `--lens-ranking-bg` | `#E8EDFB` | Ranking lens card background (lavender) |
| `--lens-detail` | `#6BB8AD` | Detail lens (pastel teal) |
| `--lens-detail-bg` | `#DEF2EF` | Detail lens card background (seafoam) |

### Score Scale (5-point continuous)

`total_score` is **always stored as a 0-100 percentage** regardless of scenario `max_score`. Normalization happens at insertion time: `(raw_score / max_score) * 100`.

| Level | Dark Text | Dark BG | Light Text | Light BG |
|-------|-----------|---------|------------|----------|
| Excellent (85-100) | `#3DD68C` | `rgba(61,214,140,0.18)` | `#2D7A4A` | `#D5F0E2` (mint) |
| Good (70-84) | `#7BC67E` | `rgba(123,198,126,0.13)` | `#4E8A52` | `#E4F2E5` (sage) |
| Mid (50-69) | `#C9B44E` | `rgba(201,180,78,0.13)` | `#8D7B2A` | `#F5F0D8` (cream) |
| Poor (30-49) | `#D4763A` | `rgba(212,118,58,0.13)` | `#A85E2A` | `#F8E8D8` (peach) |
| Fail (0-29) | `#C94444` | `rgba(201,68,68,0.13)` | `#A8393B` | `#F8DEDE` (blush) |

### Theme Switching

- `html[data-theme="dark"]` / `html[data-theme="light"]` CSS variable swap
- Respects `prefers-color-scheme` system preference
- User toggle in Settings, persisted to localStorage
- Heatmap best-in-row highlighted with `outline: 2px solid var(--accent)`

### Navigation

Compact pill-bar (not sidebar). Subtle grid-pattern background texture for depth.

## Object Storage Layout (Garage)

```
litmus-scenarios/
├── {scenario-slug}/
│   ├── prompt.txt
│   ├── task.txt
│   ├── scoring.csv
│   └── project/
│       ├── main.py
│       └── test.py

litmus-artifacts/
├── {run-id}/
│   └── {agent-name}/
│       └── {model-name}/
│           └── {scenario-slug}/
│               ├── logs.txt
│               ├── code.zip
│               └── test-results.json

litmus-packs/
├── {pack-name}.litmus-pack
```

Three Garage buckets: `litmus-scenarios`, `litmus-artifacts`, `litmus-packs`.

## Docker Compose Structure

```yaml
# web/docker-compose.yml
services:
  litmus-web:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://litmus:litmus@postgres:5432/litmus
      S3_ENDPOINT: http://garage:3900
      S3_ACCESS_KEY: ...
      S3_SECRET_KEY: ...
      DOCKER_HOST: tcp://docker-socket-proxy:2375
    volumes:
      - ./agents/scripts:/opt/agent:ro       # agent run.sh scripts
      - agent-workspaces:/var/litmus/work     # shared workspace volume
    networks:
      - litmus-internal
    depends_on:
      postgres: { condition: service_healthy }
      garage: { condition: service_started }
      docker-socket-proxy: { condition: service_started }

  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:latest
    environment:
      CONTAINERS: 1        # create/start/stop/remove containers
      IMAGES: 1            # pull images
      NETWORKS: 1          # connect to litmus-agents network
      EXEC: 1              # docker exec into running containers
      POST: 1              # allow POST requests
      VOLUMES: 0           # deny volume creation from proxy
      SWARM: 0
      NODES: 0
      SERVICES: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - litmus-internal
    # NOTE: only litmus-web can reach this proxy (litmus-internal network)

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: litmus
      POSTGRES_USER: litmus
      POSTGRES_PASSWORD: litmus
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U litmus"]
      interval: 5s
      retries: 5
    networks:
      - litmus-internal

  garage:
    image: dxflrs/garage:v1.1.0
    ports:
      - "3900:3900"   # S3 API
      - "3902:3902"   # Web UI
    volumes:
      - garage-data:/var/lib/garage/data
      - garage-meta:/var/lib/garage/meta
      - ./garage.toml:/etc/garage.toml
    networks:
      - litmus-internal

networks:
  litmus-internal:
    # postgres, garage, litmus-web, docker-socket-proxy
    internal: true
  litmus-agents:
    # agent containers only; outbound internet for LLM API calls
    # no access to litmus-internal services

volumes:
  pgdata:
  garage-data:
  garage-meta:
  agent-workspaces:
```

Agent containers are created programmatically by `DockerExecutor` via the socket proxy. They are attached to the `litmus-agents` network and have NO access to `litmus-internal` (postgres, garage, socket proxy).

## Project Directory Structure

```
web/
├── docker-compose.yml
├── Dockerfile
├── garage.toml
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── drizzle/
│   ���── migrations/                  # SQL migration files
├── src/
│   ├── app/
│   │   ├── layout.tsx               # Root layout with nav pill-bar
│   │   ├── page.tsx                 # Dashboard
│   │   ├── run/
│   │   │   ├── page.tsx             # Matrix Builder
│   │   │   └── [runId]/
│   │   │       └── page.tsx         # Progress View
│   │   ├── compare/
│   │   │   ├── page.tsx             # Lens Picker
│   │   │   ├── models/page.tsx      # Compare Models (leaderboard + heatmap)
│   │   │   ├── agents/page.tsx      # Compare Agents
│   │   │   ├── agent-models/page.tsx # Agent × Models (detailed)
│   │   │   └── model-agents/page.tsx # Model × Agents (detailed)
│   │   ├── scenarios/
│   │   │   ├── page.tsx             # Scenario library
│   │   │   └── [id]/page.tsx        # Scenario detail
│   │   ├── settings/
│   │   │   └── page.tsx
│   │   └── api/
│   │       ├── runs/
│   │       │   ├── route.ts         # POST create, GET list
│   │       │   └── [runId]/
│   │       │       ├── route.ts     # GET status, DELETE cancel
│   │       │       └── stream/route.ts  # SSE progress
│   │       ├── compare/
│   │       │   ├── models/route.ts  # GET model leaderboard
│   │       │   ├── agents/route.ts  # GET agent leaderboard
│   │       │   ├── heatmap/route.ts # GET heatmap matrix
│   │       │   └── drilldown/route.ts # GET cell detail
│   │       ├── scenarios/
│   │       │   ├── route.ts         # GET list, POST create
│   │       │   ├── [id]/route.ts    # GET/PUT/DELETE
│   │       │   ├── import/route.ts  # POST import .litmus-pack
│   │       │   └── export/route.ts  # GET export .litmus-pack
│   │       ├── agents/
│   │       │   ├── route.ts         # GET list, POST add
│   │       │   └── [id]/
│   │       │       ├── route.ts     # PUT update
│   │       │       └── health/route.ts  # POST health check
│   │       └── settings/route.ts    # GET/PUT
│   ├── db/
│   │   ├── schema.ts                # Drizzle schema definitions
│   │   ├── queries.ts               # Query helpers
│   │   └── views.ts                 # Materialized view refresh logic (debounced)
│   ├── lib/
│   │   ├── s3.ts                    # Garage/S3 client
│   │   ├── orchestrator/
│   │   │   ├── types.ts             # AgentExecutor interface
│   │   │   ├── docker-executor.ts   # Docker-based agent execution
│   │   │   ├── host-executor.ts     # Host process execution
│   │   │   ├── reconciler.ts        # Result collection + DB write
│   │   │   └── scheduler.ts         # Lane-based task scheduling
│   │   └── theme.ts                 # Theme management (dark/light/system)
│   ├── components/
│   │   ├── ui/                      # Primitive components (card, badge, table)
│   │   ├── nav-bar.tsx              # Pill navigation
│   │   ├── stat-card.tsx
│   │   ├── heatmap.tsx              # Color-coded score matrix
│   │   ├── leaderboard.tsx
│   │   ├── matrix-builder.tsx       # Agent×Model selector
│   │   ├── scenario-checklist.tsx
│   │   ├── progress-matrix.tsx      # Real-time SSE progress
│   │   ├── lens-picker.tsx
│   │   ├── drill-down.tsx           # Cell detail panel
│   │   └── theme-toggle.tsx
│   └── styles/
│       ├── globals.css              # CSS variables (dark + light tokens)
│       └── fonts.ts                 # JetBrains Mono + DM Sans setup
├── scripts/
│   └── import-sqlite.ts             # Migration script: import from Rust TUI's litmus.db
├── agents/
│   ├── devcontainer.json            # Dev Container Features: Python, Node, Go, JDK, C++
│   ├── setup/
│   │   └── install-test-frameworks.sh  # pytest, jest, junit, gtest
│   └── scripts/
│       ├── claude/
│       │   ├── run.sh               # Agent runner contract implementation
│       │   └── install.sh           # npm install -g @anthropic-ai/claude-code
│       ├── aider/
│       │   ├── run.sh
│       │   └── install.sh           # pip install aider-chat
│       ├── opencode/
│       │   ├── run.sh
│       │   └── install.sh           # go install binary
│       └── kilocode/
│           ├── run.sh
│           └── install.sh           # npm install -g kilocode
└── public/
    └── ...
```

## Migration and Backup

### Migration from Rust TUI

A manual migration script (`scripts/import-sqlite.ts`) reads the existing SQLite `litmus.db` and:

1. Creates agent/model/scenario reference rows if not exists
2. Maps `run_results` rows to the normalized Postgres schema
3. Copies `results/` directory artifacts to Garage
4. Reports import summary (N results imported, M skipped as duplicates)

Run via: `npx tsx scripts/import-sqlite.ts --db path/to/litmus.db --results path/to/results/`

### Backup

**PostgreSQL:** Add a `postgres-backup` service to docker-compose (or cron on host):

```bash
# Daily pg_dump to a mounted volume
pg_dump -U litmus litmus | gzip > /backups/litmus-$(date +%Y%m%d).sql.gz
```

**Garage:** Garage's built-in replication handles durability. For external backup, use `rclone sync` from the S3 endpoint to a remote target.

## Design Principles

1. **Run first, compare second** — matrix builder is 1 screen, not 4 steps
2. **Lenses, not modes** — comparison views are filters on accumulated data
3. **Show data coverage** — warn when rankings backed by sparse data
4. **Trace everything** — every score links to Run → Artifacts in S3
5. **Progressive disclosure** — dashboard → lens → heatmap → drill-down → logs
6. **Lab Instrument aesthetic** — precise, data-dense, monospace data, warm amber accent

## Design Assets

Visual mockups and design system reference files are in:

```
docs/superpowers/specs/design-system/
├── dark-theme.html                  # Full dark design system
├── light-dark-comparison.html       # Side-by-side pastel light + dark
├── wireframes-dashboard-run.html    # Dashboard + Matrix Builder wireframes
├── wireframes-progress-compare.html # Progress + Compare wireframes
└── architecture-diagram.html        # Container architecture diagram
```

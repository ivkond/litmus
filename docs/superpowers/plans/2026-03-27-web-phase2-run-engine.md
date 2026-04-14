# Phase 2: Run Engine — Implementation Plan

> **Status: ✅ COMPLETED** — 2026-03-27. All 16 tasks (78 steps) implemented + 3 rounds of code review fixes applied.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Enable end-to-end benchmark execution — matrix builder → Docker orchestration → real-time SSE progress → result reconciliation.

**Architecture:** Two waves — backend engine first (testable via `curl`), then UI. Lane-based scheduler creates one Docker container per (agent, model) pair. Scripts (`init.sh`, `run.sh`, `test.sh`) run inside containers via `docker exec`. Results flow through reconciler (evaluate → finalize) to DB and S3. SSE via in-process EventEmitter.

**Tech Stack:** Next.js 16, Drizzle ORM, PostgreSQL, dockerode, Garage S3, Zod, adm-zip, EventEmitter, Vitest (unit/integration), SSE.

**Spec:** `docs/superpowers/specs/2026-03-27-web-phase2-run-engine-design.md`

---

## File Map

```
web/
├── src/
│   ├── app/api/
│   │   ├── runs/
│   │   │   ├── route.ts                      # POST (create run), GET (list runs)
│   │   │   └── [runId]/
│   │   │       ├── route.ts                  # GET (run status), DELETE (cancel)
│   │   │       └── stream/route.ts           # GET (SSE stream)
│   │   ├── agents/
│   │   │   ├── route.ts                      # GET (list), POST (create)
│   │   │   └── [id]/
│   │   │       ├── route.ts                  # PUT (update)
│   │   │       ├── health/route.ts           # POST (health check)
│   │   │       └── models/route.ts           # POST (discover models)
│   │   └── scenarios/
│   │       ├── route.ts                      # GET (list scenarios)
│   │       └── import/route.ts               # POST (import .litmus-pack)
│   ├── app/run/
│   │   ├── page.tsx                          # Matrix Builder (replace stub)
│   │   └── [runId]/page.tsx                  # Progress View (new)
│   ├── lib/orchestrator/
│   │   ├── types.ts                          # Interfaces: AgentExecutor, Handle, ExecResult, SSE events
│   │   ├── event-bus.ts                      # RunEventBus (typed EventEmitter wrapper)
│   │   ├── docker-executor.ts                # DockerExecutor implements AgentExecutor
│   │   ├── reconciler.ts                     # evaluate() + finalize()
│   │   └── scheduler.ts                      # Lane-based scheduling + retry loop
│   ├── components/
│   │   ├── matrix-builder/
│   │   │   ├── agent-card.tsx                # Agent selection card with model chips
│   │   │   ├── scenario-list.tsx             # Scenario checklist
│   │   │   └── summary-bar.tsx               # "N×M×K = X runs" + Start button
│   │   └── progress/
│   │       ├── progress-matrix.tsx           # SSE-driven matrix table
│   │       ├── progress-bar.tsx              # completed/total + ETA
│   │       └── now-running.tsx               # Current task indicator
│   └── db/schema.ts                          # + error/cancelled enums, available_models
├── agents/
│   ├── runtime/Dockerfile                    # litmus/runtime-python image
│   ├── init.sh                               # Workspace preparation (shared)
│   ├── cursor/
│   │   ├── run.sh                            # Cursor CLI agent
│   │   └── models.sh                         # Cursor model discovery
│   ├── mock/
│   │   └── run.sh                            # Deterministic mock (copies solution/)
│   ├── tests/
│   │   └── python.sh                         # pytest → test-results.json
│   └── scenarios/
│       ├── 1-data-structure/                 # Real scenario
│       │   ├── prompt.txt
│       │   ├── project/main.py
│       │   └── test.py
│       └── __test__/
│           └── 1-trivial-pass/               # Deterministic e2e scenario
│               ├── prompt.txt
│               ├── project/main.py
│               ├── test.py
│               └── solution/main.py
├── scripts/pack.ts                           # .litmus-pack generator
├── e2e/run-pipeline.test.ts                  # Full pipeline e2e
└── vitest.config.ts                          # Test configuration (new)
```

---

## Wave 1 — Backend Engine

### Task 1: Infrastructure Setup

**Files:**
- Modify: `web/src/db/schema.ts` (lines 47-49, 103-104, add column to agents)
- Modify: `web/docker-compose.yml` (lines 14-16, 88-92)
- Modify: `web/.gitignore`
- Modify: `web/src/lib/env.ts` (add WORK_ROOT, AGENTS_HOST_DIR, WORK_HOST_DIR)
- Modify: `web/.env.example`
- Create: `web/agents/runtime/Dockerfile`

- [x] **Step 1: Extend status enums in Drizzle schema**

In `web/src/db/schema.ts`, update the `runs.status` enum and `runTasks.status` enum to include `'error'` and `'cancelled'`:

```typescript
// line 47-49: runs table — change enum
status: text('status', {
  enum: ['pending', 'running', 'completed', 'failed', 'error', 'cancelled'],
}).default('pending').notNull(),
```

```typescript
// line 103-104: runTasks table — change enum
status: text('status', {
  enum: ['pending', 'running', 'completed', 'failed', 'error', 'cancelled'],
}).default('pending').notNull(),
```

Add `attempt` and `maxAttempts` columns to `runResults` table (after `durationSeconds`, ~line 67):

```typescript
attempt: integer('attempt').notNull().default(1),
maxAttempts: integer('max_attempts').notNull().default(1),
```

These columns persist the final attempt number and configured max for SSE replay on reconnection.

- [x] **Step 2: Add `availableModels` column to agents table**

In `web/src/db/schema.ts`, add to `agents` table definition (after `createdAt`, line 19):

```typescript
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  version: text('version'),
  availableModels: jsonb('available_models').default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
```

- [x] **Step 3: Generate and run migration**

```bash
cd web && npm run db:generate
```

Review the generated SQL in `web/drizzle/` — it should add `error`/`cancelled` to check constraints, `available_models` JSONB column, and `attempt`/`max_attempts` integer columns on `run_results`. Then:

```bash
npm run db:migrate
```

- [x] **Step 4: Add env vars for path resolution**

In `web/src/lib/env.ts`:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('garage'),
  DOCKER_HOST: z.string().default('tcp://localhost:2375'),
  WORK_ROOT: z.string().default('./work'),
  AGENTS_HOST_DIR: z.string().optional(),
  WORK_HOST_DIR: z.string().optional(),
});

export const env = envSchema.parse(process.env);
```

In `web/.env.example`, append:

```
WORK_ROOT=./work
# AGENTS_HOST_DIR=     # host path to web/ dir (containerized only)
# WORK_HOST_DIR=       # host path to work/ dir (containerized only)
```

- [x] **Step 5: Update docker-compose.yml — bind mount + env vars**

In `web/docker-compose.yml`, update the `litmus-web` service:

```yaml
  litmus-web:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://litmus:litmus@postgres:5432/litmus
      S3_ENDPOINT: http://garage:3900
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      S3_REGION: garage
      DOCKER_HOST: tcp://docker-socket-proxy:2375
      AGENTS_HOST_DIR: ${AGENTS_HOST_DIR:-.}
      WORK_HOST_DIR: ${WORK_HOST_DIR:-./work}
      WORK_ROOT: /var/litmus/work
    volumes:
      - ./agents:/opt/agent:ro
      - ./work:/var/litmus/work
    networks:
      - litmus-internal
      - litmus-host
    depends_on:
      postgres:
        condition: service_healthy
      garage:
        condition: service_started
      docker-socket-proxy:
        condition: service_started
    profiles: ["full"]
```

Remove `agent-workspaces:` from the `volumes:` section at the bottom of the file. Keep only:

```yaml
volumes:
  pgdata:
  garage-data:
  garage-meta:
```

- [x] **Step 6: Add `work/` to .gitignore**

Append to `web/.gitignore`:

```
# agent workspaces (runtime data)
/work
```

- [x] **Step 7: Create runtime Dockerfile**

Create `web/agents/runtime/Dockerfile`:

```dockerfile
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pytest pytest-json-report

# Cursor CLI — Phase 2 shortcut, baked into image
RUN curl -fsSL https://www.cursor.com/install.sh | bash

WORKDIR /work
CMD ["sleep", "infinity"]
```

- [x] **Step 8: Build runtime image**

```bash
cd web && docker build -t litmus/runtime-python agents/runtime/
```

Expected: image builds successfully (~200MB).

- [x] **Step 9: Commit**

```bash
git add web/src/db/schema.ts web/docker-compose.yml web/.gitignore \
        web/src/lib/env.ts web/.env.example web/agents/runtime/Dockerfile \
        web/drizzle/
git commit -m "feat(web): Phase 2 infrastructure — schema migration, bind mount, runtime image"
```

---

### Task 2: Agent Scripts + Test Scenarios

**Files:**
- Create: `web/agents/init.sh`
- Create: `web/agents/cursor/run.sh`
- Create: `web/agents/cursor/models.sh`
- Create: `web/agents/mock/run.sh`
- Create: `web/agents/tests/python.sh`
- Create: `web/agents/scenarios/__test__/1-trivial-pass/prompt.txt`
- Create: `web/agents/scenarios/__test__/1-trivial-pass/project/main.py`
- Create: `web/agents/scenarios/__test__/1-trivial-pass/test.py`
- Create: `web/agents/scenarios/__test__/1-trivial-pass/solution/main.py`
- Create: `web/agents/scenarios/1-data-structure/prompt.txt`
- Create: `web/agents/scenarios/1-data-structure/project/main.py`
- Create: `web/agents/scenarios/1-data-structure/test.py`

- [x] **Step 1: Create `init.sh` — shared workspace preparation**

Create `web/agents/init.sh`:

```bash
#!/bin/bash
set -euo pipefail

# init.sh — Prepare workspace for agent execution
# Contract: --scenario <path> --workspace <path>
# Copies ALL scenario files into workspace, installs deps if needed
# Exit: 0 = ready, 2 = error

SCENARIO=""
WORKSPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario) SCENARIO="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SCENARIO" || -z "$WORKSPACE" ]]; then
  echo "Usage: init.sh --scenario <path> --workspace <path>" >&2
  exit 2
fi

# Create workspace structure
mkdir -p "$WORKSPACE/logs"

# Copy ALL scenario contents into workspace (preserves directory structure).
# This includes project/, test files, fixtures, data, templates, and any
# language-specific assets — anything the scenario author ships.
cp -a "$SCENARIO"/. "$WORKSPACE/"
# Remove orchestrator-only files that shouldn't be in the workspace
rm -f "$WORKSPACE/prompt.txt" "$WORKSPACE/manifest.json"

# Install Python deps if requirements.txt exists
if [[ -f "$WORKSPACE/project/requirements.txt" ]]; then
  pip install -q -r "$WORKSPACE/project/requirements.txt"
fi

echo "Workspace ready: $WORKSPACE"
```

- [x] **Step 2: Create `mock/run.sh` — deterministic mock agent**

Create `web/agents/mock/run.sh`:

```bash
#!/bin/bash
set -euo pipefail

# mock/run.sh — Copies pre-built solution into project/
# Contract: --model <model> --prompt <text> --workspace <path> --scenario-dir <path>
# Exit: 0 = done, 2 = error

MODEL=""
PROMPT=""
WORKSPACE=""
SCENARIO_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --scenario-dir) SCENARIO_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$WORKSPACE" || -z "$SCENARIO_DIR" ]]; then
  echo "Usage: mock/run.sh --model <m> --prompt <p> --workspace <path> --scenario-dir <path>" >&2
  exit 2
fi

SOLUTION_DIR="$SCENARIO_DIR/solution"
if [[ ! -d "$SOLUTION_DIR" ]]; then
  echo "Error: no solution/ directory in $SCENARIO_DIR" >&2
  exit 2
fi

# Copy solution files into project/ (same location a real agent would modify)
cp -r "$SOLUTION_DIR/"* "$WORKSPACE/project/"

echo "Mock agent: copied solution from $SOLUTION_DIR to $WORKSPACE/project/"
```

- [x] **Step 3: Create `cursor/run.sh` — Cursor CLI agent**

Create `web/agents/cursor/run.sh`:

```bash
#!/bin/bash
set -euo pipefail

# cursor/run.sh — Run Cursor CLI agent
# Contract: --model <model> --prompt <text> --workspace <path> --scenario-dir <path>
# Requires: CURSOR_API_KEY env var
# Exit: 0 = done, 2 = agent error

MODEL=""
PROMPT=""
WORKSPACE=""
SCENARIO_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --scenario-dir) SCENARIO_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MODEL" || -z "$PROMPT" || -z "$WORKSPACE" ]]; then
  echo "Usage: cursor/run.sh --model <m> --prompt <p> --workspace <path> --scenario-dir <path>" >&2
  exit 2
fi

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Error: CURSOR_API_KEY not set" >&2
  exit 2
fi

# Run Cursor agent in headless mode
cursor agent -p "$PROMPT" \
    --model "$MODEL" \
    --workspace "$WORKSPACE" \
    --force --trust --print \
    2>&1 | tee "$WORKSPACE/logs/agent.log"
```

- [x] **Step 4: Create `cursor/models.sh` — model discovery**

Create `web/agents/cursor/models.sh`:

```bash
#!/bin/bash
set -euo pipefail

# cursor/models.sh — Discover available Cursor models
# Requires: CURSOR_API_KEY env var
# Output: JSON array to stdout

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Error: CURSOR_API_KEY not set" >&2
  exit 2
fi

# Cursor CLI: list available models as JSON
# Fallback: hardcoded list if CLI doesn't support model listing yet
if cursor models --json 2>/dev/null; then
  exit 0
fi

# Fallback: known Cursor-supported models
cat <<'EOF'
[
  {"id": "gpt-4o", "name": "GPT-4o", "provider": "OpenAI"},
  {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "provider": "Anthropic"},
  {"id": "claude-3.5-sonnet", "name": "Claude 3.5 Sonnet", "provider": "Anthropic"},
  {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "provider": "Google"}
]
EOF
```

- [x] **Step 5: Create `tests/python.sh` — pytest runner**

Create `web/agents/tests/python.sh`:

```bash
#!/bin/bash
set -euo pipefail

# tests/python.sh — Run pytest and write test-results.json
# Contract: --workspace <path> --output <path>
# Exit: 0 = all pass, 1 = some fail, 2 = infra error

WORKSPACE=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$WORKSPACE" || -z "$OUTPUT" ]]; then
  echo "Usage: tests/python.sh --workspace <path> --output <path>" >&2
  exit 2
fi

cd "$WORKSPACE"

# Run pytest with JSON report
REPORT_FILE="$WORKSPACE/.report.json"

pytest test.py \
  --json-report \
  --json-report-file="$REPORT_FILE" \
  -q 2>&1 || TEST_EXIT=$?

TEST_EXIT=${TEST_EXIT:-0}

# Parse pytest-json-report into our canonical format
if [[ -f "$REPORT_FILE" ]]; then
  python3 -c "
import json, sys

with open('$REPORT_FILE') as f:
    report = json.load(f)

tests = report.get('tests', [])
passed = sum(1 for t in tests if t['outcome'] == 'passed')
total = len(tests)
details = []
for t in tests:
    details.append({
        'name': t.get('nodeid', '').split('::')[-1],
        'status': 'passed' if t['outcome'] == 'passed' else 'failed',
        'duration_ms': int((t.get('duration', 0)) * 1000),
        'message': t.get('call', {}).get('longrepr', '') if t['outcome'] != 'passed' else ''
    })

result = {
    'tests_passed': passed,
    'tests_total': total,
    'framework': 'pytest',
    'details': details
}

with open('$OUTPUT', 'w') as f:
    json.dump(result, f, indent=2)
"
else
  # pytest didn't produce a report — infra error
  echo '{"tests_passed":0,"tests_total":0,"framework":"pytest","details":[]}' > "$OUTPUT"
  exit 2
fi

exit $TEST_EXIT
```

- [x] **Step 6: Make scripts executable**

```bash
chmod +x web/agents/init.sh
chmod +x web/agents/mock/run.sh
chmod +x web/agents/cursor/run.sh
chmod +x web/agents/cursor/models.sh
chmod +x web/agents/tests/python.sh
```

- [x] **Step 7: Create `__test__/1-trivial-pass` scenario**

Create `web/agents/scenarios/__test__/1-trivial-pass/prompt.txt`:

```
Implement the `add(a, b)` function in `project/main.py` that returns the sum of two numbers.
```

Create `web/agents/scenarios/__test__/1-trivial-pass/project/main.py`:

```python
def add(a, b):
    pass  # TODO: implement
```

Create `web/agents/scenarios/__test__/1-trivial-pass/test.py`:

```python
from project.main import add


def test_add_positive():
    assert add(2, 3) == 5


def test_add_negative():
    assert add(-1, -2) == -3


def test_add_zero():
    assert add(0, 0) == 0
```

Create `web/agents/scenarios/__test__/1-trivial-pass/solution/main.py`:

```python
def add(a, b):
    return a + b
```

- [x] **Step 8: Create `1-data-structure` scenario (real)**

Create `web/agents/scenarios/1-data-structure/prompt.txt`:

```
Implement a Stack class in `project/main.py` with push(value), pop(), peek(), and is_empty() methods.
The stack should raise IndexError when popping or peeking an empty stack.
```

Create `web/agents/scenarios/1-data-structure/project/main.py`:

```python
class Stack:
    """A stack data structure. Implement push, pop, peek, and is_empty."""
    pass
```

Create `web/agents/scenarios/1-data-structure/test.py`:

```python
import pytest
from project.main import Stack


def test_push_and_pop():
    s = Stack()
    s.push(1)
    s.push(2)
    assert s.pop() == 2
    assert s.pop() == 1


def test_peek():
    s = Stack()
    s.push(42)
    assert s.peek() == 42
    assert s.pop() == 42


def test_is_empty():
    s = Stack()
    assert s.is_empty() is True
    s.push(1)
    assert s.is_empty() is False


def test_pop_empty_raises():
    s = Stack()
    with pytest.raises(IndexError):
        s.pop()


def test_peek_empty_raises():
    s = Stack()
    with pytest.raises(IndexError):
        s.peek()
```

- [x] **Step 9: Commit**

```bash
git add web/agents/
git commit -m "feat(web): add agent scripts, test runner, and seed scenarios"
```

---

### Task 3: Install Test Dependencies + Orchestrator Types

**Files:**
- Modify: `web/package.json` (add vitest, adm-zip)
- Create: `web/vitest.config.ts`
- Create: `web/src/lib/orchestrator/types.ts`

- [x] **Step 1: Install dependencies**

```bash
cd web && npm install adm-zip && npm install -D vitest @types/adm-zip
```

`adm-zip` is for `.litmus-pack` ZIP handling. `vitest` for unit/integration tests.

- [x] **Step 2: Create vitest config**

Create `web/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [x] **Step 3: Add test script to package.json**

In `web/package.json`, add to scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [x] **Step 4: Create orchestrator types**

Create `web/src/lib/orchestrator/types.ts`:

```typescript
// ─── Executor Interface ────────────────────────────────────────

export interface AgentExecutor {
  type: 'docker' | 'host' | 'kubernetes';
  start(config: ExecutorConfig): Promise<ExecutorHandle>;
  exec(handle: ExecutorHandle, cmd: string[], env?: Record<string, string>): Promise<ExecResult>;
  stop(handle: ExecutorHandle): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export interface ExecutorHandle {
  containerId: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecutorConfig {
  image: string;
  agentHostDir: string;
  workHostDir: string;
  runId: string;
  env: Record<string, string>;
  labels?: Record<string, string>;
  limits?: { memory: number; cpus: number };
  network?: string;
  timeoutSeconds?: number;
}

// ─── Reconciler ────────────────────────────────────────────────

export interface EvalResult {
  allPassed: boolean;
  testsPassed: number;
  testsTotal: number;
  totalScore: number;
  testOutput: string;
  details: TestDetail[];
  attempt?: number;      // final attempt number (set by scheduler before finalize)
  maxAttempts?: number;  // total attempts allowed (set by scheduler before finalize)
}

export interface TestDetail {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  message: string;
}

export interface TaskMeta {
  runId: string;
  taskId: string;
  agentId: string;
  modelId: string;
  scenarioId: string;
  agentSlug: string;
  modelSlug: string;
  scenarioSlug: string;
  attempt: number;
  maxAttempts: number;
  startedAt: Date;
}

// ─── SSE Events ────────────────────────────────────────────────

export type RunEvent =
  | TaskStartedEvent
  | TaskRetryingEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskErrorEvent
  | TaskCancelledEvent
  | ContainerFinishedEvent
  | RunCompletedEvent
  | RunCancelledEvent;

export interface TaskStartedEvent {
  type: 'task:started';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  timestamp: string;
}

export interface TaskRetryingEvent {
  type: 'task:retrying';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  testOutput: string;
}

export interface TaskCompletedEvent {
  type: 'task:completed';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  score: number;
  testsPassed: number;
  testsTotal: number;
  duration: number;
  final: true;
}

export interface TaskFailedEvent {
  type: 'task:failed';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  score: number;
  errorMessage: string;
  final: true;
}

export interface TaskErrorEvent {
  type: 'task:error';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  errorMessage: string;
}

export interface TaskCancelledEvent {
  type: 'task:cancelled';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
}

export interface ContainerFinishedEvent {
  type: 'container:finished';
  runId: string;
  agent: string;
  model: string;
  completedCount: number;
  failedCount: number;
  errorCount: number;
}

export interface RunCompletedEvent {
  type: 'run:completed';
  runId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  errorTasks: number;
  cancelledTasks: number;
}

export interface RunCancelledEvent {
  type: 'run:cancelled';
  runId: string;
  completedTasks: number;
  cancelledTasks: number;
}

// ─── Scheduler ─────────────────────────────────────────────────

export interface RunConfig {
  runId: string;
  lanes: LaneConfig[];
  maxRetries: number;
  maxConcurrentLanes: number;
}

export interface LaneConfig {
  agent: { id: string; slug: string; name: string };
  model: { id: string; name: string };
  executorId: string;
  scenarios: { id: string; slug: string; promptPath: string; language: string }[];
}
```

- [x] **Step 5: Commit**

```bash
git add web/vitest.config.ts web/package.json web/package-lock.json \
        web/src/lib/orchestrator/types.ts
git commit -m "feat(web): add orchestrator types, vitest config, adm-zip dependency"
```

---

### Task 4: Event Bus

**Files:**
- Create: `web/src/lib/orchestrator/event-bus.ts`
- Create: `web/src/lib/orchestrator/__tests__/event-bus.test.ts`

- [x] **Step 1: Write the failing test**

Create `web/src/lib/orchestrator/__tests__/event-bus.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { RunEventBus } from '../event-bus';
import type { TaskStartedEvent, RunCompletedEvent } from '../types';

describe('RunEventBus', () => {
  it('delivers events to subscribers of a specific run', () => {
    const bus = new RunEventBus();
    const handler = vi.fn();

    bus.subscribe('run-1', handler);

    const event: TaskStartedEvent = {
      type: 'task:started',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'mock',
      model: 'gpt-4o',
      scenario: 'trivial',
      attempt: 1,
      maxAttempts: 3,
      timestamp: new Date().toISOString(),
    };

    bus.emit('run-1', event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not deliver events to subscribers of other runs', () => {
    const bus = new RunEventBus();
    const handler = vi.fn();

    bus.subscribe('run-2', handler);

    bus.emit('run-1', {
      type: 'task:started',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'mock',
      model: 'gpt-4o',
      scenario: 'trivial',
      attempt: 1,
      maxAttempts: 3,
      timestamp: new Date().toISOString(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new RunEventBus();
    const handler = vi.fn();

    const unsub = bus.subscribe('run-1', handler);
    unsub();

    bus.emit('run-1', {
      type: 'run:completed',
      runId: 'run-1',
      totalTasks: 1,
      completedTasks: 1,
      failedTasks: 0,
      errorTasks: 0,
      cancelledTasks: 0,
    } satisfies RunCompletedEvent);

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers for the same run', () => {
    const bus = new RunEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.subscribe('run-1', h1);
    bus.subscribe('run-1', h2);

    bus.emit('run-1', {
      type: 'task:started',
      runId: 'run-1',
      taskId: 't',
      agent: 'a',
      model: 'm',
      scenario: 's',
      attempt: 1,
      maxAttempts: 1,
      timestamp: new Date().toISOString(),
    });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/event-bus.test.ts
```

Expected: FAIL — module `../event-bus` not found.

- [x] **Step 3: Implement EventBus**

Create `web/src/lib/orchestrator/event-bus.ts`:

```typescript
import type { RunEvent } from './types';

type EventHandler = (event: RunEvent) => void;

export class RunEventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  subscribe(runId: string, handler: EventHandler): () => void {
    if (!this.listeners.has(runId)) {
      this.listeners.set(runId, new Set());
    }
    this.listeners.get(runId)!.add(handler);

    return () => {
      const set = this.listeners.get(runId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.listeners.delete(runId);
      }
    };
  }

  emit(runId: string, event: RunEvent): void {
    const set = this.listeners.get(runId);
    if (set) {
      for (const handler of set) {
        handler(event);
      }
    }
  }
}

// Singleton for the process — sufficient for single-instance deployment
export const runEventBus = new RunEventBus();
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/event-bus.test.ts
```

Expected: 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/event-bus.ts \
        web/src/lib/orchestrator/__tests__/event-bus.test.ts
git commit -m "feat(web): add RunEventBus for SSE event delivery"
```

---

### Task 5: DockerExecutor

**Files:**
- Create: `web/src/lib/orchestrator/docker-executor.ts`
- Create: `web/src/lib/orchestrator/__tests__/docker-executor.test.ts`

- [x] **Step 1: Write the failing test**

Create `web/src/lib/orchestrator/__tests__/docker-executor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerExecutor } from '../docker-executor';
import type { ExecutorConfig } from '../types';

// Mock dockerode
const mockContainer = {
  id: 'container-123',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  exec: vi.fn(),
  modem: { demuxStream: vi.fn() },
};

const mockDocker = {
  createContainer: vi.fn().mockResolvedValue(mockContainer),
  ping: vi.fn().mockResolvedValue('OK'),
  listContainers: vi.fn().mockResolvedValue([]),
};

vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => mockDocker),
}));

describe('DockerExecutor', () => {
  let executor: DockerExecutor;
  const baseConfig: ExecutorConfig = {
    image: 'litmus/runtime-python',
    agentHostDir: '/host/agents/mock',
    workHostDir: '/host/work',
    runId: 'run-1',
    env: { CURSOR_API_KEY: 'test-key' },
    labels: { 'litmus.custom': 'true' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new DockerExecutor('tcp://localhost:2375');
  });

  it('creates a container with correct config on start()', async () => {
    const handle = await executor.start(baseConfig);

    expect(handle.containerId).toBe('container-123');
    expect(mockDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'litmus/runtime-python',
        Cmd: ['sleep', 'infinity'],
        Labels: expect.objectContaining({
          'litmus.managed': 'true',
          'litmus.run-id': 'run-1',
          'litmus.custom': 'true',
        }),
      }),
    );
    expect(mockContainer.start).toHaveBeenCalled();
  });

  it('passes bind mounts for agent scripts and work directory', async () => {
    await executor.start(baseConfig);

    const createCall = mockDocker.createContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Binds).toEqual([
      '/host/agents/mock:/opt/agent:ro',
      '/host/work:/work',
    ]);
  });

  it('applies memory and CPU limits', async () => {
    await executor.start({ ...baseConfig, limits: { memory: 2, cpus: 1 } });

    const createCall = mockDocker.createContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(createCall.HostConfig.NanoCpus).toBe(1e9);
  });

  it('stops and removes container on stop()', async () => {
    const handle = await executor.start(baseConfig);
    await executor.stop(handle);

    expect(mockContainer.stop).toHaveBeenCalled();
    expect(mockContainer.remove).toHaveBeenCalled();
  });

  it('returns true from healthCheck() when Docker responds', async () => {
    const healthy = await executor.healthCheck();
    expect(healthy).toBe(true);
  });

  it('returns false from healthCheck() when Docker is unreachable', async () => {
    mockDocker.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const healthy = await executor.healthCheck();
    expect(healthy).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/docker-executor.test.ts
```

Expected: FAIL — module `../docker-executor` not found.

- [x] **Step 3: Implement DockerExecutor**

Create `web/src/lib/orchestrator/docker-executor.ts`:

```typescript
import Dockerode from 'dockerode';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorConfig, ExecutorHandle, ExecResult } from './types';

interface ContainerHandle extends ExecutorHandle {
  container: Dockerode.Container;
}

export class DockerExecutor implements AgentExecutor {
  type = 'docker' as const;
  private docker: Dockerode;

  constructor(dockerHost: string) {
    const url = new URL(dockerHost);
    this.docker = new Dockerode({ host: url.hostname, port: Number(url.port) });
  }

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
          `${config.agentHostDir}:/opt/agent:ro`,
          `${config.workHostDir}:/work`,
        ],
        NetworkMode: config.network ?? 'litmus-agents',
        Memory: (config.limits?.memory ?? 4) * 1024 * 1024 * 1024,
        NanoCpus: (config.limits?.cpus ?? 2) * 1e9,
      },
    });
    await container.start();
    return { containerId: container.id, container };
  }

  async exec(handle: ExecutorHandle, cmd: string[], env?: Record<string, string>): Promise<ExecResult> {
    const { container } = handle as ContainerHandle;
    const execution = await container.exec({
      Cmd: cmd,
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await execution.start({});

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const outStream = new PassThrough();
      const errStream = new PassThrough();

      container.modem.demuxStream(stream, outStream, errStream);

      outStream.on('data', (chunk: Buffer) => stdout.push(chunk));
      errStream.on('data', (chunk: Buffer) => stderr.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const info = await execution.inspect();
    return {
      exitCode: info.ExitCode ?? 1,
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    };
  }

  async stop(handle: ExecutorHandle): Promise<void> {
    const { container } = handle as ContainerHandle;
    try {
      await container.stop({ t: 5 });
    } catch {
      // Container may already be stopped
    }
    await container.remove({ force: true });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Remove all containers labeled litmus.managed=true (orphan cleanup) */
  async cleanupOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['litmus.managed=true'] },
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
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/docker-executor.test.ts
```

Expected: 6 tests PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/docker-executor.ts \
        web/src/lib/orchestrator/__tests__/docker-executor.test.ts
git commit -m "feat(web): add DockerExecutor with container lifecycle management"
```

---

### Task 6: Reconciler

**Files:**
- Create: `web/src/lib/orchestrator/reconciler.ts`
- Create: `web/src/lib/orchestrator/__tests__/reconciler.test.ts`

- [x] **Step 1: Write the failing test**

Create `web/src/lib/orchestrator/__tests__/reconciler.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Reconciler } from '../reconciler';
import * as fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Reconciler.evaluate', () => {
  let tmpDir: string;
  let reconciler: Reconciler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'litmus-test-'));
    reconciler = new Reconciler();
  });

  it('parses test-results.json and returns EvalResult for all-pass', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'test-results.json'),
      JSON.stringify({
        tests_passed: 3,
        tests_total: 3,
        framework: 'pytest',
        details: [
          { name: 'test_a', status: 'passed', duration_ms: 10, message: '' },
          { name: 'test_b', status: 'passed', duration_ms: 20, message: '' },
          { name: 'test_c', status: 'passed', duration_ms: 15, message: '' },
        ],
      }),
    );

    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(true);
    expect(result.testsPassed).toBe(3);
    expect(result.testsTotal).toBe(3);
    expect(result.totalScore).toBeCloseTo(100);
    expect(result.details).toHaveLength(3);
  });

  it('parses partial failure correctly', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'test-results.json'),
      JSON.stringify({
        tests_passed: 2,
        tests_total: 5,
        framework: 'pytest',
        details: [
          { name: 'test_a', status: 'passed', duration_ms: 10, message: '' },
          { name: 'test_b', status: 'failed', duration_ms: 20, message: 'AssertionError' },
          { name: 'test_c', status: 'failed', duration_ms: 5, message: 'KeyError' },
          { name: 'test_d', status: 'passed', duration_ms: 12, message: '' },
          { name: 'test_e', status: 'failed', duration_ms: 8, message: 'TypeError' },
        ],
      }),
    );

    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(false);
    expect(result.testsPassed).toBe(2);
    expect(result.testsTotal).toBe(5);
    expect(result.totalScore).toBeCloseTo(40);
  });

  it('returns zero score when test-results.json is missing', async () => {
    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(false);
    expect(result.testsPassed).toBe(0);
    expect(result.testsTotal).toBe(0);
    expect(result.totalScore).toBe(0);
  });

  it('returns zero score for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'test-results.json'), 'not-json');

    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(false);
    expect(result.totalScore).toBe(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/reconciler.test.ts
```

Expected: FAIL — module `../reconciler` not found.

- [x] **Step 3: Implement Reconciler**

Create `web/src/lib/orchestrator/reconciler.ts`:

```typescript
import * as fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { runResults, runTasks } from '@/db/schema';
import { uploadFile, BUCKETS } from '@/lib/s3';
import type { EvalResult, TaskMeta } from './types';

interface TestResultsJson {
  tests_passed: number;
  tests_total: number;
  framework: string;
  details: Array<{
    name: string;
    status: 'passed' | 'failed';
    duration_ms: number;
    message: string;
  }>;
}

export class Reconciler {
  /**
   * evaluate() — Read test-results.json, compute score.
   * Called after each attempt (including retries). Does NOT write to DB.
   */
  async evaluate(sessionDir: string): Promise<EvalResult> {
    const resultsPath = path.join(sessionDir, 'test-results.json');

    let raw: string;
    try {
      raw = await fs.readFile(resultsPath, 'utf-8');
    } catch {
      return this.emptyResult('test-results.json not found');
    }

    let data: TestResultsJson;
    try {
      data = JSON.parse(raw);
    } catch {
      return this.emptyResult('test-results.json is malformed');
    }

    const testsPassed = data.tests_passed ?? 0;
    const testsTotal = data.tests_total ?? 0;
    const totalScore = testsTotal > 0 ? (testsPassed / testsTotal) * 100 : 0;

    return {
      allPassed: testsPassed === testsTotal && testsTotal > 0,
      testsPassed,
      testsTotal,
      totalScore,
      testOutput: raw,
      details: (data.details ?? []).map((d) => ({
        name: d.name,
        status: d.status,
        durationMs: d.duration_ms,
        message: d.message ?? '',
      })),
    };
  }

  /**
   * finalize() — Called once per (run, agent, model, scenario) after the final attempt.
   * Inserts run_results, uploads artifacts to S3, updates run_tasks.status.
   */
  async finalize(
    sessionDir: string,
    meta: TaskMeta,
    evalResult: EvalResult,
  ): Promise<void> {
    const durationSeconds = Math.round((Date.now() - meta.startedAt.getTime()) / 1000);
    const status = evalResult.allPassed ? 'completed' : 'failed';
    const s3Key = `artifacts/${meta.runId}/${meta.agentSlug}/${meta.modelSlug}/${meta.scenarioSlug}/`;

    // Upload workspace contents to S3
    await this.uploadArtifacts(sessionDir, s3Key);

    // Insert into run_results (includes attempt for SSE replay)
    await db.insert(runResults).values({
      runId: meta.runId,
      agentId: meta.agentId,
      modelId: meta.modelId,
      scenarioId: meta.scenarioId,
      status,
      testsPassed: evalResult.testsPassed,
      testsTotal: evalResult.testsTotal,
      totalScore: evalResult.totalScore,
      durationSeconds,
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
      artifactsS3Key: s3Key,
    });

    // Update run_tasks.status
    await db
      .update(runTasks)
      .set({
        status,
        finishedAt: new Date(),
        exitCode: evalResult.allPassed ? 0 : 1,
      })
      .where(eq(runTasks.id, meta.taskId));
  }

  private async uploadArtifacts(sessionDir: string, s3Prefix: string): Promise<void> {
    const files = await this.walkDir(sessionDir);
    for (const filePath of files) {
      const relativePath = path.relative(sessionDir, filePath);
      const key = s3Prefix + relativePath.replace(/\\/g, '/');
      const content = await fs.readFile(filePath);
      await uploadFile(BUCKETS.artifacts, key, content);
    }
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await this.walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  private emptyResult(testOutput: string): EvalResult {
    return {
      allPassed: false,
      testsPassed: 0,
      testsTotal: 0,
      totalScore: 0,
      testOutput,
      details: [],
    };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/reconciler.test.ts
```

Expected: 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/reconciler.ts \
        web/src/lib/orchestrator/__tests__/reconciler.test.ts
git commit -m "feat(web): add Reconciler with evaluate() and finalize()"
```

---

### Task 7: Scheduler

**Files:**
- Create: `web/src/lib/orchestrator/scheduler.ts`
- Create: `web/src/lib/orchestrator/__tests__/scheduler.test.ts`

- [x] **Step 1: Write the failing test**

Create `web/src/lib/orchestrator/__tests__/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler } from '../scheduler';
import { RunEventBus } from '../event-bus';
import { Reconciler } from '../reconciler';
import type { AgentExecutor, ExecutorHandle, RunConfig, RunEvent } from '../types';

function createMockExecutor(): AgentExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    type: 'docker',
    calls,
    async start() {
      calls.push('start');
      return { containerId: 'mock-container' } as ExecutorHandle;
    },
    async exec(_handle, cmd) {
      const cmdStr = cmd.join(' ');
      calls.push(`exec: ${cmdStr}`);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    async stop() {
      calls.push('stop');
    },
    async healthCheck() {
      return true;
    },
  };
}

function createMockReconciler(): Reconciler {
  const reconciler = new Reconciler();
  vi.spyOn(reconciler, 'evaluate').mockResolvedValue({
    allPassed: true,
    testsPassed: 3,
    testsTotal: 3,
    totalScore: 100,
    testOutput: '{}',
    details: [],
  });
  vi.spyOn(reconciler, 'finalize').mockResolvedValue(undefined);
  return reconciler;
}

describe('Scheduler', () => {
  let bus: RunEventBus;
  let executor: ReturnType<typeof createMockExecutor>;
  let reconciler: ReturnType<typeof createMockReconciler>;
  let events: RunEvent[];

  const config: RunConfig = {
    runId: 'run-1',
    maxRetries: 3,
    maxConcurrentLanes: 2,
    lanes: [
      {
        agent: { id: 'a1', slug: 'mock', name: 'Mock' },
        model: { id: 'm1', name: 'gpt-4o' },
        executorId: 'e1',
        scenarios: [
          { id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' },
        ],
      },
    ],
  };

  beforeEach(() => {
    bus = new RunEventBus();
    executor = createMockExecutor();
    reconciler = createMockReconciler();
    events = [];
    bus.subscribe('run-1', (e) => events.push(e));
  });

  it('executes a single-lane single-scenario run to completion', async () => {
    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const types = events.map((e) => e.type);
    expect(types).toContain('task:started');
    expect(types).toContain('task:completed');
    expect(types).toContain('container:finished');
    expect(types).toContain('run:completed');
  });

  it('calls executor lifecycle: start → exec (init, run, test) → stop', async () => {
    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    expect(executor.calls[0]).toBe('start');
    expect(executor.calls.some((c: string) => c.includes('init.sh'))).toBe(true);
    expect(executor.calls.some((c: string) => c.includes('run.sh'))).toBe(true);
    expect(executor.calls.some((c: string) => c.includes('python.sh'))).toBe(true);
    expect(executor.calls.at(-1)).toBe('stop');
  });

  it('retries on test failure then succeeds', async () => {
    let attempt = 0;
    vi.spyOn(reconciler, 'evaluate').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return {
          allPassed: false, testsPassed: 1, testsTotal: 3,
          totalScore: 33, testOutput: 'fail', details: [],
        };
      }
      return {
        allPassed: true, testsPassed: 3, testsTotal: 3,
        totalScore: 100, testOutput: '{}', details: [],
      };
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const types = events.map((e) => e.type);
    expect(types).toContain('task:retrying');
    expect(types).toContain('task:completed');

    const completed = events.find((e) => e.type === 'task:completed');
    expect(completed).toHaveProperty('attempt', 2);
  });

  it('emits task:failed after all retries exhausted', async () => {
    vi.spyOn(reconciler, 'evaluate').mockResolvedValue({
      allPassed: false, testsPassed: 0, testsTotal: 3,
      totalScore: 0, testOutput: 'always fails', details: [],
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const failed = events.find((e) => e.type === 'task:failed');
    expect(failed).toBeDefined();
    // maxRetries=3 → maxAttempts=4, final attempt is 4
    expect(failed).toHaveProperty('attempt', 4);
    expect(failed).toHaveProperty('maxAttempts', 4);
    expect(failed).toHaveProperty('final', true);
  });

  it('emits run:completed with correct task counts', async () => {
    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed).toEqual(expect.objectContaining({
      totalTasks: 1,
      completedTasks: 1,
      failedTasks: 0,
      errorTasks: 0,
      cancelledTasks: 0,
    }));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts
```

Expected: FAIL — module `../scheduler` not found.

- [x] **Step 3: Implement Scheduler**

Create `web/src/lib/orchestrator/scheduler.ts`:

```typescript
import * as fs from 'fs/promises';
import path from 'path';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks } from '@/db/schema';
import { downloadFile, listFiles, BUCKETS } from '@/lib/s3';
import type {
  AgentExecutor,
  ExecutorHandle,
  RunConfig,
  LaneConfig,
  EvalResult,
  TaskMeta,
} from './types';
import type { Reconciler } from './reconciler';
import type { RunEventBus } from './event-bus';

export class Scheduler {
  private cancelled = false;
  private activeHandles = new Map<string, ExecutorHandle>();

  constructor(
    private executor: AgentExecutor,
    private reconciler: Reconciler,
    private bus: RunEventBus,
    private workRoot: string,
  ) {}

  async execute(config: RunConfig): Promise<void> {
    this.cancelled = false;

    // Update run status to running
    await db.update(runs).set({ status: 'running' }).where(eq(runs.id, config.runId)).catch(() => {});

    // Stage scenarios from S3 to work directory
    const allSlugs = new Set<string>();
    for (const lane of config.lanes) {
      for (const scenario of lane.scenarios) {
        allSlugs.add(scenario.slug);
      }
    }
    for (const slug of allSlugs) {
      await this.stageScenario(config.runId, slug);
    }

    const results = { completed: 0, failed: 0, error: 0, cancelled: 0 };

    // Process lanes with concurrency limit
    const laneQueue = [...config.lanes];
    const activeLanes: Promise<void>[] = [];

    const processNextLane = async (): Promise<void> => {
      while (laneQueue.length > 0 && !this.cancelled) {
        const lane = laneQueue.shift()!;
        const laneResults = await this.executeLane(config, lane);
        results.completed += laneResults.completed;
        results.failed += laneResults.failed;
        results.error += laneResults.error;
        results.cancelled += laneResults.cancelled;
      }
    };

    for (let i = 0; i < config.maxConcurrentLanes; i++) {
      activeLanes.push(processNextLane());
    }

    await Promise.all(activeLanes);

    const totalTasks = config.lanes.reduce((sum, l) => sum + l.scenarios.length, 0);

    if (this.cancelled) {
      this.bus.emit(config.runId, {
        type: 'run:cancelled',
        runId: config.runId,
        completedTasks: results.completed,
        cancelledTasks: results.cancelled,
      });
    } else {
      this.bus.emit(config.runId, {
        type: 'run:completed',
        runId: config.runId,
        totalTasks,
        completedTasks: results.completed,
        failedTasks: results.failed,
        errorTasks: results.error,
        cancelledTasks: results.cancelled,
      });
    }

    // Update run status
    const finalStatus = this.cancelled ? 'cancelled' : 'completed';
    await db
      .update(runs)
      .set({ status: finalStatus, finishedAt: new Date() })
      .where(eq(runs.id, config.runId))
      .catch(() => {});

    // Cleanup workspace
    const runDir = path.join(this.workRoot, 'runs', config.runId);
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled = true;
    for (const [, handle] of this.activeHandles) {
      try { await this.executor.stop(handle); } catch { /* best effort */ }
    }
    this.activeHandles.clear();

    await db
      .update(runTasks)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runTasks.runId, runId), inArray(runTasks.status, ['pending', 'running'])))
      .catch(() => {});
  }

  private async executeLane(
    config: RunConfig,
    lane: LaneConfig,
  ): Promise<{ completed: number; failed: number; error: number; cancelled: number }> {
    const results = { completed: 0, failed: 0, error: 0, cancelled: 0 };
    const laneKey = `${lane.agent.slug}-${lane.model.name}`;

    let handle: ExecutorHandle | null = null;

    try {
      const agentHostDir = this.resolveAgentHostDir(lane.agent.slug);
      const workHostDir = this.resolveWorkHostDir();

      handle = await this.executor.start({
        image: 'litmus/runtime-python',
        agentHostDir,
        workHostDir,
        runId: config.runId,
        env: {},
        labels: {
          'litmus.managed': 'true',
          'litmus.run-id': config.runId,
          'litmus.agent': lane.agent.slug,
          'litmus.model': lane.model.name,
        },
      });
      this.activeHandles.set(laneKey, handle);

      for (const scenario of lane.scenarios) {
        if (this.cancelled) {
          results.cancelled += lane.scenarios.length - (results.completed + results.failed + results.error);
          break;
        }
        const taskResult = await this.executeScenario(config, lane, scenario, handle);
        results[taskResult]++;
      }
    } catch {
      results.error += lane.scenarios.length - (results.completed + results.failed + results.error);
    } finally {
      if (handle) {
        try { await this.executor.stop(handle); } catch { /* best effort */ }
        this.activeHandles.delete(laneKey);
      }
    }

    this.bus.emit(config.runId, {
      type: 'container:finished',
      runId: config.runId,
      agent: lane.agent.name,
      model: lane.model.name,
      completedCount: results.completed,
      failedCount: results.failed,
      errorCount: results.error,
    });

    return results;
  }

  private async executeScenario(
    config: RunConfig,
    lane: LaneConfig,
    scenario: { id: string; slug: string; promptPath: string; language: string },
    handle: ExecutorHandle,
  ): Promise<'completed' | 'failed' | 'error'> {
    const sessionDir = `/work/runs/${config.runId}/${lane.agent.slug}/${lane.model.name}/${scenario.slug}`;
    const localSessionDir = path.join(this.workRoot, 'runs', config.runId, lane.agent.slug, lane.model.name, scenario.slug);
    const scenarioStagedPath = `/work/runs/${config.runId}/_scenarios/${scenario.slug}`;
    const taskId = `${config.runId}-${lane.agent.slug}-${lane.model.name}-${scenario.slug}`;
    const startedAt = new Date();
    const maxAttempts = config.maxRetries + 1;

    this.bus.emit(config.runId, {
      type: 'task:started',
      runId: config.runId,
      taskId,
      agent: lane.agent.name,
      model: lane.model.name,
      scenario: scenario.slug,
      attempt: 1,
      maxAttempts,
      timestamp: startedAt.toISOString(),
    });

    try {
      // init.sh — prepare workspace
      const initResult = await this.executor.exec(handle, [
        '/opt/agent/../init.sh',
        '--scenario', scenarioStagedPath,
        '--workspace', sessionDir,
      ]);

      if (initResult.exitCode !== 0) {
        this.bus.emit(config.runId, {
          type: 'task:error', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
          errorMessage: `init.sh failed: ${initResult.stderr}`,
        });
        return 'error';
      }

      // Read prompt from staged scenario
      let prompt: string;
      try {
        const localPromptPath = path.join(this.workRoot, 'runs', config.runId, '_scenarios', scenario.slug, 'prompt.txt');
        prompt = await fs.readFile(localPromptPath, 'utf-8');
      } catch {
        prompt = 'Implement the required functionality to make all tests pass.';
      }

      // Retry loop: maxAttempts computed above (1 + maxRetries)
      let evalResult: EvalResult | null = null;
      const testScript = this.resolveTestScript(scenario.language);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const currentPrompt = attempt === 1
          ? prompt
          : this.buildRetryPrompt(prompt, evalResult?.testOutput ?? '');

        await this.executor.exec(handle, [
          '/opt/agent/run.sh',
          '--model', lane.model.name,
          '--prompt', currentPrompt,
          '--workspace', sessionDir,
          '--scenario-dir', scenarioStagedPath,
        ]);

        await this.executor.exec(handle, [
          testScript,
          '--workspace', sessionDir,
          '--output', `${sessionDir}/test-results.json`,
        ]);

        evalResult = await this.reconciler.evaluate(localSessionDir);

        if (evalResult.allPassed) {
          const duration = Math.round((Date.now() - startedAt.getTime()) / 1000);
          this.bus.emit(config.runId, {
            type: 'task:completed', runId: config.runId, taskId,
            agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
            attempt, maxAttempts,
            score: evalResult.totalScore, testsPassed: evalResult.testsPassed,
            testsTotal: evalResult.testsTotal, duration, final: true,
          });

          await this.reconciler.finalize(localSessionDir, this.buildTaskMeta(config, lane, scenario, taskId, attempt, maxAttempts, startedAt), evalResult);
          return 'completed';
        }

        if (attempt < maxAttempts) {
          this.bus.emit(config.runId, {
            type: 'task:retrying', runId: config.runId, taskId,
            agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
            attempt, maxAttempts, testOutput: evalResult.testOutput,
          });
        }
      }

      // All retries exhausted
      this.bus.emit(config.runId, {
        type: 'task:failed', runId: config.runId, taskId,
        agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
        attempt: maxAttempts, maxAttempts,
        score: evalResult?.totalScore ?? 0,
        errorMessage: `Tests failed after ${maxAttempts} attempts`, final: true,
      });

      await this.reconciler.finalize(localSessionDir, this.buildTaskMeta(config, lane, scenario, taskId, maxAttempts, maxAttempts, startedAt), evalResult!);
      return 'failed';

    } catch (err) {
      this.bus.emit(config.runId, {
        type: 'task:error', runId: config.runId, taskId,
        agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return 'error';
    }
  }

  private buildTaskMeta(
    config: RunConfig, lane: LaneConfig,
    scenario: { id: string; slug: string }, taskId: string,
    attempt: number, maxAttempts: number, startedAt: Date,
  ): TaskMeta {
    return {
      runId: config.runId, taskId,
      agentId: lane.agent.id, modelId: lane.model.id, scenarioId: scenario.id,
      agentSlug: lane.agent.slug, modelSlug: lane.model.name, scenarioSlug: scenario.slug,
      attempt, maxAttempts, startedAt,
    };
  }

  private buildRetryPrompt(originalPrompt: string, testOutput: string): string {
    return `Original task: ${originalPrompt}\n\nPrevious attempt failed. Test output:\n${testOutput}\n\nFix the code to make all tests pass.`;
  }

  private resolveTestScript(language: string): string {
    const scripts: Record<string, string> = { python: '/opt/agent/../tests/python.sh' };
    return scripts[language] ?? scripts.python;
  }

  private resolveAgentHostDir(agentSlug: string): string {
    const envDir = process.env.AGENTS_HOST_DIR;
    if (envDir) return path.resolve(envDir, 'agents', agentSlug);
    return path.resolve('./agents', agentSlug);
  }

  private resolveWorkHostDir(): string {
    return process.env.WORK_HOST_DIR ?? path.resolve('./work');
  }

  private async stageScenario(runId: string, scenarioSlug: string): Promise<void> {
    const stageDir = path.join(this.workRoot, 'runs', runId, '_scenarios', scenarioSlug);
    await fs.mkdir(stageDir, { recursive: true });

    const files = await listFiles(BUCKETS.scenarios, `${scenarioSlug}/`);
    for (const key of files) {
      const relativePath = key.slice(scenarioSlug.length + 1);
      if (!relativePath) continue;
      const targetPath = path.join(stageDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = await downloadFile(BUCKETS.scenarios, key);
      await fs.writeFile(targetPath, content);
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts
```

Expected: 5 tests PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/scheduler.ts \
        web/src/lib/orchestrator/__tests__/scheduler.test.ts
git commit -m "feat(web): add Scheduler with lane-based execution and retry loop"
```

---

### Task 8: API Routes — Agents

**Files:**
- Create: `web/src/app/api/agents/route.ts`
- Create: `web/src/app/api/agents/[id]/route.ts`
- Create: `web/src/app/api/agents/[id]/health/route.ts`
- Create: `web/src/app/api/agents/[id]/models/route.ts`

- [x] **Step 1: Create `GET /api/agents` + `POST /api/agents`**

Create `web/src/app/api/agents/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { agents, agentExecutors } from '@/db/schema';
import { z } from 'zod';

export async function GET() {
  const allAgents = await db.select().from(agents).orderBy(agents.name);
  const allExecutors = await db.select().from(agentExecutors);

  const result = allAgents.map((agent) => ({
    ...agent,
    executors: allExecutors.filter((e) => e.agentId === agent.id),
  }));

  return NextResponse.json(result);
}

const createAgentSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  executor: z.object({
    type: z.enum(['docker', 'host', 'kubernetes']),
    agentSlug: z.string().min(1),
    binaryPath: z.string().optional(),
    healthCheck: z.string().optional(),
    config: z.record(z.unknown()).optional(),
  }),
});

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createAgentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { name, version, executor } = parsed.data;

  const [agent] = await db.insert(agents).values({ name, version }).returning();

  const [exec] = await db
    .insert(agentExecutors)
    .values({
      agentId: agent.id,
      type: executor.type,
      agentSlug: executor.agentSlug,
      binaryPath: executor.binaryPath,
      healthCheck: executor.healthCheck,
      config: executor.config ?? {},
    })
    .returning();

  return NextResponse.json({ ...agent, executors: [exec] }, { status: 201 });
}
```

- [x] **Step 2: Create `PUT /api/agents/[id]`**

Create `web/src/app/api/agents/[id]/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors } from '@/db/schema';
import { z } from 'zod';

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  version: z.string().optional(),
  executor: z.object({
    type: z.enum(['docker', 'host', 'kubernetes']).optional(),
    agentSlug: z.string().min(1).optional(),
    binaryPath: z.string().optional(),
    healthCheck: z.string().optional(),
    config: z.record(z.unknown()).optional(),
  }).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const parsed = updateAgentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { name, version, executor } = parsed.data;

  if (name || version) {
    await db
      .update(agents)
      .set({ ...(name && { name }), ...(version && { version }) })
      .where(eq(agents.id, id));
  }

  if (executor) {
    const existing = await db
      .select()
      .from(agentExecutors)
      .where(eq(agentExecutors.agentId, id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(agentExecutors)
        .set(executor)
        .where(eq(agentExecutors.id, existing[0].id));
    }
  }

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));
  const executors = await db.select().from(agentExecutors).where(eq(agentExecutors.agentId, id));

  return NextResponse.json({ ...updated, executors });
}
```

- [x] **Step 3: Create `POST /api/agents/[id]/health`**

Create `web/src/app/api/agents/[id]/health/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { env } from '@/lib/env';

export async function POST() {
  const executor = new DockerExecutor(env.DOCKER_HOST);
  const healthy = await executor.healthCheck();
  return NextResponse.json({ healthy });
}
```

- [x] **Step 4: Create `POST /api/agents/[id]/models`**

Create `web/src/app/api/agents/[id]/models/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, agentExecutors, models } from '@/db/schema';
import { DockerExecutor } from '@/lib/orchestrator/docker-executor';
import { env } from '@/lib/env';
import path from 'path';

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

  const agentHostDir = env.AGENTS_HOST_DIR
    ? path.resolve(env.AGENTS_HOST_DIR, 'agents', executor.agentSlug)
    : path.resolve('./agents', executor.agentSlug);
  const workHostDir = env.WORK_HOST_DIR ?? path.resolve('./work');

  const handle = await docker.start({
    image: 'litmus/runtime-python',
    agentHostDir,
    workHostDir,
    runId: 'model-discovery',
    env: (executor.config as Record<string, string>) ?? {},
  });

  try {
    const result = await docker.exec(handle, ['/opt/agent/models.sh']);

    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: `models.sh failed: ${result.stderr}` },
        { status: 500 },
      );
    }

    const discovered: DiscoveredModel[] = JSON.parse(result.stdout);
    const availableModels = [];

    for (const m of discovered) {
      const [row] = await db
        .insert(models)
        .values({ name: m.name, provider: m.provider })
        .onConflictDoUpdate({ target: models.name, set: { provider: m.provider } })
        .returning();

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

- [x] **Step 5: Commit**

```bash
git add web/src/app/api/agents/
git commit -m "feat(web): add agents API routes — CRUD, health check, model discovery"
```

---

### Task 9: API Routes — Scenarios Import + Pack Script

**Files:**
- Create: `web/src/app/api/scenarios/route.ts`
- Create: `web/src/app/api/scenarios/import/route.ts`
- Create: `web/scripts/pack.ts`

- [x] **Step 1: Create `GET /api/scenarios`**

Create `web/src/app/api/scenarios/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { scenarios } from '@/db/schema';

export async function GET() {
  const rows = await db.select().from(scenarios).orderBy(scenarios.slug);
  return NextResponse.json(rows);
}
```

- [x] **Step 2: Create `POST /api/scenarios/import`**

Create `web/src/app/api/scenarios/import/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { uploadFile, BUCKETS } from '@/lib/s3';

interface PackManifest {
  version: string;
  scenarios: Array<{
    slug: string;
    name: string;
    description?: string;
    language: string;
    tags?: string[];
    maxScore?: number;
  }>;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const manifestEntry = entries.find((e) => e.entryName === 'manifest.json');
  if (!manifestEntry) {
    return NextResponse.json({ error: 'Missing manifest.json in pack' }, { status: 400 });
  }

  const manifest: PackManifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  const imported: string[] = [];

  for (const scenarioDef of manifest.scenarios) {
    await db
      .insert(scenarios)
      .values({
        slug: scenarioDef.slug,
        name: scenarioDef.name,
        description: scenarioDef.description,
        language: scenarioDef.language,
        tags: scenarioDef.tags,
        maxScore: scenarioDef.maxScore,
      })
      .onConflictDoUpdate({
        target: scenarios.slug,
        set: {
          name: scenarioDef.name,
          description: scenarioDef.description,
          language: scenarioDef.language,
          tags: scenarioDef.tags,
          maxScore: scenarioDef.maxScore,
        },
      });

    const prefix = `${scenarioDef.slug}/`;
    for (const entry of entries) {
      if (entry.entryName.startsWith(prefix) && !entry.isDirectory) {
        await uploadFile(BUCKETS.scenarios, entry.entryName, entry.getData());
      }
    }

    imported.push(scenarioDef.slug);
  }

  return NextResponse.json({ imported, count: imported.length }, { status: 201 });
}
```

- [x] **Step 3: Create pack script**

Create `web/scripts/pack.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const args = process.argv.slice(2);
let scenariosDir = '';
let outputPath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' && args[i + 1]) {
    outputPath = args[i + 1];
    i++;
  } else if (!scenariosDir) {
    scenariosDir = args[i];
  }
}

if (!scenariosDir || !outputPath) {
  console.error('Usage: npm run pack -- <scenarios-dir> -o <output.litmus-pack>');
  process.exit(1);
}

const scenariosPath = path.resolve(scenariosDir);
const dirs = fs.readdirSync(scenariosPath, { withFileTypes: true })
  .filter((d) => d.isDirectory());

interface ManifestScenario {
  slug: string;
  name: string;
  description: string;
  language: string;
  tags: string[];
  maxScore: number;
}

const manifest: { version: string; scenarios: ManifestScenario[] } = {
  version: '1',
  scenarios: [],
};

const zip = new AdmZip();

for (const dir of dirs) {
  const slug = dir.name;
  const scenarioPath = path.join(scenariosPath, slug);

  const hasTestPy = fs.existsSync(path.join(scenarioPath, 'test.py'));
  const language = hasTestPy ? 'python' : 'python';

  const promptPath = path.join(scenarioPath, 'prompt.txt');
  const promptText = fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, 'utf-8')
    : '';
  const name = slug.replace(/^\d+-/, '').replace(/-/g, ' ');

  manifest.scenarios.push({
    slug,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    description: promptText.split('\n')[0].slice(0, 200),
    language,
    tags: [],
    maxScore: 100,
  });

  addDirToZip(zip, scenarioPath, slug);
}

zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
zip.writeZip(path.resolve(outputPath));
console.log(`Packed ${manifest.scenarios.length} scenarios -> ${outputPath}`);

function addDirToZip(z: AdmZip, dirPath: string, zipPrefix: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirToZip(z, fullPath, zipPath);
    } else {
      z.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
}
```

- [x] **Step 4: Add pack script to package.json**

In `web/package.json`, add to scripts:

```json
"pack": "npx tsx scripts/pack.ts"
```

- [x] **Step 5: Test pack script manually**

```bash
cd web && npm run pack -- ./agents/scenarios/__test__ -o test-scenarios.litmus-pack
```

Expected: creates `test-scenarios.litmus-pack` file. Clean up:

```bash
rm test-scenarios.litmus-pack
```

- [x] **Step 6: Commit**

```bash
git add web/src/app/api/scenarios/ web/scripts/pack.ts web/package.json
git commit -m "feat(web): add scenarios API routes and .litmus-pack generator"
```

---

### Task 10: API Routes — Runs

**Files:**
- Create: `web/src/app/api/runs/route.ts`
- Create: `web/src/app/api/runs/[runId]/route.ts`
- Create: `web/src/app/api/runs/[runId]/stream/route.ts`

- [x] **Step 1: Create `POST /api/runs` + `GET /api/runs`**

Create `web/src/app/api/runs/route.ts`:

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

const createRunSchema = z.object({
  agents: z.array(z.object({
    id: z.string().uuid(),
    models: z.array(z.string().uuid()),
  })).min(1),
  scenarios: z.array(z.string().uuid()).min(1),
  maxRetries: z.number().int().min(1).max(10).default(3),
  maxConcurrentLanes: z.number().int().min(1).max(10).default(3),
});

// In-memory scheduler registry (single instance)
export const activeSchedulers = new Map<string, Scheduler>();

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createRunSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { agents: agentSelections, scenarios: scenarioIds, maxRetries, maxConcurrentLanes } = parsed.data;

  // ── Phase 1: Validate all entities BEFORE any DB writes ──────────
  // All validation errors return 400 before touching the database.
  const lanes: LaneConfig[] = [];
  const taskInserts: Array<{ agentExecutorId: string; modelId: string; scenarioId: string }> = [];

  for (const agentSel of agentSelections) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentSel.id));
    const [executor] = await db
      .select()
      .from(agentExecutors)
      .where(eq(agentExecutors.agentId, agentSel.id))
      .limit(1);

    if (!agent || !executor || executor.type !== 'docker') {
      return NextResponse.json(
        { error: `Agent ${agentSel.id} has no docker executor` },
        { status: 400 },
      );
    }

    for (const modelId of agentSel.models) {
      const [model] = await db.select().from(models).where(eq(models.id, modelId));
      if (!model) {
        return NextResponse.json({ error: `Model ${modelId} not found` }, { status: 400 });
      }

      const laneScenarios = [];
      for (const scenarioId of scenarioIds) {
        const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId));
        if (!scenario) {
          return NextResponse.json({ error: `Scenario ${scenarioId} not found` }, { status: 400 });
        }

        taskInserts.push({ agentExecutorId: executor.id, modelId: model.id, scenarioId: scenario.id });

        laneScenarios.push({
          id: scenario.id,
          slug: scenario.slug,
          promptPath: `${scenario.slug}/prompt.txt`,
          language: scenario.language ?? 'python',
        });
      }

      lanes.push({
        agent: { id: agent.id, slug: executor.agentSlug, name: agent.name },
        model: { id: model.id, name: model.name },
        executorId: executor.id,
        scenarios: laneScenarios,
      });
    }
  }

  // ── Phase 2: All validated — atomic transaction for run + tasks ──
  // If anything fails here it rolls back; no orphan rows possible.
  const [run] = await db.transaction(async (tx) => {
    const [newRun] = await tx.insert(runs).values({
      status: 'pending',
      configSnapshot: parsed.data,
    }).returning();

    if (taskInserts.length > 0) {
      await tx.insert(runTasks).values(
        taskInserts.map((t) => ({ ...t, runId: newRun.id, status: 'pending' as const })),
      );
    }

    return [newRun];
  });

  // Fire-and-forget scheduler execution (outside transaction)
  const dockerExecutor = new DockerExecutor(env.DOCKER_HOST);
  const reconciler = new Reconciler();
  const scheduler = new Scheduler(dockerExecutor, reconciler, runEventBus, env.WORK_ROOT);
  activeSchedulers.set(run.id, scheduler);

  scheduler.execute({
    runId: run.id,
    lanes,
    maxRetries,
    maxConcurrentLanes,
  }).finally(() => {
    activeSchedulers.delete(run.id);
  });

  return NextResponse.json({ runId: run.id }, { status: 201 });
}

export async function GET() {
  const rows = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50);
  return NextResponse.json(rows);
}
```

- [x] **Step 2: Create `GET /api/runs/[runId]` + `DELETE /api/runs/[runId]`**

Create `web/src/app/api/runs/[runId]/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, runResults } from '@/db/schema';
import { activeSchedulers } from '../route';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const tasks = await db.select().from(runTasks).where(eq(runTasks.runId, runId));
  const results = await db.select().from(runResults).where(eq(runResults.runId, runId));

  return NextResponse.json({
    ...run,
    tasks,
    results,
    summary: {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      running: tasks.filter((t) => t.status === 'running').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      error: tasks.filter((t) => t.status === 'error').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
    },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const scheduler = activeSchedulers.get(runId);
  if (scheduler) {
    await scheduler.cancel(runId);
  }

  await db.update(runs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(runs.id, runId));

  return NextResponse.json({ status: 'cancelled' });
}
```

- [x] **Step 3: Create `GET /api/runs/[runId]/stream` — SSE endpoint**

Create `web/src/app/api/runs/[runId]/stream/route.ts`:

```typescript
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, runResults, agents, agentExecutors, models, scenarios } from '@/db/schema';
import { runEventBus } from '@/lib/orchestrator/event-bus';
import type { RunEvent } from '@/lib/orchestrator/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: RunEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Replay terminal states for reconnection
      const terminalTasks = await db
        .select()
        .from(runTasks)
        .where(
          and(
            eq(runTasks.runId, runId),
            inArray(runTasks.status, ['completed', 'failed', 'error', 'cancelled']),
          ),
        );

      for (const task of terminalTasks) {
        const [executorRow] = await db.select().from(agentExecutors).where(eq(agentExecutors.id, task.agentExecutorId));
        const [agentRow] = executorRow
          ? await db.select().from(agents).where(eq(agents.id, executorRow.agentId))
          : [null];
        const [modelRow] = await db.select().from(models).where(eq(models.id, task.modelId));
        const [scenarioRow] = await db.select().from(scenarios).where(eq(scenarios.id, task.scenarioId));

        // Look up result with full key including agentId to avoid cross-agent collisions
        const [result] = agentRow
          ? await db
              .select()
              .from(runResults)
              .where(
                and(
                  eq(runResults.runId, runId),
                  eq(runResults.agentId, agentRow.id),
                  eq(runResults.scenarioId, task.scenarioId),
                  eq(runResults.modelId, task.modelId),
                ),
              )
          : [];

        if (task.status === 'completed' && result) {
          send({
            type: 'task:completed', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
            attempt: result.attempt, maxAttempts: result.maxAttempts,
            score: result.totalScore, testsPassed: result.testsPassed,
            testsTotal: result.testsTotal, duration: result.durationSeconds, final: true,
          });
        } else if (task.status === 'failed' && result) {
          send({
            type: 'task:failed', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
            attempt: result.attempt, maxAttempts: result.maxAttempts,
            score: result.totalScore, errorMessage: result.errorMessage ?? 'Tests failed', final: true,
          });
        } else if (task.status === 'error') {
          send({
            type: 'task:error', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
            errorMessage: task.errorMessage ?? 'Unknown error',
          });
        } else if (task.status === 'cancelled') {
          send({
            type: 'task:cancelled', runId, taskId: task.id,
            agent: agentRow?.name ?? '', model: modelRow?.name ?? '', scenario: scenarioRow?.slug ?? '',
          });
        }
      }

      // Subscribe to live events
      const unsub = runEventBus.subscribe(runId, (event) => {
        try {
          send(event);
          if (event.type === 'run:completed' || event.type === 'run:cancelled') {
            unsub();
            controller.close();
          }
        } catch {
          unsub();
        }
      });

      // Close immediately if run already finished
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      if (run && ['completed', 'failed', 'error', 'cancelled'].includes(run.status)) {
        unsub();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

- [x] **Step 4: Commit**

```bash
git add web/src/app/api/runs/
git commit -m "feat(web): add runs API routes — create, list, get, cancel, SSE stream"
```

---

### Task 11: Startup Cleanup + Instrumentation

**Files:**
- Create: `web/src/lib/orchestrator/startup.ts`
- Create: `web/src/instrumentation.ts`

- [x] **Step 1: Implement startup cleanup**

Create `web/src/lib/orchestrator/startup.ts`:

```typescript
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks } from '@/db/schema';
import { DockerExecutor } from './docker-executor';
import { env } from '@/lib/env';

export async function startupCleanup(): Promise<void> {
  const executor = new DockerExecutor(env.DOCKER_HOST);

  const cleaned = await executor.cleanupOrphans();
  if (cleaned > 0) {
    console.log(`[startup] Cleaned ${cleaned} orphaned agent containers`);
  }

  const staleTasks = await db
    .update(runTasks)
    .set({ status: 'error', errorMessage: 'Process terminated unexpectedly', finishedAt: new Date() })
    .where(inArray(runTasks.status, ['running']))
    .returning();

  if (staleTasks.length > 0) {
    console.log(`[startup] Marked ${staleTasks.length} stale running tasks as error`);
  }

  await db
    .update(runs)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(eq(runs.status, 'running'));
}
```

- [x] **Step 2: Wire into Next.js instrumentation**

Create `web/src/instrumentation.ts`:

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startupCleanup } = await import('@/lib/orchestrator/startup');
    await startupCleanup().catch((err) => {
      console.error('[startup] Cleanup failed:', err);
    });
  }
}
```

- [x] **Step 3: Commit**

```bash
git add web/src/lib/orchestrator/startup.ts web/src/instrumentation.ts
git commit -m "feat(web): add startup cleanup for orphaned containers and stale tasks"
```

---

## Wave 2 — UI

### Task 12: Matrix Builder Page

**Files:**
- Modify: `web/src/app/run/page.tsx` (replace stub)
- Create: `web/src/components/matrix-builder/agent-card.tsx`
- Create: `web/src/components/matrix-builder/scenario-list.tsx`
- Create: `web/src/components/matrix-builder/summary-bar.tsx`

- [x] **Step 1: Create `agent-card.tsx`**

Create `web/src/components/matrix-builder/agent-card.tsx`:

```tsx
'use client';

interface ModelChip {
  dbId: string;
  name: string;
  provider?: string;
}

interface AgentCardProps {
  agent: { id: string; name: string; availableModels: ModelChip[] };
  selectedModels: Set<string>;
  onToggleModel: (agentId: string, modelDbId: string) => void;
  onRefreshModels: (agentId: string) => void;
  isRefreshing: boolean;
}

export function AgentCard({ agent, selectedModels, onToggleModel, onRefreshModels, isRefreshing }: AgentCardProps) {
  const hasSelected = agent.availableModels.some((m) => selectedModels.has(m.dbId));

  return (
    <div className={`rounded-lg border p-4 transition-colors ${
      hasSelected
        ? 'border-[var(--accent)] bg-[var(--bg-raised)]'
        : 'border-[var(--border)] bg-[var(--bg-base)]'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{agent.name}</span>
        <button
          onClick={() => onRefreshModels(agent.id)}
          disabled={isRefreshing}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh models'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {agent.availableModels.length === 0 && (
          <span className="text-xs text-[var(--text-muted)]">No models — click Refresh</span>
        )}
        {agent.availableModels.map((model) => {
          const isSelected = selectedModels.has(model.dbId);
          return (
            <button
              key={model.dbId}
              onClick={() => onToggleModel(agent.id, model.dbId)}
              className={`font-mono text-xs px-2.5 py-1 rounded-full border transition-colors ${
                isSelected
                  ? 'bg-[var(--accent-dim)] text-[var(--accent)] border-[var(--accent)]'
                  : 'text-[var(--text-muted)] border-[var(--border)] hover:border-[var(--text-secondary)]'
              }`}
            >
              {model.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [x] **Step 2: Create `scenario-list.tsx`**

Create `web/src/components/matrix-builder/scenario-list.tsx`:

```tsx
'use client';

interface Scenario { id: string; slug: string; name: string; language: string | null }

interface ScenarioListProps {
  scenarios: Scenario[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
}

export function ScenarioList({ scenarios, selected, onToggle, onSelectAll }: ScenarioListProps) {
  const allSelected = scenarios.length > 0 && scenarios.every((s) => selected.has(s.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {selected.size} of {scenarios.length} selected
        </span>
        <button onClick={onSelectAll} className="text-xs text-[var(--accent)] hover:underline">
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="space-y-1">
        {scenarios.map((s) => (
          <label key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-[var(--bg-raised)] cursor-pointer transition-colors">
            <input type="checkbox" checked={selected.has(s.id)} onChange={() => onToggle(s.id)} className="accent-[var(--accent)]" />
            <span className="text-sm text-[var(--text-primary)]">{s.name}</span>
            {s.language && <span className="font-mono text-xs text-[var(--text-muted)]">{s.language}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
```

- [x] **Step 3: Create `summary-bar.tsx`**

Create `web/src/components/matrix-builder/summary-bar.tsx`:

```tsx
'use client';

interface SummaryBarProps {
  laneCount: number;     // number of (agent × model) pairs selected
  scenarioCount: number;
  onStart: () => void;
  isStarting: boolean;
}

export function SummaryBar({ laneCount, scenarioCount, onStart, isStarting }: SummaryBarProps) {
  // Each lane runs every scenario → total tasks = lanes × scenarios
  const totalTasks = laneCount * scenarioCount;

  return (
    <div className="flex items-center justify-between p-4 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)]">
      <div className="font-mono text-sm text-[var(--text-secondary)]">
        <span className="text-[var(--accent)]">{laneCount}</span> lane{laneCount !== 1 ? 's' : ''}
        {' × '}
        <span className="text-[var(--accent)]">{scenarioCount}</span> scenario{scenarioCount !== 1 ? 's' : ''}
        {' = '}
        <span className="font-bold text-[var(--text-primary)]">{totalTasks}</span> task{totalTasks !== 1 ? 's' : ''}
      </div>
      <button
        onClick={onStart}
        disabled={totalTasks === 0 || isStarting}
        className="font-mono text-sm px-6 py-2 rounded-lg bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isStarting ? 'Starting...' : 'Start Run'}
      </button>
    </div>
  );
}
```

- [x] **Step 4: Assemble Matrix Builder page**

Replace `web/src/app/run/page.tsx` — this is a `'use client'` page that fetches agents and scenarios from the API, lets users select agent×model×scenario combinations, and starts a run. See spec Section "Matrix Builder" for the full layout. The page imports `AgentCard`, `ScenarioList`, `SummaryBar` components. On "Start Run" it POSTs to `/api/runs` and redirects to `/run/[runId]`.

Key state:
- `agents: Agent[]` — from `GET /api/agents`
- `scenarios: Scenario[]` — from `GET /api/scenarios`
- `selections: Map<agentId, Set<modelDbId>>` — agent×model selections
- `selectedScenarios: Set<scenarioId>` — scenario selections

Full implementation: see the `AgentCard`, `ScenarioList`, and `SummaryBar` components above. Wire them together with `useEffect` for data fetching, `useCallback` handlers for toggling selections, and a `startRun` function that POSTs the matrix and navigates to the progress view.

- [x] **Step 5: Commit**

```bash
git add web/src/app/run/page.tsx web/src/components/matrix-builder/
git commit -m "feat(web): add Matrix Builder page with agent/model/scenario selection"
```

---

### Task 13: Progress View Page

**Files:**
- Create: `web/src/app/run/[runId]/page.tsx`
- Create: `web/src/components/progress/progress-matrix.tsx`
- Create: `web/src/components/progress/progress-bar.tsx`
- Create: `web/src/components/progress/now-running.tsx`

- [x] **Step 1: Create `progress-bar.tsx`**

Create `web/src/components/progress/progress-bar.tsx`:

```tsx
'use client';

interface ProgressBarProps {
  completed: number;
  total: number;
  startTime: Date | null;
}

export function ProgressBar({ completed, total, startTime }: ProgressBarProps) {
  const pct = total > 0 ? (completed / total) * 100 : 0;

  let eta = '';
  if (startTime && completed > 0 && completed < total) {
    const elapsed = (Date.now() - startTime.getTime()) / 1000;
    const perTask = elapsed / completed;
    const remaining = Math.round(perTask * (total - completed));
    eta = remaining > 60 ? `~${Math.ceil(remaining / 60)}m remaining` : `~${remaining}s remaining`;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-mono text-[var(--text-secondary)]">{completed} / {total} tasks</span>
        {eta && <span className="text-xs text-[var(--text-muted)]">{eta}</span>}
      </div>
      <div className="h-2 rounded-full bg-[var(--bg-raised)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
```

- [x] **Step 2: Create `now-running.tsx`**

Create `web/src/components/progress/now-running.tsx`:

```tsx
'use client';

interface NowRunningProps { agent: string; model: string; scenario: string; elapsed: number }

export function NowRunning({ agent, model, scenario, elapsed }: NowRunningProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      <span className="font-mono text-[var(--text-secondary)]">{agent} × {model} × {scenario}</span>
      <span className="text-xs text-[var(--text-muted)]">({elapsed}s)</span>
    </div>
  );
}
```

- [x] **Step 3: Create `progress-matrix.tsx`**

Create `web/src/components/progress/progress-matrix.tsx` — a table component. Rows = agent×model pairs, columns = scenario slugs. Each cell renders based on status:

- `pending` → grey dash
- `running` → amber pulse dot
- `retrying` → amber pulse + attempt badge (`2/4`)
- `completed` → score number, color-coded (green ≥80, accent ≥60, amber ≥40, red <40)
- `failed` → red score + warning icon
- `error` → red X
- `cancelled` → grey slash

First column (agent×model) is `sticky left-0` for horizontal scroll.

Export a `cellKey(agent, model, scenario)` helper for consistent Map key construction.

- [x] **Step 4: Assemble Progress View page**

Create `web/src/app/run/[runId]/page.tsx` — a `'use client'` page that:

1. Fetches run metadata via `/api/runs/[runId]` on mount
2. Connects to `EventSource` at `/api/runs/[runId]/stream`
3. Builds rows/columns/cells state from SSE events
4. Renders `ProgressBar`, `NowRunning`, `ProgressMatrix` components
5. Shows run status badge: `pending` (grey), `running` (amber pulse), `completed` (green), `failed` (red), `error` (red outline), `cancelled` (grey slash)
6. Closes EventSource on `run:completed`, `run:cancelled`, or `run:error`

Key state:
- `cells: Map<string, CellData>` — keyed by `cellKey(agent, model, scenario)`
- `rows: Array<{agent, model}>` — populated as events arrive
- `columns: string[]` — scenario slugs, populated as events arrive
- `completed: number`, `total: number` — for progress bar
- `now: {agent, model, scenario, startTime}` — for "now running" indicator

- [x] **Step 5: Commit**

```bash
git add web/src/app/run/[runId]/page.tsx web/src/components/progress/
git commit -m "feat(web): add Progress View page with SSE-driven matrix"
```

---

### Task 14: Update Scenarios Stub Page

**Files:**
- Modify: `web/src/app/scenarios/page.tsx`

- [x] **Step 1: Replace stub with DB-backed list**

Update `web/src/app/scenarios/page.tsx` — server component that queries scenarios from DB and renders a list. Each scenario shows name, slug, language badge. Header note: "Import via `POST /api/scenarios/import`. Full CRUD coming in Phase 3."

- [x] **Step 2: Commit**

```bash
git add web/src/app/scenarios/page.tsx
git commit -m "feat(web): update scenarios page to list imported scenarios from DB"
```

---

### Task 15: E2E Pipeline Test Scaffold

**Files:**
- Create: `web/e2e/run-pipeline.test.ts`

- [x] **Step 1: Write e2e test scaffold**

Create `web/e2e/run-pipeline.test.ts` — a **scaffold** that validates API surface reachability (no Docker required):

```
1. Pack __test__ scenarios → .litmus-pack (using AdmZip, in-memory)
2. Import via POST /api/scenarios/import → assert 200, scenarios in DB
3. Register mock agent via POST /api/agents → assert 200, agent in DB
```

> **Note:** `POST /api/runs` immediately starts the scheduler + DockerExecutor, so it is NOT included in the no-Docker scaffold. The full pipeline test (create run → SSE stream → `run:completed` → `run_results` rows) requires a running Docker proxy + runtime image and is covered in **Task 16 manual integration verification**.

Prerequisites for scaffold: litmus-web running, PG + Garage (no Docker needed).

- [x] **Step 2: Commit**

```bash
git add web/e2e/
git commit -m "feat(web): add e2e pipeline test scaffold"
```

---

## Final Verification

### Task 16: Smoke Test + Lint

- [x] **Step 1: Run lint**

```bash
cd web && npm run lint
```

- [x] **Step 2: Run type check**

```bash
cd web && npx tsc --noEmit
```

- [x] **Step 3: Run unit tests**

```bash
cd web && npm test
```

Expected: EventBus (4), DockerExecutor (6), Reconciler (4), Scheduler (5) — all pass.

- [x] **Step 4: Build**

```bash
cd web && npm run build
```

- [x] **Step 5: Fix any issues and commit**

```bash
git add -A && git commit -m "fix(web): resolve lint and type errors from Phase 2 implementation"
```

- [x] **Step 6: Verify all files committed**

```bash
git status
```

No unstaged changes expected.

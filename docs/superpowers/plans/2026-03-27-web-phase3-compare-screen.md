# Phase 3: Compare Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare screen with 4 lens tabs (model-ranking, agent-ranking, agent-x-models, model-x-agents), heatmap, leaderboard, drill-down/breakdown — all driven by materialized views with staleness detection.

**Architecture:** Three layers — (1) Data: fix matview aggregation formula, add error rows to `run_results`, add matview refresh after run completion + on startup; (2) API: SSR via server component for main data, two lazy API endpoints for drill-down/breakdown; (3) UI: TabBar + SplitPanel (leaderboard + heatmap), drill-down slide-over (detailed lenses), breakdown popover (aggregated lenses). URL-driven state via `searchParams`.

**Tech Stack:** Next.js App Router stack used by this repo, Drizzle ORM, PostgreSQL matviews, Vitest, Tailwind CSS 4, CSS variables (Lab Instrument Design System).

**Spec:** `docs/superpowers/specs/2026-03-27-compare-screen-design.md`

---

## File Map

```
web/
├── src/
│   ├── app/
│   │   ├── compare/
│   │   │   ├── page.tsx                          # Server component: validate params, SSR fetch, render
│   │   │   ├── compare-view.tsx                  # Client component: tabs, split panel, drill-down state
│   │   │   ├── loading.tsx                       # Suspense skeleton for tab/anchor switch
│   │   │   └── error.tsx                         # Error boundary with retry
│   │   └── api/compare/
│   │       └── [scenarioId]/
│   │           ├── breakdown/route.ts            # Aggregated drill-down (per-counterpart scores)
│   │           └── drill-down/route.ts           # Detailed drill-down (scores + lineage)
│   ├── components/compare/
│   │   ├── tab-bar.tsx                           # 4 lens tabs, URL-driven active state
│   │   ├── leaderboard.tsx                       # Ranked entity list with medals
│   │   ├── heatmap.tsx                           # Scenario × entity grid
│   │   ├── heatmap-cell.tsx                      # Single cell: score, color, stale/error-only states
│   │   ├── drill-down-panel.tsx                  # Slide-over: scores + run lineage (detailed lenses)
│   │   ├── breakdown-popover.tsx                 # Per-counterpart breakdown (aggregated lenses)
│   │   └── anchor-dropdown.tsx                   # Entity selector for detailed lenses
│   ├── lib/compare/
│   │   ├── queries.ts                            # Server-side matview queries (all 4 lenses)
│   │   └── types.ts                              # CompareResponse, HeatmapCell, BreakdownResponse, DrillDownResponse
│   ├── lib/db/
│   │   └── refresh-matviews.ts                   # Shared REFRESH MATERIALIZED VIEW helper for runtime paths
│   ├── lib/orchestrator/
│   │   ├── scheduler.ts                          # MODIFY: error rows in run_results + matview refresh
│   │   ├── startup.ts                            # MODIFY: synthesize error rows + matview refresh
│   │   └── __tests__/
│   │       ├── scheduler.test.ts                 # Error-row persistence in scheduler paths
│   │       └── startup.test.ts                   # Crash-recovery synthesis + matview refresh
│   └── db/
│       └── migrate-views.ts                      # MODIFY: two-step aggregation formula
├── drizzle/
│   └── 0003_compare_index.sql                    # New migration: partial composite index
└── src/lib/compare/__tests__/
    ├── queries.test.ts                           # Query layer unit tests
    └── breakdown.test.ts                         # Breakdown/drill-down API tests
```

---

## Task 1: Types — Compare Response Interfaces

**Files:**
- Create: `web/src/lib/compare/types.ts`

- [ ] **Step 1: Create type definitions**

```typescript
// web/src/lib/compare/types.ts

export type LensType = 'model-ranking' | 'agent-ranking' | 'agent-x-models' | 'model-x-agents';

export interface HeatmapCell {
  score: number;
  bestInRow: boolean;
  stale: boolean;
  errorOnly: boolean;
  errorCount?: number;
  testsPassed?: number;
  testsTotal?: number;
  status?: 'completed' | 'failed';
  counterpartCount?: number;
  staleCount?: number;
  sourceCount?: number;
}

export interface LeaderboardEntry {
  rank: number;
  entityId: string;
  entityName: string;
  avgScore: number;
  scenarioCount: number;
  totalScenarios: number;
  counterpartCount: number;
  lowCoverage: boolean;
}

export interface CompareResponse {
  lens: LensType;
  anchor?: { id: string; name: string };
  availableAnchors?: { id: string; name: string }[];
  canonicalParams: { lens: string; agentId?: string; modelId?: string };

  leaderboard: LeaderboardEntry[];

  heatmap: {
    columns: { id: string; name: string }[];
    rows: { id: string; slug: string; name: string }[];
    cells: Record<string, Record<string, HeatmapCell | null>>;
    totals: Record<string, number>;
  };
}

export interface BreakdownResponse {
  scenario: { id: string; slug: string; name: string };
  entity: { id: string; name: string; type: 'model' | 'agent' };
  avgScore: number | null;

  breakdown: {
    counterpartId: string;
    counterpartName: string;
    score: number;
    testsPassed: number;
    testsTotal: number;
    status: 'completed' | 'failed';
    stale: boolean;
    createdAt: string;
  }[];

  errorOnlyCounterparts: {
    counterpartId: string;
    counterpartName: string;
    errorCount: number;
    lastErrorAt: string;
    lastErrorMessage: string | null;
  }[];
}

export interface DrillDownResponse {
  scenario: { id: string; slug: string; name: string };
  agent: { id: string; name: string };
  model: { id: string; name: string };

  latest: null | {
    runId: string;
    score: number;
    testsPassed: number;
    testsTotal: number;
    durationSeconds: number;
    attempt: number;
    maxAttempts: number;
    status: 'completed' | 'failed';
    agentVersion: string | null;
    scenarioVersion: string | null;
    judgeScores: Record<string, number> | null;
    artifactsS3Key: string | null;
    errorMessage: string | null;
    createdAt: string;
  };

  history: {
    runId: string;
    score: number;
    testsPassed: number;
    testsTotal: number;
    durationSeconds: number;
    status: 'completed' | 'failed' | 'error';
    agentVersion: string | null;
    scenarioVersion: string | null;
    artifactsS3Key: string | null;
    errorMessage: string | null;
    createdAt: string;
    trend: number | null;
    isLatest: boolean;
  }[];
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/compare/types.ts
git commit -m "feat(web): add Compare Screen type definitions"
```

---

## Task 2: DB Migration — Partial Composite Index

**Files:**
- Create: `web/drizzle/0003_compare_index.sql`

- [ ] **Step 1: Create migration file**

```sql
-- web/drizzle/0003_compare_index.sql
-- Optimizes DISTINCT ON for latest_results matview refresh
CREATE INDEX IF NOT EXISTS idx_run_results_latest_wins
    ON run_results(agent_id, model_id, scenario_id, created_at DESC)
    WHERE status IN ('completed', 'failed');
```

- [ ] **Step 2: Update drizzle journal**

Add the new migration entry to `web/drizzle/meta/_journal.json`. Increment the `idx` from the last entry, use tag `"0003_compare_index"`, current date as `when`.

- [ ] **Step 3: Run migration**

Run: `cd web && npx drizzle-kit migrate`
Expected: migration applied successfully and the new index exists in PostgreSQL.
Note: prefer the project's existing script wrapper (`cd web && npm run db:migrate`) if CI/dev workflow already standardizes on it.

- [ ] **Step 4: Commit**

```bash
git add web/drizzle/0003_compare_index.sql web/drizzle/meta/_journal.json
git commit -m "feat(web): add partial composite index for latest_results optimization"
```

---

## Task 3: Fix Matview Aggregation Formula

**Files:**
- Modify: `web/src/db/migrate-views.ts`

- [ ] **Step 1: Update matview SQL with two-step aggregation**

Replace the `score_by_model` and `score_by_agent` matview definitions in `migrate-views.ts` with the corrected two-step formula.

Lock the semantics before editing:
- `counterpart_count` means distinct counterparts visible in `latest_results` for that entity across the whole current snapshot, not just counterparts in one UI slice.
- Use an explicit alias for the outer grouped row so later edits do not rely on implicit correlated-subquery resolution.

The full `VIEWS_SQL` constant becomes:

```typescript
const VIEWS_SQL = `
-- Drop and recreate to handle schema changes
DROP MATERIALIZED VIEW IF EXISTS score_by_agent CASCADE;
DROP MATERIALIZED VIEW IF EXISTS score_by_model CASCADE;
DROP MATERIALIZED VIEW IF EXISTS latest_results CASCADE;

-- Latest result per (agent, model, scenario) combo
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

-- Model leaderboard (two-step: AVG per scenario, then AVG across scenarios)
CREATE MATERIALIZED VIEW score_by_model AS
WITH per_scenario AS (
    SELECT model_id, scenario_id,
           AVG(total_score) AS scenario_avg,
           COUNT(DISTINCT agent_id) AS agent_count
    FROM latest_results
    GROUP BY model_id, scenario_id
)
SELECT
    ps.model_id,
    AVG(ps.scenario_avg) AS avg_score,
    COUNT(DISTINCT ps.scenario_id) AS scenario_count,
    SUM(ps.agent_count)::int AS total_pairs,
    (SELECT COUNT(DISTINCT lr.agent_id)
     FROM latest_results lr
     WHERE lr.model_id = ps.model_id) AS counterpart_count
FROM per_scenario ps
GROUP BY ps.model_id;

CREATE UNIQUE INDEX idx_score_by_model_pk ON score_by_model(model_id);

-- Agent leaderboard (two-step: AVG per scenario, then AVG across scenarios)
CREATE MATERIALIZED VIEW score_by_agent AS
WITH per_scenario AS (
    SELECT agent_id, scenario_id,
           AVG(total_score) AS scenario_avg,
           COUNT(DISTINCT model_id) AS model_count
    FROM latest_results
    GROUP BY agent_id, scenario_id
)
SELECT
    ps.agent_id,
    AVG(ps.scenario_avg) AS avg_score,
    COUNT(DISTINCT ps.scenario_id) AS scenario_count,
    SUM(ps.model_count)::int AS total_pairs,
    (SELECT COUNT(DISTINCT lr.model_id)
     FROM latest_results lr
     WHERE lr.agent_id = ps.agent_id) AS counterpart_count
FROM per_scenario ps
GROUP BY ps.agent_id;

CREATE UNIQUE INDEX idx_score_by_agent_pk ON score_by_agent(agent_id);
`;
```

- [ ] **Step 2: Run migrate-views to verify SQL**

Run: `cd web && npx tsx src/db/migrate-views.ts`
Expected: "Materialized views created successfully."

- [ ] **Step 3: Commit**

```bash
git add web/src/db/migrate-views.ts
git commit -m "fix(web): correct matview aggregation to two-step formula (equal scenario weight)"
```

---

## Task 4: Error Rows in `run_results` + Matview Refresh

**Files:**
- Create: `web/src/lib/db/refresh-matviews.ts`
- Modify: `web/src/lib/orchestrator/scheduler.ts`
- Modify: `web/src/lib/orchestrator/startup.ts`
- Test: `web/src/lib/orchestrator/__tests__/scheduler.test.ts`
- Create: `web/src/lib/orchestrator/__tests__/startup.test.ts`

- [ ] **Step 1: Write failing test — persistTaskError inserts run_results row**

Add to `web/src/lib/orchestrator/__tests__/scheduler.test.ts`:

```typescript
import { runResults } from '@/db/schema';

describe('persistTaskError', () => {
  it('should insert error row into run_results alongside updating runTasks', async () => {
    // Track insert target + payload without depending on Drizzle internals
    const insertCalls: Array<{ table: unknown; values: unknown }> = [];
    vi.spyOn(db, 'insert').mockImplementation((table: any) => {
      const chain = {
        values: (vals: unknown) => {
          insertCalls.push({ table, values: vals });
          return { onConflictDoNothing: () => Promise.resolve() };
        },
      };
      return chain as any;
    });

    // Execute a scenario that triggers persistTaskError (init.sh exit 2)
    mockExec.mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'init failed' });

    await scheduler.execute(runConfig);

    // Verify run_results insert was called with status='error'
    const rrInsert = insertCalls.find(c => c.table === runResults);
    expect(rrInsert).toBeDefined();
    expect((rrInsert!.values as any).status).toBe('error');
    expect((rrInsert!.values as any).totalScore).toBe(0);
    expect((rrInsert!.values as any).errorMessage).toBe('init.sh infra error (exit 2): init failed');
  });
});
```

If this unit test starts mirroring too much Drizzle fluent internals, switch to a temporary-DB integration test and assert the persisted `run_results` row directly instead of hard-coding mock chain details.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts --reporter=verbose -t "persistTaskError"`
Expected: FAIL — `persistTaskError` currently only updates `runTasks`, no `run_results` insert.

- [ ] **Step 3: Modify `persistTaskError` to insert error row into `run_results`**

In `web/src/lib/orchestrator/scheduler.ts`, the `persistTaskError` method needs the full task context (runId, agentId, modelId, scenarioId) to insert into `run_results`. Change the method signature and add the insert:

```typescript
/** Persist terminal error status to both run_tasks and run_results */
private async persistTaskError(
  taskId: string,
  errorMessage: string,
  meta: { runId: string; agentId: string; modelId: string; scenarioId: string },
): Promise<void> {
  await db
    .update(runTasks)
    .set({ status: 'error', finishedAt: new Date(), errorMessage })
    .where(eq(runTasks.id, taskId))
    .catch((err) => {
      console.warn('[scheduler] failed to persist run_tasks error status', err);
    });

  await db
    .insert(runResults)
    .values({
      runId: meta.runId,
      agentId: meta.agentId,
      modelId: meta.modelId,
      scenarioId: meta.scenarioId,
      status: 'error',
      totalScore: 0,
      testsPassed: 0,
      testsTotal: 0,
      errorMessage,
    })
    .onConflictDoNothing()
    .catch((err) => {
      console.warn('[scheduler] failed to persist run_results error row', err);
    });
}
```

Update all call sites in `executeScenario` to pass the meta object:

```typescript
// Where taskId is resolved, also build meta:
const meta = { runId: config.runId, agentId: lane.agent.id, modelId: lane.model.id, scenarioId: scenario.id };

// Each call becomes:
await this.persistTaskError(taskId, msg, meta);
```

Add `runResults` to imports:

```typescript
import { runs, runTasks, runResults } from '@/db/schema';
```

- [ ] **Step 4: Add lane-level error persistence in `executeLane` catch block**

The catch block at line 153 currently just increments the error counter without persisting anything. Add persistence for remaining unprocessed scenarios:

```typescript
} catch (err) {
  // Persist error rows for all remaining unprocessed scenarios
  const processed = results.completed + results.failed + results.error;
  const remaining = lane.scenarios.slice(processed);
  const errorMsg = err instanceof Error ? err.message : 'Lane-level infrastructure failure';

  for (const scenario of remaining) {
    try {
      const taskId = this.resolveTaskId(config, lane, scenario.id);
      await this.persistTaskError(taskId, errorMsg, {
        runId: config.runId,
        agentId: lane.agent.id,
        modelId: lane.model.id,
        scenarioId: scenario.id,
      });
    } catch { /* best-effort */ }
  }

  results.error += remaining.length;
}
```

- [ ] **Step 5: Add matview refresh after run completion**

Create `web/src/lib/db/refresh-matviews.ts`:

```typescript
// web/src/lib/db/refresh-matviews.ts
import { sql } from '@/db';

const VIEWS = ['latest_results', 'score_by_model', 'score_by_agent'] as const;

/**
 * `@/db` exports the raw postgres-js client as `sql`.
 * Verify that invariant before using this helper; if it changes, keep refreshes on the raw client.
 */
export async function refreshMatviews(logger: Pick<typeof console, 'warn'> = console): Promise<void> {
  for (const view of VIEWS) {
    try {
      await sql.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const needsFallback =
        /concurrently/i.test(message) ||
        /has not been populated/i.test(message);

      if (!needsFallback) throw err;

      logger.warn(`[matviews] concurrent refresh unavailable for ${view}; retrying without CONCURRENTLY`);
      await sql.unsafe(`REFRESH MATERIALIZED VIEW ${view}`);
    }
  }
}
```

Then in `scheduler.ts`, after updating run status (line ~96), add matview refresh:

Refresh on both terminal statuses (`completed` and `cancelled`). Even cancelled runs may have already persisted finished task results, and compare should surface those rows without waiting for another startup cycle.

```typescript
// Update run status
const finalStatus = this.cancelled ? 'cancelled' : 'completed';
await db
  .update(runs)
  .set({ status: finalStatus, finishedAt: new Date() })
  .where(eq(runs.id, config.runId))
  .catch((err) => {
    console.warn('[scheduler] failed to persist final run status', err);
  });

// Refresh materialized views so compare page sees latest data
await refreshMatviews().catch((err) => {
  console.warn('[scheduler] matview refresh failed after run completion', err);
});
```

Add the import in `scheduler.ts`:

```typescript
import { refreshMatviews } from '@/lib/db/refresh-matviews';
```

- [ ] **Step 6: Update startup.ts — synthesize error rows + refresh matviews**

Replace `web/src/lib/orchestrator/startup.ts`:

```typescript
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks, runResults, agentExecutors } from '@/db/schema';
import { DockerExecutor } from './docker-executor';
import { refreshMatviews } from '@/lib/db/refresh-matviews';
import { env } from '@/lib/env';

export async function startupCleanup(): Promise<void> {
  const executor = new DockerExecutor(env.DOCKER_HOST);

  const cleaned = await executor.cleanupOrphans();
  if (cleaned > 0) {
    console.log(`[startup] Cleaned ${cleaned} orphaned agent containers`);
  }

  // Mark running tasks as error
  const staleTasks = await db
    .update(runTasks)
    .set({ status: 'error', errorMessage: 'Process terminated unexpectedly', finishedAt: new Date() })
    .where(inArray(runTasks.status, ['running']))
    .returning();

  if (staleTasks.length > 0) {
    console.log(`[startup] Marked ${staleTasks.length} stale running tasks as error`);

    // Synthesize run_results error rows for each stale task
    for (const task of staleTasks) {
      // Resolve agentId from agentExecutor
      const [executor] = await db
        .select({ agentId: agentExecutors.agentId })
        .from(agentExecutors)
        .where(eq(agentExecutors.id, task.agentExecutorId))
        .limit(1);

      if (!executor) continue;

      await db
        .insert(runResults)
        .values({
          runId: task.runId,
          agentId: executor.agentId,
          modelId: task.modelId,
          scenarioId: task.scenarioId,
          status: 'error',
          totalScore: 0,
          testsPassed: 0,
          testsTotal: 0,
          errorMessage: 'Process terminated unexpectedly',
        })
        .onConflictDoNothing()
        .catch((err) => {
          console.warn('[startup] failed to synthesize run_results error row', err);
        });
    }
  }

  // Mark running runs as failed
  await db
    .update(runs)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(eq(runs.status, 'running'));

  // Refresh matviews to include any new error rows
  await refreshMatviews().catch((err) => {
    console.warn('[startup] matview refresh failed after startup recovery:', err);
  });
}
```

- [ ] **Step 7: Write failing startup recovery test**

Keep this as a unit test only while the production Drizzle chain stays close to the mocked shape. If the chain grows more complex, prefer a temp-DB integration test over a deeper fluent mock.

Create `web/src/lib/orchestrator/__tests__/startup.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cleanupOrphans = vi.fn();
const returning = vi.fn();
const insertValues = vi.fn();
const refreshMatviews = vi.fn();

vi.mock('@/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning,
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ agentId: 'agent-1' }]),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: insertValues,
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  runs: {},
  runTasks: {},
  runResults: {},
  agentExecutors: {},
}));

vi.mock('../docker-executor', () => ({
  DockerExecutor: vi.fn().mockImplementation(() => ({
    cleanupOrphans,
  })),
}));

vi.mock('@/lib/db/refresh-matviews', () => ({
  refreshMatviews,
}));

describe('startupCleanup', () => {
  beforeEach(() => {
    cleanupOrphans.mockResolvedValue(0);
    returning.mockResolvedValue([
      {
        runId: 'run-1',
        agentExecutorId: 'exec-1',
        modelId: 'model-1',
        scenarioId: 'scenario-1',
      },
    ]);
    insertValues.mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    });
    refreshMatviews.mockResolvedValue(undefined);
  });

  it('synthesizes error rows for stale running tasks and refreshes matviews', async () => {
    const { startupCleanup } = await import('../startup');

    await startupCleanup();

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      agentId: 'agent-1',
      modelId: 'model-1',
      scenarioId: 'scenario-1',
      status: 'error',
      totalScore: 0,
      testsPassed: 0,
      testsTotal: 0,
      errorMessage: 'Process terminated unexpectedly',
    }));
    expect(refreshMatviews).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 8: Run startup + scheduler tests to verify they pass**

Run: `cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts src/lib/orchestrator/__tests__/startup.test.ts --reporter=verbose`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/db/refresh-matviews.ts web/src/lib/orchestrator/scheduler.ts web/src/lib/orchestrator/startup.ts web/src/lib/orchestrator/__tests__/scheduler.test.ts web/src/lib/orchestrator/__tests__/startup.test.ts
git commit -m "feat(web): persist error rows and refresh matviews in runtime recovery paths"
```

---

## Task 5: Server-Side Query Layer

**Files:**
- Create: `web/src/lib/compare/queries.ts`
- Create: `web/src/lib/compare/__tests__/queries.test.ts`

- [ ] **Step 1: Write failing test for `fetchCompareData`**

```typescript
// web/src/lib/compare/__tests__/queries.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = Object.assign(
  vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve([])),
  { unsafe: vi.fn((_q: string) => Promise.resolve([])) },
);

// Mock db module
vi.mock('@/db', () => ({
  sql: sqlMock,
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue(Promise.resolve([])),
        }),
        orderBy: vi.fn().mockReturnValue(Promise.resolve([])),
      }),
    }),
  },
}));

import { fetchCompareData } from '../queries';

describe('fetchCompareData', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    sqlMock.mockResolvedValue([]);
    sqlMock.unsafe.mockResolvedValue([]);
  });

  it('should return empty leaderboard and heatmap for model-ranking when no data', async () => {
    const result = await fetchCompareData({ lens: 'model-ranking' });

    expect(result.lens).toBe('model-ranking');
    expect(result.leaderboard).toEqual([]);
    expect(result.heatmap.rows).toEqual([]);
    expect(result.heatmap.columns).toEqual([]);
    expect(result.heatmap.cells).toEqual({});
  });

  it('should canonicalize agent-x-models to the first available agent when agentId is missing', async () => {
    // Queue responses so the anchor lookup returns at least one agent.
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]); // totalScenarios
    sqlMock.unsafe.mockResolvedValueOnce([{ id: 'agent-1', name: 'Cursor' }]); // anchors

    const result = await fetchCompareData({ lens: 'agent-x-models' });
    expect(result.canonicalParams).toEqual({
      lens: 'agent-x-models',
      agentId: 'agent-1',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/compare/__tests__/queries.test.ts --reporter=verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `queries.ts`**

Implementation constraint before writing the file:
- Use branch-specific parameterized `sql\`\`` queries for each lens family.
- Do **not** interpolate `agentId`, `modelId`, `scenarioId`, or `anchorId` into `sql.unsafe(...)` strings.
- If an identifier (table/view/column name) must vary by lens, choose it from a hardcoded map in TypeScript first, then plug only the trusted identifier into the SQL shape.
- Treat the code block below as control-flow/reference structure only. Before implementation, rewrite every request-derived filter into tagged-template parameters.

```typescript
// web/src/lib/compare/queries.ts
import { sql } from '@/db';
import type { CompareResponse, HeatmapCell, LensType } from './types';

interface FetchParams {
  lens: LensType;
  agentId?: string;
  modelId?: string;
}

export async function fetchCompareData(params: FetchParams): Promise<CompareResponse> {
  const { lens } = params;

  const totalScenarios = await sql`SELECT COUNT(*) AS cnt FROM scenarios`;
  const totalScenariosCount = Number(totalScenarios[0]?.cnt ?? 0);

  if (lens === 'model-ranking' || lens === 'agent-ranking') {
    return fetchRankingData(lens, totalScenariosCount);
  }
  return fetchDetailedData(params, totalScenariosCount);
}

async function fetchRankingData(
  lens: 'model-ranking' | 'agent-ranking',
  totalScenarios: number,
): Promise<CompareResponse> {
  const isModel = lens === 'model-ranking';
  const entityTable = isModel ? 'models' : 'agents';
  const scoreView = isModel ? 'score_by_model' : 'score_by_agent';
  const entityCol = isModel ? 'model_id' : 'agent_id';
  const counterpartCol = isModel ? 'agent_id' : 'model_id';

  // Leaderboard from matview
  const leaderboardRows = await sql.unsafe(`
    SELECT sv.${entityCol} AS entity_id, e.name AS entity_name,
           sv.avg_score, sv.scenario_count,
           COALESCE(sv.counterpart_count, 0) AS counterpart_count
    FROM ${scoreView} sv
    JOIN ${entityTable} e ON e.id = sv.${entityCol}
    ORDER BY sv.avg_score DESC
  `);

  const leaderboard = leaderboardRows.map((row: any, i: number) => ({
    rank: i + 1,
    entityId: row.entity_id,
    entityName: row.entity_name,
    avgScore: Number(row.avg_score),
    scenarioCount: Number(row.scenario_count),
    totalScenarios,
    counterpartCount: Number(row.counterpart_count),
    lowCoverage: Number(row.counterpart_count) <= 1,
  }));

  // Heatmap: scenarios as columns, entities as rows
  const scenarios = await sql`SELECT id, slug, name FROM scenarios ORDER BY slug`;
  const columns = scenarios.map((s: any) => ({ id: s.id, name: s.name }));

  // Per-cell: AVG(total_score) across hidden counterparts
  const cellRows = await sql.unsafe(`
    SELECT lr.${entityCol} AS entity_id, lr.scenario_id,
           AVG(lr.total_score) AS avg_score,
           COUNT(DISTINCT lr.${counterpartCol}) AS counterpart_count
    FROM latest_results lr
    GROUP BY lr.${entityCol}, lr.scenario_id
  `);

  // Staleness detection
  const staleRows = await sql.unsafe(`
    SELECT lr.${entityCol} AS entity_id, lr.scenario_id,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM run_results rr
             WHERE rr.${entityCol} = lr.${entityCol}
               AND rr.scenario_id = lr.scenario_id
               AND rr.${counterpartCol} = lr.${counterpartCol}
               AND rr.status = 'error'
               AND rr.created_at > lr.created_at
           )) AS stale_count,
           COUNT(*) AS source_count
    FROM latest_results lr
    GROUP BY lr.${entityCol}, lr.scenario_id
  `);

  // Error-only detection
  const errorOnlyRows = await sql.unsafe(`
    SELECT DISTINCT rr.${entityCol} AS entity_id, rr.scenario_id,
           COUNT(*) AS error_count
    FROM run_results rr
    WHERE rr.status = 'error'
      AND NOT EXISTS (
          SELECT 1 FROM latest_results lr
          WHERE lr.${entityCol} = rr.${entityCol}
            AND lr.${counterpartCol} = rr.${counterpartCol}
            AND lr.scenario_id = rr.scenario_id
      )
    GROUP BY rr.${entityCol}, rr.scenario_id
  `);

  // Build cells map
  const cells: Record<string, Record<string, HeatmapCell | null>> = {};
  const totals: Record<string, number> = {};

  // Index helpers
  const cellMap = new Map<string, any>();
  for (const r of cellRows) cellMap.set(`${r.entity_id}:${r.scenario_id}`, r);
  const staleMap = new Map<string, any>();
  for (const r of staleRows) staleMap.set(`${r.entity_id}:${r.scenario_id}`, r);
  const errorOnlyMap = new Map<string, any>();
  for (const r of errorOnlyRows) errorOnlyMap.set(`${r.entity_id}:${r.scenario_id}`, r);

  const rows = leaderboard.map((e) => ({
    id: e.entityId,
    slug: e.entityName.toLowerCase().replace(/\s+/g, '-'),
    name: e.entityName,
  }));

  for (const entity of rows) {
    cells[entity.id] = {};
    const rowScores: number[] = [];

    for (const col of columns) {
      const key = `${entity.id}:${col.id}`;
      const cell = cellMap.get(key);
      const stale = staleMap.get(key);
      const eo = errorOnlyMap.get(key);

      if (cell) {
        const score = Number(cell.avg_score);
        rowScores.push(score);
        cells[entity.id][col.id] = {
          score,
          bestInRow: false,
          stale: stale ? Number(stale.stale_count) > 0 : false,
          errorOnly: false,
          counterpartCount: Number(cell.counterpart_count),
          staleCount: stale ? Number(stale.stale_count) : 0,
          sourceCount: stale ? Number(stale.source_count) : 0,
        };
      } else if (eo) {
        cells[entity.id][col.id] = {
          score: 0,
          bestInRow: false,
          stale: false,
          errorOnly: true,
          errorCount: Number(eo.error_count),
        };
      } else {
        cells[entity.id][col.id] = null;
      }
    }

    // Mark best-in-row
    const maxScore = Math.max(...rowScores, 0);
    if (maxScore > 0) {
      for (const col of columns) {
        const c = cells[entity.id][col.id];
        if (c && !c.errorOnly && c.score === maxScore) {
          c.bestInRow = true;
        }
      }
    }

    totals[entity.id] = rowScores.length > 0 ? rowScores.reduce((a, b) => a + b, 0) / rowScores.length : 0;
  }

  return {
    lens,
    canonicalParams: { lens },
    leaderboard,
    heatmap: { columns, rows, cells, totals },
  };
}

async function fetchDetailedData(
  params: FetchParams,
  totalScenarios: number,
): Promise<CompareResponse> {
  const { lens } = params;
  const isAgentFixed = lens === 'agent-x-models';
  const anchorCol = isAgentFixed ? 'agent_id' : 'model_id';
  const entityCol = isAgentFixed ? 'model_id' : 'agent_id';
  const anchorTable = isAgentFixed ? 'agents' : 'models';
  const entityTable = isAgentFixed ? 'models' : 'agents';
  const anchorParamId = isAgentFixed ? params.agentId : params.modelId;

  // Get available anchors (for dropdown)
  const anchors = await sql.unsafe(`
    SELECT DISTINCT lr.${anchorCol} AS id, a.name
    FROM latest_results lr
    JOIN ${anchorTable} a ON a.id = lr.${anchorCol}
    ORDER BY a.name
  `);
  const availableAnchors = anchors.map((a: any) => ({ id: a.id, name: a.name }));

  // Resolve anchor
  let anchorId = anchorParamId;
  if (!anchorId && availableAnchors.length > 0) {
    anchorId = availableAnchors[0].id;
  }

  const canonicalParams: any = { lens };
  if (isAgentFixed) canonicalParams.agentId = anchorId;
  else canonicalParams.modelId = anchorId;

  if (!anchorId) {
    return {
      lens: lens as LensType,
      availableAnchors,
      canonicalParams,
      leaderboard: [],
      heatmap: { columns: [], rows: [], cells: {}, totals: {} },
    };
  }

  const anchor = availableAnchors.find((a: any) => a.id === anchorId) ?? { id: anchorId!, name: '' };

  // Leaderboard: entities ranked by avg score for this anchor
  const entityRows = isAgentFixed
    ? await sql`
        SELECT lr.model_id AS entity_id, m.name AS entity_name,
               AVG(lr.total_score) AS avg_score,
               COUNT(DISTINCT lr.scenario_id) AS scenario_count
        FROM latest_results lr
        JOIN models m ON m.id = lr.model_id
        WHERE lr.agent_id = ${anchorId}
        GROUP BY lr.model_id, m.name
        ORDER BY avg_score DESC
      `
    : await sql`
        SELECT lr.agent_id AS entity_id, a.name AS entity_name,
               AVG(lr.total_score) AS avg_score,
               COUNT(DISTINCT lr.scenario_id) AS scenario_count
        FROM latest_results lr
        JOIN agents a ON a.id = lr.agent_id
        WHERE lr.model_id = ${anchorId}
        GROUP BY lr.agent_id, a.name
        ORDER BY avg_score DESC
      `;

  const leaderboard = entityRows.map((row: any, i: number) => ({
    rank: i + 1,
    entityId: row.entity_id,
    entityName: row.entity_name,
    avgScore: Number(row.avg_score),
    scenarioCount: Number(row.scenario_count),
    totalScenarios,
    counterpartCount: 1,
    lowCoverage: false,
  }));

  // Heatmap: direct lookup from latest_results
  const scenarios = await sql`SELECT id, slug, name FROM scenarios ORDER BY slug`;
  const columns = scenarios.map((s: any) => ({ id: s.id, name: s.name }));

  const cellRows = isAgentFixed
    ? await sql`
        SELECT lr.model_id AS entity_id, lr.scenario_id,
               lr.total_score, lr.tests_passed, lr.tests_total, lr.status, lr.created_at
        FROM latest_results lr
        WHERE lr.agent_id = ${anchorId}
      `
    : await sql`
        SELECT lr.agent_id AS entity_id, lr.scenario_id,
               lr.total_score, lr.tests_passed, lr.tests_total, lr.status, lr.created_at
        FROM latest_results lr
        WHERE lr.model_id = ${anchorId}
      `;

  // Staleness
  const staleRows = isAgentFixed
    ? await sql`
        SELECT lr.model_id AS entity_id, lr.scenario_id,
               EXISTS (
                 SELECT 1 FROM run_results rr
                 WHERE rr.model_id = lr.model_id
                   AND rr.agent_id = lr.agent_id
                   AND rr.scenario_id = lr.scenario_id
                   AND rr.status = 'error'
                   AND rr.created_at > lr.created_at
               ) AS stale
        FROM latest_results lr
        WHERE lr.agent_id = ${anchorId}
      `
    : await sql`
        SELECT lr.agent_id AS entity_id, lr.scenario_id,
               EXISTS (
                 SELECT 1 FROM run_results rr
                 WHERE rr.agent_id = lr.agent_id
                   AND rr.model_id = lr.model_id
                   AND rr.scenario_id = lr.scenario_id
                   AND rr.status = 'error'
                   AND rr.created_at > lr.created_at
               ) AS stale
        FROM latest_results lr
        WHERE lr.model_id = ${anchorId}
      `;

  const cellMap = new Map<string, any>();
  for (const r of cellRows) cellMap.set(`${r.entity_id}:${r.scenario_id}`, r);
  const staleMap = new Map<string, any>();
  for (const r of staleRows) staleMap.set(`${r.entity_id}:${r.scenario_id}`, r);

  const cells: Record<string, Record<string, HeatmapCell | null>> = {};
  const totals: Record<string, number> = {};

  const rows = leaderboard.map((e) => ({
    id: e.entityId,
    slug: e.entityName.toLowerCase().replace(/\s+/g, '-'),
    name: e.entityName,
  }));

  for (const entity of rows) {
    cells[entity.id] = {};
    const rowScores: number[] = [];

    for (const col of columns) {
      const key = `${entity.id}:${col.id}`;
      const cell = cellMap.get(key);
      const staleInfo = staleMap.get(key);

      if (cell) {
        const score = Number(cell.total_score);
        rowScores.push(score);
        cells[entity.id][col.id] = {
          score,
          bestInRow: false,
          stale: staleInfo?.stale === true,
          errorOnly: false,
          testsPassed: Number(cell.tests_passed),
          testsTotal: Number(cell.tests_total),
          status: cell.status,
        };
      } else {
        cells[entity.id][col.id] = null;
      }
    }

    const maxScore = Math.max(...rowScores, 0);
    if (maxScore > 0) {
      for (const col of columns) {
        const c = cells[entity.id][col.id];
        if (c && !c.errorOnly && c.score === maxScore) {
          c.bestInRow = true;
        }
      }
    }

    totals[entity.id] = rowScores.length > 0 ? rowScores.reduce((a, b) => a + b, 0) / rowScores.length : 0;
  }

  return {
    lens: lens as LensType,
    anchor,
    availableAnchors,
    canonicalParams,
    leaderboard,
    heatmap: { columns, rows, cells, totals },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/lib/compare/__tests__/queries.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/compare/queries.ts web/src/lib/compare/__tests__/queries.test.ts
git commit -m "feat(web): add server-side compare query layer against matviews"
```

---

## Task 6: Breakdown API Endpoint

**Files:**
- Create: `web/src/app/api/compare/[scenarioId]/breakdown/route.ts`
- Create: `web/src/lib/compare/__tests__/breakdown.test.ts`

- [ ] **Step 1: Write failing breakdown API tests**

Create `web/src/lib/compare/__tests__/breakdown.test.ts` with at least:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sql = vi.fn();

// Tagged-template calls arrive as (strings, ...values). If this repo's driver mock needs
// stricter behavior, use `sql.mockImplementation((strings, ...values) => ...)` rather than
// assuming a single-array argument shape.

vi.mock('@/db', () => ({ sql }));

import { GET as getBreakdown } from '@/app/api/compare/[scenarioId]/breakdown/route';

describe('GET /api/compare/[scenarioId]/breakdown', () => {
  beforeEach(() => {
    sql.mockReset();
  });

  it('returns 400 when neither modelId nor agentId is provided', async () => {
    const request = new NextRequest('http://localhost/api/compare/scenario-1/breakdown');
    const response = await getBreakdown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns scored counterparts plus error-only counterparts for a ranked cell', async () => {
    sql
      .mockResolvedValueOnce([{ id: 'scenario-1', slug: 'todo-app', name: 'Todo App' }])
      .mockResolvedValueOnce([{ id: 'model-1', name: 'GPT-4o' }])
      .mockResolvedValueOnce([
        {
          counterpart_id: 'agent-1',
          counterpart_name: 'Cursor',
          score: 95,
          tests_passed: 19,
          tests_total: 20,
          status: 'completed',
          stale: false,
          created_at: '2026-03-27T10:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          counterpart_id: 'agent-2',
          counterpart_name: 'Aider',
          error_count: 2,
          last_error_at: '2026-03-27T11:00:00Z',
          last_error_message: 'container bootstrap failed',
        },
      ]);

    const request = new NextRequest('http://localhost/api/compare/scenario-1/breakdown?modelId=model-1');
    const response = await getBreakdown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.avgScore).toBe(95);
    expect(body.breakdown).toHaveLength(1);
    expect(body.errorOnlyCounterparts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement aggregated breakdown endpoint**

Implementation constraint:
- Validate `modelId`/`agentId` up front and use parameterized `sql\`\`` bindings for all request-derived values.
- Reserve `sql.unsafe(...)` only for SQL fragments assembled from hardcoded lens metadata, never for URL params.
- The code block below is schematic. Final implementation should use explicit model-ranking / agent-ranking branches for every request-derived filter.

```typescript
// web/src/app/api/compare/[scenarioId]/breakdown/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/db';
import type { BreakdownResponse } from '@/lib/compare/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scenarioId: string }> },
) {
  const { scenarioId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const modelId = searchParams.get('modelId');
  const agentId = searchParams.get('agentId');

  if (!modelId && !agentId) {
    return NextResponse.json({ error: 'modelId or agentId required' }, { status: 400 });
  }

  // Determine lens type from params
  const isModelRanking = !!modelId;
  const entityCol = isModelRanking ? 'model_id' : 'agent_id';
  const entityId = isModelRanking ? modelId : agentId;
  const counterpartCol = isModelRanking ? 'agent_id' : 'model_id';
  const counterpartTable = isModelRanking ? 'agents' : 'models';
  const entityTable = isModelRanking ? 'models' : 'agents';

  // Scenario info
  const [scenario] = await sql`SELECT id, slug, name FROM scenarios WHERE id = ${scenarioId}`;
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  // Entity info
  const [entity] = isModelRanking
    ? await sql`SELECT id, name FROM models WHERE id = ${entityId}`
    : await sql`SELECT id, name FROM agents WHERE id = ${entityId}`;
  if (!entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  // Scored counterparts from latest_results
  const scoredRows = isModelRanking
    ? await sql`
        SELECT lr.agent_id AS counterpart_id, a.name AS counterpart_name,
               lr.total_score AS score, lr.tests_passed, lr.tests_total,
               lr.status, lr.created_at,
               EXISTS (
                 SELECT 1 FROM run_results rr
                 WHERE rr.model_id = lr.model_id
                   AND rr.agent_id = lr.agent_id
                   AND rr.scenario_id = lr.scenario_id
                   AND rr.status = 'error'
                   AND rr.created_at > lr.created_at
               ) AS stale
        FROM latest_results lr
        JOIN agents a ON a.id = lr.agent_id
        WHERE lr.model_id = ${entityId}
          AND lr.scenario_id = ${scenarioId}
        ORDER BY lr.total_score DESC
      `
    : await sql`
        SELECT lr.model_id AS counterpart_id, m.name AS counterpart_name,
               lr.total_score AS score, lr.tests_passed, lr.tests_total,
               lr.status, lr.created_at,
               EXISTS (
                 SELECT 1 FROM run_results rr
                 WHERE rr.agent_id = lr.agent_id
                   AND rr.model_id = lr.model_id
                   AND rr.scenario_id = lr.scenario_id
                   AND rr.status = 'error'
                   AND rr.created_at > lr.created_at
               ) AS stale
        FROM latest_results lr
        JOIN models m ON m.id = lr.model_id
        WHERE lr.agent_id = ${entityId}
          AND lr.scenario_id = ${scenarioId}
        ORDER BY lr.total_score DESC
      `;

  // Error-only counterparts
  const errorOnlyRows = isModelRanking
    ? await sql`
        SELECT rr.agent_id AS counterpart_id, a.name AS counterpart_name,
               COUNT(*) AS error_count,
               MAX(rr.created_at) AS last_error_at,
               (
                 SELECT rr2.error_message
                 FROM run_results rr2
                 WHERE rr2.model_id = rr.model_id
                   AND rr2.agent_id = rr.agent_id
                   AND rr2.scenario_id = rr.scenario_id
                   AND rr2.status = 'error'
                 ORDER BY rr2.created_at DESC
                 LIMIT 1
               ) AS last_error_message
        FROM run_results rr
        JOIN agents a ON a.id = rr.agent_id
        WHERE rr.status = 'error'
          AND rr.model_id = ${entityId}
          AND rr.scenario_id = ${scenarioId}
          AND NOT EXISTS (
            SELECT 1 FROM latest_results lr
            WHERE lr.model_id = rr.model_id
              AND lr.agent_id = rr.agent_id
              AND lr.scenario_id = rr.scenario_id
          )
        GROUP BY rr.agent_id, a.name, rr.model_id, rr.scenario_id
      `
    : await sql`
        SELECT rr.model_id AS counterpart_id, m.name AS counterpart_name,
               COUNT(*) AS error_count,
               MAX(rr.created_at) AS last_error_at,
               (
                 SELECT rr2.error_message
                 FROM run_results rr2
                 WHERE rr2.agent_id = rr.agent_id
                   AND rr2.model_id = rr.model_id
                   AND rr2.scenario_id = rr.scenario_id
                   AND rr2.status = 'error'
                 ORDER BY rr2.created_at DESC
                 LIMIT 1
               ) AS last_error_message
        FROM run_results rr
        JOIN models m ON m.id = rr.model_id
        WHERE rr.status = 'error'
          AND rr.agent_id = ${entityId}
          AND rr.scenario_id = ${scenarioId}
          AND NOT EXISTS (
            SELECT 1 FROM latest_results lr
            WHERE lr.agent_id = rr.agent_id
              AND lr.model_id = rr.model_id
              AND lr.scenario_id = rr.scenario_id
          )
        GROUP BY rr.model_id, m.name, rr.agent_id, rr.scenario_id
      `;

  const breakdown = scoredRows.map((r: any) => ({
    counterpartId: r.counterpart_id,
    counterpartName: r.counterpart_name,
    score: Number(r.score),
    testsPassed: Number(r.tests_passed),
    testsTotal: Number(r.tests_total),
    status: r.status,
    stale: r.stale === true,
    createdAt: r.created_at,
  }));

  const errorOnlyCounterparts = errorOnlyRows.map((r: any) => ({
    counterpartId: r.counterpart_id,
    counterpartName: r.counterpart_name,
    errorCount: Number(r.error_count),
    lastErrorAt: r.last_error_at,
    lastErrorMessage: r.last_error_message,
  }));

  const avgScore = breakdown.length > 0
    ? breakdown.reduce((sum: number, b: any) => sum + b.score, 0) / breakdown.length
    : null;

  const response: BreakdownResponse = {
    scenario: { id: scenario.id, slug: scenario.slug, name: scenario.name },
    entity: { id: entity.id, name: entity.name, type: isModelRanking ? 'model' : 'agent' },
    avgScore,
    breakdown,
    errorOnlyCounterparts,
  };

  return NextResponse.json(response);
}
```

- [ ] **Step 3: Run breakdown API tests**

Run: `cd web && npx vitest run src/lib/compare/__tests__/breakdown.test.ts --reporter=verbose -t "breakdown"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/api/compare/[scenarioId]/breakdown/route.ts web/src/lib/compare/__tests__/breakdown.test.ts
git commit -m "feat(web): add aggregated breakdown API endpoint"
```

---

## Task 7: Drill-Down API Endpoint

**Files:**
- Create: `web/src/app/api/compare/[scenarioId]/drill-down/route.ts`
- Modify: `web/src/lib/compare/__tests__/breakdown.test.ts`

- [ ] **Step 1: Implement detailed drill-down endpoint**

Implementation constraint:
- Keep `scenarioId`, `agentId`, and `modelId` parameterized in tagged SQL queries.
- Do not concatenate request params into raw SQL strings.
- Include `run_results.id` in both latest and history queries and use that stable row id for `isLatest`, not `(run_id, created_at)`.

```typescript
// web/src/app/api/compare/[scenarioId]/drill-down/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/db';
import type { DrillDownResponse } from '@/lib/compare/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scenarioId: string }> },
) {
  const { scenarioId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const agentId = searchParams.get('agentId');
  const modelId = searchParams.get('modelId');

  if (!agentId || !modelId) {
    return NextResponse.json({ error: 'agentId and modelId required' }, { status: 400 });
  }

  // Fetch scenario, agent, model info
  const [scenario] = await sql`SELECT id, slug, name FROM scenarios WHERE id = ${scenarioId}`;
  const [agent] = await sql`SELECT id, name FROM agents WHERE id = ${agentId}`;
  const [model] = await sql`SELECT id, name FROM models WHERE id = ${modelId}`;

  if (!scenario || !agent || !model) {
    return NextResponse.json({ error: 'Scenario, agent, or model not found' }, { status: 404 });
  }

  // Latest non-error result
  const [latestRow] = await sql`
    SELECT id, run_id, total_score, tests_passed, tests_total,
           duration_seconds, attempt, max_attempts, status,
           agent_version, scenario_version, judge_scores,
           artifacts_s3_key, error_message, created_at
    FROM run_results
    WHERE agent_id = ${agentId}
      AND model_id = ${modelId}
      AND scenario_id = ${scenarioId}
      AND status IN ('completed', 'failed')
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const latest = latestRow ? {
    runId: latestRow.run_id,
    score: Number(latestRow.total_score),
    testsPassed: Number(latestRow.tests_passed),
    testsTotal: Number(latestRow.tests_total),
    durationSeconds: Number(latestRow.duration_seconds),
    attempt: Number(latestRow.attempt),
    maxAttempts: Number(latestRow.max_attempts),
    status: latestRow.status as 'completed' | 'failed',
    agentVersion: latestRow.agent_version,
    scenarioVersion: latestRow.scenario_version,
    judgeScores: latestRow.judge_scores as Record<string, number> | null,
    artifactsS3Key: latestRow.artifacts_s3_key,
    errorMessage: latestRow.error_message,
    createdAt: latestRow.created_at,
  } : null;

  // Full history (all statuses)
  const historyRows = await sql`
    SELECT id, run_id, total_score, tests_passed, tests_total,
           duration_seconds, status,
           agent_version, scenario_version,
           artifacts_s3_key, error_message, created_at
    FROM run_results
    WHERE agent_id = ${agentId}
      AND model_id = ${modelId}
      AND scenario_id = ${scenarioId}
    ORDER BY created_at DESC
  `;

  // Compute trend (diff vs previous non-error row)
  const history = historyRows.map((row: any, idx: number) => {
    let trend: number | null = null;
    if (row.status !== 'error') {
      // Find previous non-error row
      for (let j = idx + 1; j < historyRows.length; j++) {
        if (historyRows[j].status !== 'error') {
          trend = Number(row.total_score) - Number(historyRows[j].total_score);
          break;
        }
      }
    }

    return {
      runId: row.run_id,
      score: Number(row.total_score),
      testsPassed: Number(row.tests_passed),
      testsTotal: Number(row.tests_total),
      durationSeconds: Number(row.duration_seconds),
      status: row.status as 'completed' | 'failed' | 'error',
      agentVersion: row.agent_version,
      scenarioVersion: row.scenario_version,
      artifactsS3Key: row.artifacts_s3_key,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      trend,
      isLatest: latestRow ? row.id === latestRow.id : false,
    };
  });

  const response: DrillDownResponse = {
    scenario: { id: scenario.id, slug: scenario.slug, name: scenario.name },
    agent: { id: agent.id, name: agent.name },
    model: { id: model.id, name: model.name },
    latest,
    history,
  };

  return NextResponse.json(response);
}
```

- [ ] **Step 2: Extend API tests for drill-down**

Add to `web/src/lib/compare/__tests__/breakdown.test.ts`:

```typescript
import { GET as getDrillDown } from '@/app/api/compare/[scenarioId]/drill-down/route';

describe('GET /api/compare/[scenarioId]/drill-down', () => {
  it('returns 400 when agentId or modelId is missing', async () => {
    const request = new NextRequest('http://localhost/api/compare/scenario-1/drill-down?agentId=agent-1');
    const response = await getDrillDown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });

    expect(response.status).toBe(400);
  });

  it('marks only the latest non-error row as isLatest using run_results.id', async () => {
    sql
      .mockResolvedValueOnce([{ id: 'scenario-1', slug: 'todo-app', name: 'Todo App' }])
      .mockResolvedValueOnce([{ id: 'agent-1', name: 'Cursor' }])
      .mockResolvedValueOnce([{ id: 'model-1', name: 'GPT-4o' }])
      .mockResolvedValueOnce([
        {
          id: 'rr-2',
          run_id: 'run-2',
          total_score: 92,
          tests_passed: 18,
          tests_total: 20,
          duration_seconds: 45,
          attempt: 2,
          max_attempts: 3,
          status: 'completed',
          agent_version: 'v1',
          scenario_version: 'v2',
          judge_scores: null,
          artifacts_s3_key: null,
          error_message: null,
          created_at: '2026-03-27T12:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'rr-3',
          run_id: 'run-3',
          total_score: 0,
          tests_passed: 0,
          tests_total: 0,
          duration_seconds: 10,
          status: 'error',
          agent_version: 'v1',
          scenario_version: 'v2',
          artifacts_s3_key: null,
          error_message: 'timeout',
          created_at: '2026-03-27T12:30:00Z',
        },
        {
          id: 'rr-2',
          run_id: 'run-2',
          total_score: 92,
          tests_passed: 18,
          tests_total: 20,
          duration_seconds: 45,
          status: 'completed',
          agent_version: 'v1',
          scenario_version: 'v2',
          artifacts_s3_key: null,
          error_message: null,
          created_at: '2026-03-27T12:00:00Z',
        },
      ]);

    const request = new NextRequest('http://localhost/api/compare/scenario-1/drill-down?agentId=agent-1&modelId=model-1');
    const response = await getDrillDown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.history.find((row: any) => row.runId === 'run-2')?.isLatest).toBe(true);
    expect(body.history.find((row: any) => row.runId === 'run-3')?.isLatest).toBe(false);
  });
});
```

- [ ] **Step 3: Run drill-down API tests**

Run: `cd web && npx vitest run src/lib/compare/__tests__/breakdown.test.ts --reporter=verbose -t "drill-down"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/api/compare/[scenarioId]/drill-down/route.ts web/src/lib/compare/__tests__/breakdown.test.ts
git commit -m "feat(web): add detailed drill-down API endpoint with lineage"
```

---

## Task 8: UI — HeatmapCell + Heatmap Components

**Files:**
- Create: `web/src/components/compare/heatmap-cell.tsx`
- Create: `web/src/components/compare/heatmap.tsx`

- [ ] **Step 1: Create HeatmapCell component**

Server-side contract for this component:
- `cell.score` arrives normalized to the 0-100 range. Query/API code does the normalization; UI code treats it strictly as a percentage.

```tsx
// web/src/components/compare/heatmap-cell.tsx
'use client';

import type { HeatmapCell as HeatmapCellData } from '@/lib/compare/types';

function scoreLevel(pct: number): string {
  if (pct >= 85) return 'excellent';
  if (pct >= 70) return 'good';
  if (pct >= 50) return 'mid';
  if (pct >= 30) return 'poor';
  return 'fail';
}

interface Props {
  cell: HeatmapCellData | null;
  cellKey?: string;
  onClick?: () => void;
}

export function HeatmapCell({ cell, cellKey, onClick }: Props) {
  if (!cell) {
    return (
      <td
        data-cell={cellKey}
        className="text-center font-mono text-xs text-[var(--text-muted)] px-2 py-1.5"
      >
        —
      </td>
    );
  }

  if (cell.errorOnly) {
    return (
      <td
        data-cell={cellKey}
        className="text-center px-2 py-1.5 cursor-pointer hover:opacity-80"
        onClick={onClick}
        title={`${cell.errorCount ?? 0} attempts failed — no successful result yet`}
      >
        <span className="text-[var(--score-fail)] font-bold text-xs">✕</span>
      </td>
    );
  }

  const level = scoreLevel(cell.score);
  const text = `var(--score-${level})`;
  const bg = `var(--score-${level}-bg)`;

  const borderStyle = cell.stale
    ? '2px dashed var(--text-muted)'
    : cell.bestInRow
      ? '2px solid var(--accent)'
      : 'none';

  const title = cell.stale
    ? cell.staleCount !== undefined
      ? `${cell.staleCount} of ${cell.sourceCount} source results may be outdated`
      : 'Latest run errored; showing previous result'
    : undefined;

  return (
    <td
      data-cell={cellKey}
      className="text-center px-2 py-1.5 cursor-pointer hover:opacity-80 transition-opacity"
      style={{ backgroundColor: bg, color: text, border: borderStyle }}
      onClick={onClick}
      title={title}
    >
      <span className="font-mono text-xs font-semibold">{cell.score.toFixed(0)}%</span>
      {cell.testsPassed !== undefined && cell.testsTotal !== undefined && (
        <div className="text-[0.6rem] opacity-70">{cell.testsPassed}/{cell.testsTotal}</div>
      )}
    </td>
  );
}
```

- [ ] **Step 2: Create Heatmap component**

```tsx
// web/src/components/compare/heatmap.tsx
'use client';

import type { CompareResponse } from '@/lib/compare/types';
import { HeatmapCell } from './heatmap-cell';

interface Props {
  data: CompareResponse;
  onCellClick: (entityId: string, scenarioId: string) => void;
}

export function Heatmap({ data, onCellClick }: Props) {
  const { columns, rows, cells, totals } = data.heatmap;
  const leaderId = data.leaderboard[0]?.entityId;

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-[var(--text-muted)]">
        No results yet. Run a benchmark to see comparisons.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--bg-raised)] px-3 py-2 text-left text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {data.lens.includes('model') ? 'Model' : 'Agent'}
            </th>
            {columns.map((col) => (
              <th
                key={col.id}
                className="px-2 py-2 text-center text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider whitespace-nowrap"
              >
                {col.name}
              </th>
            ))}
            <th className="px-2 py-2 text-center text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              AVG
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={row.id}
              className={`border-b border-[var(--border)] ${row.id === leaderId ? 'bg-[var(--accent-dim)]' : ''}`}
            >
              <td className="sticky left-0 z-10 bg-[var(--bg-raised)] px-3 py-1.5 font-mono text-xs font-medium whitespace-nowrap">
                <span className="text-[var(--text-muted)] mr-1">#{idx + 1}</span>
                {row.name}
              </td>
              {columns.map((col) => (
                <HeatmapCell
                  key={col.id}
                  cell={cells[row.id]?.[col.id] ?? null}
                  cellKey={`${row.id}:${col.id}`}
                  onClick={() => onCellClick(row.id, col.id)}
                />
              ))}
              <td className="text-center px-2 py-1.5 font-mono text-xs font-bold text-[var(--text-primary)]">
                {totals[row.id]?.toFixed(0) ?? '—'}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/compare/heatmap-cell.tsx web/src/components/compare/heatmap.tsx
git commit -m "feat(web): add Heatmap components with stable drill-down anchors"
```

---

## Task 9: UI — TabBar + Leaderboard + AnchorDropdown

**Files:**
- Create: `web/src/components/compare/tab-bar.tsx`
- Create: `web/src/components/compare/leaderboard.tsx`
- Create: `web/src/components/compare/anchor-dropdown.tsx`

- [ ] **Step 1: Create TabBar component**

Navigation semantics:
- Switching to a ranking lens drops both `agentId` and `modelId`.
- Switching to `agent-x-models` preserves `agentId` if present in the URL; otherwise server canonicalization picks the first available agent.
- Switching to `model-x-agents` preserves `modelId` if present in the URL; otherwise server canonicalization picks the first available model.

```tsx
// web/src/components/compare/tab-bar.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { LensType } from '@/lib/compare/types';

const TABS: { lens: LensType; label: string; color: string }[] = [
  { lens: 'model-ranking', label: 'Model Ranking', color: 'var(--lens-ranking)' },
  { lens: 'agent-ranking', label: 'Agent Ranking', color: 'var(--lens-ranking)' },
  { lens: 'agent-x-models', label: 'Agent × Models', color: 'var(--lens-detail)' },
  { lens: 'model-x-agents', label: 'Model × Agents', color: 'var(--lens-detail)' },
];

interface Props {
  activeLens: LensType;
}

export function TabBar({ activeLens }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function buildHref(nextLens: LensType): string {
    if (nextLens === 'agent-x-models') {
      const agentId = searchParams.get('agentId');
      return agentId ? `/compare?lens=${nextLens}&agentId=${agentId}` : `/compare?lens=${nextLens}`;
    }

    if (nextLens === 'model-x-agents') {
      const modelId = searchParams.get('modelId');
      return modelId ? `/compare?lens=${nextLens}&modelId=${modelId}` : `/compare?lens=${nextLens}`;
    }

    return `/compare?lens=${nextLens}`;
  }

  return (
    <div className="flex gap-1 border-b border-[var(--border)] mb-4">
      {TABS.map((tab) => {
        const active = tab.lens === activeLens;
        return (
          <button
            key={tab.lens}
            onClick={() => router.push(buildHref(tab.lens))}
            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
              active
                ? 'border-b-2 text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
            style={active ? { borderBottomColor: tab.color, backgroundColor: `${tab.color}15` } : undefined}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create Leaderboard component**

```tsx
// web/src/components/compare/leaderboard.tsx
'use client';

import type { LeaderboardEntry } from '@/lib/compare/types';

interface Props {
  entries: LeaderboardEntry[];
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function Leaderboard({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <div className="text-sm text-[var(--text-muted)] p-4">No entries yet.</div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const medal = entry.rank <= 3 ? MEDALS[entry.rank - 1] : null;
        const isFirst = entry.rank === 1;

        return (
          <div
            key={entry.entityId}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
              isFirst ? 'bg-[var(--accent-dim)]' : 'hover:bg-[var(--bg-hover)]'
            }`}
          >
            <span className="font-mono text-xs text-[var(--text-muted)] w-6 text-right">
              {medal ?? `#${entry.rank}`}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm font-medium text-[var(--text-primary)] truncate">
                {entry.entityName}
              </div>
              <div className="text-[0.65rem] text-[var(--text-muted)]">
                {entry.scenarioCount}/{entry.totalScenarios} scenarios
                {entry.lowCoverage && (
                  <span className="ml-1 text-[var(--score-poor)]">⚠ low coverage</span>
                )}
              </div>
            </div>
            <span className="font-mono text-sm font-bold text-[var(--text-primary)]">
              {entry.avgScore.toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Create AnchorDropdown component**

```tsx
// web/src/components/compare/anchor-dropdown.tsx
'use client';

import { useRouter } from 'next/navigation';
import type { LensType } from '@/lib/compare/types';

interface Props {
  lens: LensType;
  anchors: { id: string; name: string }[];
  selectedId?: string;
}

export function AnchorDropdown({ lens, anchors, selectedId }: Props) {
  const router = useRouter();
  const paramKey = lens === 'agent-x-models' ? 'agentId' : 'modelId';
  const label = lens === 'agent-x-models' ? 'Agent' : 'Model';

  return (
    <div className="flex items-center gap-2 mb-3">
      <label className="text-xs text-[var(--text-muted)] uppercase tracking-wider">
        {label}:
      </label>
      <select
        value={selectedId ?? ''}
        onChange={(e) => router.push(`/compare?lens=${lens}&${paramKey}=${e.target.value}`)}
        className="bg-[var(--bg-raised)] border border-[var(--border)] rounded px-2 py-1 text-sm font-mono text-[var(--text-primary)]"
      >
        {anchors.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/components/compare/tab-bar.tsx web/src/components/compare/leaderboard.tsx web/src/components/compare/anchor-dropdown.tsx
git commit -m "feat(web): add TabBar, Leaderboard, and AnchorDropdown compare components"
```

---

## Task 10: UI — DrillDownPanel + BreakdownPopover

**Files:**
- Create: `web/src/components/compare/drill-down-panel.tsx`
- Create: `web/src/components/compare/breakdown-popover.tsx`

- [ ] **Step 1: Create DrillDownPanel (slide-over for detailed lenses)**

Accessibility baseline:
- `DrillDownPanel` uses `role="dialog"` and `aria-modal="true"`.
- Initial focus moves to the close button when the panel opens.
- `BreakdownPopover` closes on Escape as well as outside click.
- `BreakdownPopover` is intentionally non-modal (`aria-modal="false"`) and does not trap focus.

```tsx
// web/src/components/compare/drill-down-panel.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import type { DrillDownResponse } from '@/lib/compare/types';

interface Props {
  scenarioId: string;
  agentId: string;
  modelId: string;
  onClose: () => void;
}

export function DrillDownPanel({ scenarioId, agentId, modelId, onClose }: Props) {
  const [data, setData] = useState<DrillDownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/compare/${scenarioId}/drill-down?agentId=${agentId}&modelId=${modelId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scenarioId, agentId, modelId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-drilldown-title"
        className="fixed right-0 top-0 bottom-0 w-[480px] max-w-full bg-[var(--bg-overlay)] border-l border-[var(--border)] z-50 overflow-y-auto shadow-xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h3 id="compare-drilldown-title" className="font-mono text-sm font-semibold text-[var(--text-primary)]">
            {data ? `${data.scenario.name}` : 'Loading...'}
          </h3>
          <button ref={closeButtonRef} onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg">
            ✕
          </button>
        </div>

        <div className="p-4">
          {loading && <div className="text-sm text-[var(--text-muted)]">Loading...</div>}
          {error && (
            <div className="text-sm text-[var(--score-fail)]">
              Failed to load details: {error}
            </div>
          )}
          {data && (
            <div className="space-y-4">
              {/* Latest result */}
              <div>
                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  {data.agent.name} × {data.model.name}
                </div>
                {data.latest ? (
                  <div className="bg-[var(--bg-raised)] rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-2xl font-bold text-[var(--text-primary)]">
                        {data.latest.score.toFixed(0)}%
                      </span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                        data.latest.status === 'completed'
                          ? 'bg-[var(--score-excellent-bg)] text-[var(--score-excellent)]'
                          : 'bg-[var(--score-fail-bg)] text-[var(--score-fail)]'
                      }`}>
                        {data.latest.status}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      Tests: {data.latest.testsPassed}/{data.latest.testsTotal} |
                      Attempt {data.latest.attempt}/{data.latest.maxAttempts} |
                      {data.latest.durationSeconds}s
                    </div>
                    {data.latest.agentVersion && (
                      <div className="text-xs text-[var(--text-muted)]">
                        Agent: {data.latest.agentVersion}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-[var(--score-fail)]">
                    No successful result — all attempts errored.
                  </div>
                )}
              </div>

              {/* History */}
              <div>
                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  Run History
                </div>
                <div className="space-y-1">
                  {data.history.map((h, i) => (
                    <div
                      key={`${h.runId}-${i}`}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                        h.isLatest ? 'bg-[var(--accent-dim)]' : ''
                      }`}
                    >
                      <span className={`w-14 font-mono font-semibold ${
                        h.status === 'error' ? 'text-[var(--score-fail)]' :
                        h.status === 'completed' ? 'text-[var(--score-excellent)]' :
                        'text-[var(--score-poor)]'
                      }`}>
                        {h.status === 'error' ? 'ERROR' : `${h.score.toFixed(0)}%`}
                      </span>
                      <span className="text-[var(--text-muted)] flex-1 truncate">
                        {h.status === 'error' ? h.errorMessage : `${h.testsPassed}/${h.testsTotal} tests`}
                      </span>
                      {h.trend !== null && h.trend !== 0 && (
                        <span className={`font-mono text-[0.65rem] ${h.trend > 0 ? 'text-[var(--score-excellent)]' : 'text-[var(--score-fail)]'}`}>
                          {h.trend > 0 ? '+' : ''}{h.trend.toFixed(0)}%
                        </span>
                      )}
                      {h.isLatest && (
                        <span className="text-[0.6rem] text-[var(--accent)] font-semibold">CURRENT</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Create BreakdownPopover (for aggregated lenses)**

```tsx
// web/src/components/compare/breakdown-popover.tsx
'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { BreakdownResponse, LensType } from '@/lib/compare/types';

interface Props {
  scenarioId: string;
  entityId: string;
  lens: LensType;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

export function BreakdownPopover({ scenarioId, entityId, lens, anchorEl, onClose }: Props) {
  const [data, setData] = useState<BreakdownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const paramKey = lens === 'model-ranking' ? 'modelId' : 'agentId';

  useEffect(() => {
    setLoading(true);
    fetch(`/api/compare/${scenarioId}/breakdown?${paramKey}=${entityId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scenarioId, entityId, paramKey]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Position near anchor
  const rect = anchorEl?.getBoundingClientRect();
  const width = 288;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const style = rect
    ? {
        top: Math.min(viewportHeight - 16, rect.bottom + 4),
        left: Math.min(Math.max(8, rect.left - 100), viewportWidth - width - 8),
        position: 'fixed' as const,
      }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', position: 'fixed' as const };

  const navigateLens = lens === 'model-ranking' ? 'agent-x-models' : 'model-x-agents';
  const navigateParam = lens === 'model-ranking' ? 'agentId' : 'modelId';

  return (
    <div
      role="dialog"
      aria-modal="false"
      ref={ref}
      className="z-50 bg-[var(--bg-overlay)] border border-[var(--border)] rounded-lg shadow-xl p-3 w-72"
      style={style}
    >
      {loading && <div className="text-xs text-[var(--text-muted)]">Loading...</div>}
      {error && <div className="text-xs text-[var(--score-fail)]">Failed: {error}</div>}
      {data && (
        <>
          <div className="text-xs text-[var(--text-muted)] mb-2">
            {data.entity.name} on {data.scenario.name}
            {data.avgScore !== null && (
              <span className="float-right font-mono font-bold text-[var(--text-primary)]">
                avg {data.avgScore.toFixed(0)}%
              </span>
            )}
          </div>
          <div className="space-y-1">
            {data.breakdown.map((b) => (
              <button
                key={b.counterpartId}
                onClick={() => router.push(`/compare?lens=${navigateLens}&${navigateParam}=${b.counterpartId}`)}
                className="flex items-center justify-between w-full px-2 py-1 rounded text-xs hover:bg-[var(--bg-hover)] transition-colors"
              >
                <span className="text-[var(--text-primary)]">{b.counterpartName}</span>
                <span className="font-mono font-semibold">
                  {b.score.toFixed(0)}%
                  {b.stale && <span className="ml-1 text-[var(--text-muted)]">⚠</span>}
                </span>
              </button>
            ))}
            {data.errorOnlyCounterparts.map((e) => (
              <div
                key={e.counterpartId}
                className="flex items-center justify-between px-2 py-1 text-xs"
              >
                <span className="text-[var(--text-muted)]">{e.counterpartName}</span>
                <span className="text-[var(--score-fail)] font-mono">✕ {e.errorCount} errors</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/compare/drill-down-panel.tsx web/src/components/compare/breakdown-popover.tsx
git commit -m "feat(web): add DrillDownPanel and BreakdownPopover compare components"
```

---

## Task 11: UI — CompareView + Page + Loading/Error

**Files:**
- Create: `web/src/app/compare/compare-view.tsx`
- Modify: `web/src/app/compare/page.tsx`
- Create: `web/src/app/compare/loading.tsx`
- Create: `web/src/app/compare/error.tsx`

- [ ] **Step 1: Create CompareView client component**

```tsx
// web/src/app/compare/compare-view.tsx
'use client';

import { useState, useCallback } from 'react';
import type { CompareResponse } from '@/lib/compare/types';
import { TabBar } from '@/components/compare/tab-bar';
import { Leaderboard } from '@/components/compare/leaderboard';
import { Heatmap } from '@/components/compare/heatmap';
import { AnchorDropdown } from '@/components/compare/anchor-dropdown';
import { DrillDownPanel } from '@/components/compare/drill-down-panel';
import { BreakdownPopover } from '@/components/compare/breakdown-popover';

interface Props {
  data: CompareResponse;
}

interface DrillDownState {
  scenarioId: string;
  agentId: string;
  modelId: string;
}

interface BreakdownState {
  scenarioId: string;
  entityId: string;
  anchorEl: HTMLElement | null;
}

export function CompareView({ data }: Props) {
  const [drillDown, setDrillDown] = useState<DrillDownState | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownState | null>(null);

  const isDetailedLens = data.lens === 'agent-x-models' || data.lens === 'model-x-agents';

  const handleCellClick = useCallback(
    (entityId: string, scenarioId: string) => {
      if (isDetailedLens) {
        // Detailed lens: open drill-down slide-over
        const agentId = data.lens === 'agent-x-models' ? data.anchor!.id : entityId;
        const modelId = data.lens === 'model-x-agents' ? data.anchor!.id : entityId;
        setDrillDown({ scenarioId, agentId, modelId });
      } else {
        // Aggregated lens: show breakdown popover
        // Get the clicked TD element for positioning
        const target = document.querySelector(`[data-cell="${entityId}:${scenarioId}"]`) as HTMLElement;
        setBreakdown({ scenarioId, entityId, anchorEl: target });
      }
    },
    [data.lens, data.anchor, isDetailedLens],
  );

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-lg text-[var(--text-primary)]">Compare</h1>

      <TabBar activeLens={data.lens} />

      {isDetailedLens && data.availableAnchors && (
        <AnchorDropdown
          lens={data.lens}
          anchors={data.availableAnchors}
          selectedId={data.anchor?.id}
        />
      )}

      <div className="flex gap-4">
        {/* Leaderboard (fixed width) */}
        <div className="w-[280px] flex-shrink-0 bg-[var(--bg-raised)] rounded-lg border border-[var(--border)] p-2 overflow-y-auto max-h-[70vh]">
          <Leaderboard entries={data.leaderboard} />
        </div>

        {/* Heatmap (flexible) */}
        <div className="flex-1 bg-[var(--bg-raised)] rounded-lg border border-[var(--border)] p-2 overflow-hidden">
          <Heatmap data={data} onCellClick={handleCellClick} />
        </div>
      </div>

      {/* Drill-down panel (detailed lenses) */}
      {drillDown && (
        <DrillDownPanel
          scenarioId={drillDown.scenarioId}
          agentId={drillDown.agentId}
          modelId={drillDown.modelId}
          onClose={() => setDrillDown(null)}
        />
      )}

      {/* Breakdown popover (aggregated lenses) */}
      {breakdown && (
        <BreakdownPopover
          scenarioId={breakdown.scenarioId}
          entityId={breakdown.entityId}
          lens={data.lens}
          anchorEl={breakdown.anchorEl}
          onClose={() => setBreakdown(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace compare page.tsx with server component**

```tsx
// web/src/app/compare/page.tsx
import { redirect } from 'next/navigation';
import { fetchCompareData } from '@/lib/compare/queries';
import { CompareView } from './compare-view';
import type { LensType } from '@/lib/compare/types';

export const dynamic = 'force-dynamic';

const VALID_LENSES: LensType[] = ['model-ranking', 'agent-ranking', 'agent-x-models', 'model-x-agents'];

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lensParam = typeof params.lens === 'string' ? params.lens : undefined;
  const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;
  const modelId = typeof params.modelId === 'string' ? params.modelId : undefined;

  // Validate lens
  const lens: LensType = VALID_LENSES.includes(lensParam as LensType)
    ? (lensParam as LensType)
    : 'model-ranking';

  if (lensParam !== lens) {
    redirect(`/compare?lens=${lens}`);
  }

  // Canonical rule: keep only the anchor param compatible with the active lens.
  // If both agentId and modelId are present, the active lens wins and the incompatible param is dropped.
  const normalizedAgentId = lens === 'agent-x-models' ? agentId : undefined;
  const normalizedModelId = lens === 'model-x-agents' ? modelId : undefined;

  const data = await fetchCompareData({
    lens,
    agentId: normalizedAgentId,
    modelId: normalizedModelId,
  });

  // Canonicalize URL if needed
  const cp = data.canonicalParams;
  // Compare against the raw incoming params so canonical redirects also strip incompatible
  // or leftover query params like `?lens=model-ranking&agentId=...`.
  const currentUrl = buildUrl(lens, agentId, modelId);
  const canonicalUrl = buildUrl(cp.lens as LensType, cp.agentId, cp.modelId);
  if (currentUrl !== canonicalUrl) {
    redirect(canonicalUrl);
  }

  return <CompareView data={data} />;
}

function buildUrl(lens: string, agentId?: string, modelId?: string): string {
  const parts = [`/compare?lens=${lens}`];
  if (agentId) parts.push(`agentId=${agentId}`);
  if (modelId) parts.push(`modelId=${modelId}`);
  return parts.join('&');
}
```

- [ ] **Step 3: Create loading.tsx**

```tsx
// web/src/app/compare/loading.tsx
export default function CompareLoading() {
  return (
    <div className="space-y-4">
      <div className="h-6 w-32 bg-[var(--bg-raised)] rounded animate-pulse" />
      <div className="flex gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 w-28 bg-[var(--bg-raised)] rounded animate-pulse" />
        ))}
      </div>
      <div className="flex gap-4">
        <div className="w-[280px] h-[400px] bg-[var(--bg-raised)] rounded-lg animate-pulse" />
        <div className="flex-1 h-[400px] bg-[var(--bg-raised)] rounded-lg animate-pulse" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create error.tsx**

```tsx
// web/src/app/compare/error.tsx
'use client';

export default function CompareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <p className="text-sm text-[var(--score-fail)]">
        Failed to load compare data: {error.message}
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 text-sm font-semibold bg-[var(--bg-raised)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
      >
        Retry
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Run build check**

Run: `cd web && npx next build`
Expected: build succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/compare/compare-view.tsx web/src/app/compare/page.tsx web/src/app/compare/loading.tsx web/src/app/compare/error.tsx
git commit -m "feat(web): implement Compare Screen with tabs, heatmap, leaderboard, drill-down"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ 1.1 Matview refresh after run + startup → Task 4 (steps 5-6)
- ✅ 1.2 Aggregation formula fix → Task 3
- ✅ 1.3 Partial composite index → Task 2
- ✅ 1.4 Error rows in run_results → Task 4 (steps 3-4)
- ✅ 1.5 Staleness detection → Task 5 (queries.ts staleRows)
- ✅ 1.6 Error-only combinations → Task 5 (errorOnlyRows), Task 8 (HeatmapCell `✕`)
- ✅ 2.1 SSR data fetch → Task 5 + Task 11 (page.tsx)
- ✅ 2.2a Breakdown API → Task 6
- ✅ 2.2b Drill-down API → Task 7
- ✅ 3.1 Page architecture → Task 11
- ✅ 3.2 New files → all mapped in File Map
- ✅ 3.2b Modified files → Tasks 3, 4
- ✅ 3.3 Color scale → Task 8 (scoreLevel function uses design system vars)
- ✅ 3.4 Design system → all components use CSS vars
- ✅ 3.5 Drill-down panel → Task 10
- ✅ 3.6 Breakdown popover → Task 10
- ✅ 4.1 URL canonicalization → Task 11 (page.tsx redirect logic)
- ✅ 4.2 Empty states → Task 8 (Heatmap empty), Task 9 (Leaderboard empty)
- ✅ 4.3 Loading → Task 11 (loading.tsx)
- ✅ 4.4 Error handling → Task 11 (error.tsx), Task 10 (inline errors)

**2. Placeholder scan:** No TBDs, TODOs, or "fill in later". Any intentionally schematic SQL blocks are explicitly marked as schematic and paired with non-optional implementation constraints.

**3. Type consistency:**
- `CompareResponse`, `HeatmapCell`, `LensType` — used consistently across types.ts, queries.ts, components
- `BreakdownResponse` — matches between types.ts and breakdown/route.ts
- `DrillDownResponse` — matches between types.ts and drill-down/route.ts
- `fetchCompareData` — consistent signature between queries.ts and page.tsx
- `refreshMatviews` — shared helper in `web/src/lib/db/refresh-matviews.ts`, imported by both scheduler and startup

**4. Risk review before execution:**
- Request-derived SQL values use tagged-template parameters; raw SQL is limited to trusted fixed identifiers or fixed view names.
- `refreshMatviews()` documents the raw-client invariant and the fallback path when `CONCURRENTLY` is unavailable right after matview recreation.
- Breakdown and drill-down both have explicit API test tasks, not just query-layer tests.
- Tab switching semantics for anchor query params are documented before implementation.
- Floating surfaces meet the minimum a11y bar: dialog roles, modal semantics where appropriate, Escape close.

# Compare Screen — Phase 3 Design Spec

> **Status:** In Review — 2026-03-27 (v2, post code-review)

## Overrides from UX Spec

This spec supersedes the UX spec (`2026-03-26-ux-redesign-design.md`) for the Compare Screen in these areas:

| UX spec says | This spec says | Rationale |
|--------------|----------------|-----------|
| 2×2 Lens Picker grid (card-based navigation) | TabBar with 4 tabs (URL-driven) | Tabs are simpler, keep all lenses one click away without a separate picker screen |
| Detailed lenses have no leaderboard | All lenses use Tabs + Split Panel (leaderboard + heatmap) | Consistent layout; leaderboard doubles as visual ranking even for detailed view |
| Detailed view has "Winner callout" at bottom | Winner callout included in leaderboard (top entry gets 🥇 medal + highlighted row) | With leaderboard always visible, a separate callout is redundant — the top-ranked entry already serves this purpose |
| Radar / Table view toggle | Heatmap only | YAGNI — radar and table can be added later without architectural changes |

All other UX spec requirements carry forward unchanged.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Aggregation base | Materialized views (`latest_results`, `score_by_model`, `score_by_agent`) | Already exist; single source of truth; refreshed after each run |
| Aggregation formula | Two-step: AVG per (entity, scenario), then AVG across scenarios | Equal weight per scenario regardless of counterpart count (per UX spec) |
| Heatmap cell (aggregated) | AVG across hidden dimension | model-ranking: cell = AVG of model×scenario across all agents |
| API shape | SSR via server component (`page.tsx` → `queries.ts`) + drill-down API endpoints | No public `/api/compare`; data fetched during SSR; drill-down lazy via client-side fetch |
| Layout | Tabs + Split Panel (variant A) | Dense, wide-screen friendly |
| Drill-down (aggregated) | Shows per-counterpart breakdown, not single run | Aggregated cell has no single (agent, model, scenario) key |
| Drill-down (detailed) | Full: scores + lineage slide-over | Direct key available; spec-complete |
| URL state | Server component `searchParams` + canonical redirects | Shareable; SSR-friendly; no hidden state |

## 1. Data Layer

### 1.1 Materialized Views (existing)

Located in `web/src/db/migrate-views.ts`.

**Refresh trigger (new work required):** Currently, no code refreshes matviews at runtime. Two refresh points are needed:

**1. After run completion** — in `scheduler.execute()`, after updating `runs.status` to `completed`/`cancelled`:

```typescript
// Uses the raw postgres client (exported as `sql` from '@/db') — NOT the drizzle `sql` tag.
// import { sql as rawSql } from '@/db';
await rawSql`REFRESH MATERIALIZED VIEW CONCURRENTLY latest_results`;
await rawSql`REFRESH MATERIALIZED VIEW CONCURRENTLY score_by_model`;
await rawSql`REFRESH MATERIALIZED VIEW CONCURRENTLY score_by_agent`;
```

**2. On application startup** — in `startup.ts`, two steps:

a) **Synthesize `run_results` error rows** for stale `runTasks`. Currently `startup.ts` marks stale running tasks as `error` in `runTasks` only. It must also insert a corresponding `run_results` row with `status = 'error'` for each task (using `runTasks.runId`, `agentId`, `modelId`, `scenarioId` from the task metadata). Use `ON CONFLICT (run_id, agent_id, model_id, scenario_id) DO NOTHING` for idempotency — the error row may already have been inserted before the crash. Without this, crash-killed tasks would be invisible to staleness detection and drill-down lineage.

b) **Refresh all matviews** unconditionally after step (a). This covers both the synthesized error rows and any `run_results` rows that were inserted before the crash but never refreshed.

**Consistency guarantee:** Eventual consistency. Between a `run_results` insert and the next refresh (either post-run or startup), compare data may lag. This is acceptable: compare operates on completed runs, not live data, and users don't expect real-time updates. The startup refresh bounds staleness to at most one process lifetime.

Use `CONCURRENTLY` to avoid locking reads during refresh. This requires the unique indexes that already exist on each view.

**`latest_results`** — one row per `(agent_id, model_id, scenario_id)` with latest non-error result:

```sql
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

-- Unique index covers DISTINCT ON and subsequent lookups
CREATE UNIQUE INDEX idx_latest_results_pk
    ON latest_results(agent_id, model_id, scenario_id);
```

**`score_by_model`** and **`score_by_agent`** — aggregated leaderboards derived from `latest_results`. These exist but need formula correction (see 1.2).

### 1.2 Aggregation Formula Fix

**Problem:** Current materialized views use `AVG(total_score)` directly from `latest_results`, which gives more weight to scenarios with more counterparts.

**Correct formula (per UX spec):**

> "For each model × scenario, average the score across all agents that tested that combination. Per-model total = average across all scenarios."

Two-step aggregation:

```sql
-- Step 1: Per (model, scenario), average across all agents
-- Step 2: Per model, average across scenarios (equal weight per scenario)

CREATE MATERIALIZED VIEW score_by_model AS
WITH per_scenario AS (
    SELECT model_id, scenario_id,
           AVG(total_score) AS scenario_avg,
           COUNT(DISTINCT agent_id) AS agent_count
    FROM latest_results
    GROUP BY model_id, scenario_id
)
SELECT
    model_id,
    AVG(scenario_avg) AS avg_score,              -- equal weight per scenario
    COUNT(DISTINCT scenario_id) AS scenario_count,
    SUM(agent_count) AS total_pairs,             -- total (agent,scenario) pairs
    (SELECT COUNT(DISTINCT agent_id) FROM latest_results WHERE latest_results.model_id = per_scenario.model_id) AS counterpart_count
FROM per_scenario
GROUP BY model_id;
```

Analogous for `score_by_agent` (swap model↔agent).

**Migration:** Update `migrate-views.ts` with corrected SQL. Note: there is currently no runtime refresh logic anywhere in the codebase — adding it is new work described in section 1.1.

### 1.3 New Index for `run_results`

The `DISTINCT ON` in `latest_results` needs a composite index for efficient execution:

```sql
CREATE INDEX idx_run_results_latest_wins
    ON run_results(agent_id, model_id, scenario_id, created_at DESC)
    WHERE status IN ('completed', 'failed');
```

Add this as a Drizzle migration. The existing `idx_run_results_agent_model` and `idx_run_results_scenario` remain for other query patterns.

### 1.4 Error Rows in `run_results` (new work)

**Problem:** The scheduler's error paths (`persistTaskError()`) currently update only `run_tasks`. The `run_results` table — and therefore staleness detection — never sees `status = 'error'` rows.

**Required changes in `scheduler.ts`:**

1. **`persistTaskError()`** must ALSO insert a `run_results` row with `status = 'error'`, `total_score = 0`, `tests_passed = 0`, `tests_total = 0`, and `error_message` populated.

2. **`executeLane()` top-level catch** (line ~153) currently only increments `results.error` for remaining scenarios without persisting anything. It must call `persistTaskError()` for each remaining scenario's task, so that lane-level failures (container bootstrap, network errors) also produce `run_results` error rows visible to staleness and lineage.

3. **All error-row inserts** (in `persistTaskError()`, `startup.ts`, and `executeLane()` catch) must use `ON CONFLICT (run_id, agent_id, model_id, scenario_id) DO NOTHING`. This makes inserts idempotent — if the process crashes between inserting `run_results` and updating `run_tasks`, the startup recovery won't fail on the unique constraint.

This ensures:
- `latest_results` matview correctly skips error rows (its `WHERE` filters to `completed|failed`)
- Staleness detection (1.5) can find newer error rows
- Drill-down lineage shows complete history including failures
- Lane-level infra failures are visible, not just per-scenario errors
- Crash recovery is idempotent

The `run_results` schema already supports `status = 'error'` and `error_message` columns.

### 1.5 Staleness Detection

**Problem:** If the most recent `run_results` row for a combo has `status = 'error'`, `latest_results` shows an older `completed`/`failed` row without indicating it may be stale.

**Prerequisite:** Section 1.4 — error rows must exist in `run_results` for this to work.

**Solution:** Server-side query includes a `stale` flag per cell. Computed by checking if any `run_results` row with `status = 'error'` has `created_at` newer than the `latest_results` row for that combo.

```sql
-- Used by /api/compare to detect stale cells
SELECT lr.agent_id, lr.model_id, lr.scenario_id,
       EXISTS (
           SELECT 1 FROM run_results rr
           WHERE rr.agent_id = lr.agent_id
             AND rr.model_id = lr.model_id
             AND rr.scenario_id = lr.scenario_id
             AND rr.status = 'error'
             AND rr.created_at > lr.created_at
       ) AS stale
FROM latest_results lr;
```

**Staleness semantics by lens type:**

- **Detailed lenses** (`agent-x-models`, `model-x-agents`): cell maps to one `latest_results` row. `stale = true` if any `run_results` row with `status = 'error'` has `created_at` newer than that row.
- **Aggregated lenses** (`model-ranking`, `agent-ranking`): cell aggregates multiple `latest_results` rows across hidden counterparts. `stale = true` if **any** underlying row is stale (OR semantics). Tooltip specifies: "N of M source results may be outdated".

Stale cells get a dashed border + tooltip.

### 1.6 Error-Only Combinations

**Problem:** If a `(agent, model, scenario)` combo has only `run_results` rows with `status = 'error'` and zero `completed`/`failed` rows, it won't appear in `latest_results` at all. Without special handling, the heatmap shows `—` (no data) — indistinguishable from "never tested".

**Solution:** A supplementary query detects error-only combos:

```sql
-- Combos that were attempted but have no non-error result
SELECT DISTINCT rr.agent_id, rr.model_id, rr.scenario_id,
       MAX(rr.created_at) AS last_error_at,
       COUNT(*) AS error_count
FROM run_results rr
WHERE rr.status = 'error'
  AND NOT EXISTS (
      SELECT 1 FROM latest_results lr
      WHERE lr.agent_id = rr.agent_id
        AND lr.model_id = rr.model_id
        AND lr.scenario_id = rr.scenario_id
  )
GROUP BY rr.agent_id, rr.model_id, rr.scenario_id;
```

**UI representation:** These cells get a distinct `error-only` state — red `✕` icon with tooltip "N attempts failed — no successful result yet". Clickable: opens the same drill-down/breakdown flow, but `latest` is null and `history` contains only error rows.

**Impact on aggregated lenses:** For ranking heatmap cells, error-only counterparts are excluded from the AVG (they have no score). The cell's `counterpartCount` reflects only counterparts with actual scores. If ALL counterparts for a cell are error-only, the entire cell shows `error-only` state.

## 2. Data Access + API

### 2.1 Main Compare Data (server-side, no API route)

The server component `page.tsx` queries matviews directly via `web/src/lib/compare/queries.ts`. No public `/api/compare` route — the data is fetched during SSR and passed as props to the client component.

**Caching:** Direct DB queries are NOT covered by Next.js built-in `fetch` caching. The page uses `export const dynamic = 'force-dynamic'` (same pattern as the dashboard `page.tsx`) to ensure fresh data on every request. Matview reads are cheap enough that per-request DB access is acceptable. If needed later, `unstable_cache` or manual memoization can be added.

**Input: `searchParams` from URL** (validated + canonicalized by `page.tsx`):

| Param | Required | Values | Default |
|-------|----------|--------|---------|
| `lens` | no | `model-ranking`, `agent-ranking`, `agent-x-models`, `model-x-agents` | `model-ranking` |
| `agentId` | for `agent-x-models` | UUID | canonicalized (see 4.1) |
| `modelId` | for `model-x-agents` | UUID | canonicalized (see 4.1) |

**Lens → data source mapping:**

| Lens | Leaderboard source | Heatmap cell value | Hidden dimension |
|------|-------------------|-------------------|-----------------|
| `model-ranking` | `score_by_model` matview | AVG(total_score) for (model, scenario) across all agents | agents |
| `agent-ranking` | `score_by_agent` matview | AVG(total_score) for (agent, scenario) across all models | models |
| `agent-x-models` | computed from `latest_results WHERE agent_id = :agentId` | direct total_score (single row) | none |
| `model-x-agents` | computed from `latest_results WHERE model_id = :modelId` | direct total_score (single row) | none |

**Response shape:**

```typescript
interface CompareResponse {
  lens: string;
  anchor?: { id: string; name: string };
  availableAnchors?: { id: string; name: string }[];
  /** Canonical URL for this view — client redirects here if current URL differs */
  canonicalParams: { lens: string; agentId?: string; modelId?: string };

  leaderboard: {
    rank: number;
    entityId: string;
    entityName: string;
    avgScore: number;
    scenarioCount: number;
    totalScenarios: number;
    counterpartCount: number;
    lowCoverage: boolean;        // true if counterpartCount <= 1
  }[];

  heatmap: {
    columns: { id: string; name: string }[];
    rows: { id: string; slug: string; name: string }[];
    cells: Record<string, Record<string, HeatmapCell | null>>;
    totals: Record<string, number>;
  };
}

/**
 * HeatmapCell — null in the cells Record means "never tested" (—).
 * errorOnly=true means "tested but all attempts failed infra-level" (✕).
 * Otherwise: has a score from at least one completed/failed run.
 */
interface HeatmapCell {
  score: number;                 // 0 when errorOnly=true
  bestInRow: boolean;
  stale: boolean;                // true if latest run was error (see 1.5)
  errorOnly: boolean;            // true if no completed/failed results exist (see 1.6)
  errorCount?: number;           // number of error-only attempts (present when errorOnly=true)
  /** Present only for detailed lenses (single latest_results row) */
  testsPassed?: number;
  testsTotal?: number;
  status?: 'completed' | 'failed';
  /** Present only for aggregated lenses */
  counterpartCount?: number;     // how many agents/models were averaged (excludes error-only counterparts)
  /** Aggregated staleness detail — enables tooltip "N of M source results may be outdated" */
  staleCount?: number;           // how many underlying rows are stale (0 when stale=false)
  sourceCount?: number;          // total underlying rows (= counterpartCount, present for explicitness)
}
```

**Key difference between lens types:**

- **Aggregated** (`model-ranking`, `agent-ranking`): cell `score` is AVG across hidden dimension. `testsPassed`/`testsTotal` omitted (meaningless when averaged). `counterpartCount` tells how many were in the average.
- **Detailed** (`agent-x-models`, `model-x-agents`): cell maps 1:1 to a `latest_results` row. `testsPassed`/`testsTotal`/`status` are present.

### 2.2 Drill-Down

Drill-down differs by lens type because aggregated cells have no single `(agent, model, scenario)` key.

#### 2.2a Aggregated Drill-Down: `GET /api/compare/[scenarioId]/breakdown`

For `model-ranking` and `agent-ranking` lenses. Shows per-counterpart scores for one (entity, scenario) pair.

**Query parameters:**

| Param | Required | Notes |
|-------|----------|-------|
| `modelId` | for `model-ranking` | The entity column |
| `agentId` | for `agent-ranking` | The entity column |

**Response:**

```typescript
interface BreakdownResponse {
  scenario: { id: string; slug: string; name: string };
  entity: { id: string; name: string; type: 'model' | 'agent' };
  /** AVG across scored counterparts only. null when ALL counterparts are error-only. */
  avgScore: number | null;

  /** Per-counterpart rows from latest_results (scored counterparts) */
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

  /**
   * Counterparts that have ONLY error rows in run_results (no completed/failed).
   * Present when at least one counterpart is error-only.
   * UI shows these as red "✕" rows below the scored breakdown.
   */
  errorOnlyCounterparts: {
    counterpartId: string;
    counterpartName: string;
    errorCount: number;
    lastErrorAt: string;
    /** Latest error message (from most recent error row) */
    lastErrorMessage: string | null;
  }[];
}
```

**Behavior by cell state:**

- **Cell has scored counterparts:** `avgScore` is computed, `breakdown` is non-empty. `errorOnlyCounterparts` may also be non-empty if some counterparts errored.
- **Cell is fully error-only (all counterparts errored):** `avgScore` is `null`, `breakdown` is empty, `errorOnlyCounterparts` lists all counterparts with error details. UI shows error lineage instead of scores.

UI: popover or expandable row showing "Claude 4 on todo-app: Cursor=95%, Aider=89%, avg=92%".

#### 2.2b Detailed Drill-Down: `GET /api/compare/[scenarioId]/drill-down`

For `agent-x-models` and `model-x-agents` lenses. Full lineage for one exact `(agent, model, scenario)` triple.

**Query parameters:**

| Param | Required |
|-------|----------|
| `agentId` | yes (UUID) |
| `modelId` | yes (UUID) |

**Response:**

```typescript
interface DrillDownResponse {
  scenario: { id: string; slug: string; name: string };
  agent: { id: string; name: string };
  model: { id: string; name: string };

  /**
   * The latest non-error result, or null if all runs errored (error-only combo).
   * Queried from `run_results` directly (NOT from `latest_results` matview)
   * because the matview doesn't include `attempt`, `max_attempts`, or
   * `error_message`. Uses same DISTINCT ON logic as the matview.
   */
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

  /**
   * ALL run_results for this (agent, model, scenario) triple, sorted by created_at DESC.
   * Includes 'error' rows so the lineage panel can show infra failures and explain staleness.
   * For 'error' rows: score/testsPassed/testsTotal are 0, errorMessage is populated.
   */
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
    trend: number | null;       // score diff vs previous non-error row, null if no prior
    isLatest: boolean;          // true for the row used by latest_results matview
  }[];
}
```

## 3. UI Components

### 3.1 Page Architecture (Server/Client Split)

```
web/src/app/compare/page.tsx          — Server Component (async)
  ├── reads searchParams (Promise<...>)
  ├── validates lens, canonicalizes URL via redirect()
  ├── fetches data server-side (direct DB/matview query, no API call)
  └── renders:
      └── CompareView (client component, 'use client')
          ├── TabBar
          ├── AnchorDropdown (detailed lenses only)
          ├── SplitPanel
          │   ├── Leaderboard
          │   └── Heatmap
          │       └── HeatmapCell × N
          └── DrillDownPanel (lazy, client-side fetch)
```

**Why this split:**
- `page.tsx` is a Server Component: reads `searchParams` using the Promise-based contract already used in this repo, validates, redirects if needed, fetches data server-side — no waterfall.
- `CompareView` is a Client Component: handles tab clicks (router.push), drill-down state, animations.
- Drill-down panel fetches data client-side on cell click (lazy).

### 3.2 New Files

| File | Purpose |
|------|---------|
| `web/src/app/compare/page.tsx` | Server component; replace stub; validate params + fetch |
| `web/src/app/compare/compare-view.tsx` | Client component; tabs, split panel, drill-down state |
| `web/src/app/compare/loading.tsx` | Skeleton loader for Suspense boundary on tab/anchor switch |
| `web/src/app/compare/error.tsx` | Error boundary with retry button |
| `web/src/app/api/compare/[scenarioId]/breakdown/route.ts` | Aggregated drill-down API |
| `web/src/app/api/compare/[scenarioId]/drill-down/route.ts` | Detailed drill-down API |
| `web/src/components/compare/tab-bar.tsx` | 4 lens tabs, URL-driven |
| `web/src/components/compare/leaderboard.tsx` | Ranked list with medals |
| `web/src/components/compare/heatmap.tsx` | Scenario × entity grid |
| `web/src/components/compare/heatmap-cell.tsx` | Single cell, color-coded |
| `web/src/components/compare/drill-down-panel.tsx` | Slide-over with scores + lineage (detailed lenses) |
| `web/src/components/compare/breakdown-popover.tsx` | Per-counterpart breakdown (aggregated lenses) |
| `web/src/components/compare/anchor-dropdown.tsx` | Entity selector for detailed lenses |
| `web/src/lib/compare/queries.ts` | Server-side query functions against matviews |

### 3.2b Modified Files (orchestration + DB lifecycle)

These existing files require changes as part of Phase 3 — not just UI/API work:

| File | Change | Section |
|------|--------|---------|
| `web/src/lib/orchestrator/scheduler.ts` | Insert `run_results(status='error')` in `persistTaskError()` + `executeLane()` catch + matview refresh after run completion | 1.1, 1.4 |
| `web/src/lib/orchestrator/startup.ts` | Synthesize `run_results` error rows (with `ON CONFLICT DO NOTHING`) for crash-killed tasks + matview refresh on startup | 1.1 |
| `web/src/db/migrate-views.ts` | Update `score_by_model`/`score_by_agent` with two-step aggregation formula | 1.2 |
| `web/drizzle/0003_*.sql` (new migration) | Add `idx_run_results_latest_wins` composite partial index | 1.3 |

### 3.3 Color Scale (Heatmap Cells)

Uses the Lab Instrument Design System's 5-point continuous score scale (see `docs/superpowers/specs/design-system/` and `globals.css`). `total_score` is always 0–100%.

| Level | Range | Text var | BG var |
|-------|-------|----------|--------|
| Excellent | 85–100% | `var(--score-excellent)` | `var(--score-excellent-bg)` |
| Good | 70–84% | `var(--score-good)` | `var(--score-good-bg)` |
| Mid | 50–69% | `var(--score-mid)` | `var(--score-mid-bg)` |
| Poor | 30–49% | `var(--score-poor)` | `var(--score-poor-bg)` |
| Fail | 0–29% | `var(--score-fail)` | `var(--score-fail-bg)` |
| Best-in-row | any | — | `outline: 2px solid var(--accent)` |
| Stale | any | — | dashed border + tooltip |

Both dark and light theme tokens are already defined in `globals.css`.

Missing data: `—` (dash), non-clickable, no background color.

### 3.4 Design System Adherence

All components follow the Lab Instrument Design System:

- **Typography**: JetBrains Mono (`var(--font-mono)`) for scores, data, labels. DM Sans (`var(--font-sans)`) for headings and body.
- **Surfaces**: `var(--bg-base)` for page, `var(--bg-raised)` for cards/panels, `var(--bg-overlay)` for drill-down panel.
- **Borders**: `var(--border)` for separators, table borders.
- **Tabs**: Active tab uses `var(--accent)` underline + `var(--accent-dim)` background.
- **Lens colors**: Ranking tabs use `var(--lens-ranking)` / `var(--lens-ranking-bg)`. Detailed tabs use `var(--lens-detail)` / `var(--lens-detail-bg)`.
- **Theme switching**: All components use CSS variables; dark/light handled automatically via `html[data-theme]`.

### 3.5 Drill-Down Panel (detailed lenses)

- **Trigger**: click on any HeatmapCell with data in `agent-x-models` or `model-x-agents` lens
- **Type**: slide-over panel from right (not modal — heatmap stays visible)
- **Close**: ✕ button, overlay click, Escape key
- **Layout**: two columns inside the panel

**Left — Scores:**
- Header: `{scenario} · {agent} × {model}`
- Test results: `12/15 passed` with progress bar
- Score: large font
- Judge scores: list of criteria with ratings (if `judge_scores` is not null)
- Attempt info: `Attempt 2/3`
- Agent version, scenario version

**Right — Run Lineage:**
- All `run_results` for this `(agent_id, model_id, scenario_id)`, sorted by `created_at DESC`
- Includes `error` rows: displayed with red "error" badge, `errorMessage` shown, score/tests omitted
- Latest non-error run: green badge "used for scores", full details (run ID, date, duration, score, agent version, scenario version)
- Previous non-error runs: compact rows with score, versions, trend (`+7%` green / `-3%` red vs previous non-error row)
- Error runs between non-error runs explain staleness visually — user can see "latest attempt errored"
- Artifacts link per run (if `artifacts_s3_key` is not null)

### 3.6 Breakdown Popover (aggregated lenses)

- **Trigger**: click on any HeatmapCell with data in `model-ranking` or `agent-ranking` lens
- **Type**: popover anchored to the cell
- **Content**: list of counterparts with individual scores
  - e.g. "Claude 4 on todo-app: Cursor → 95%, Aider → 89%, Avg → 92%"
- **Each row** is clickable → navigates to the corresponding detailed lens:
  - From `model-ranking` breakdown (counterpart = agent): click agent row → `?lens=agent-x-models&agentId={agentId}` (fix that agent, see all models)
  - From `agent-ranking` breakdown (counterpart = model): click model row → `?lens=model-x-agents&modelId={modelId}` (fix that model, see all agents)

## 4. State Management + Edge Cases

### 4.1 URL Canonicalization

The server component (`page.tsx`) validates `searchParams` and redirects to canonical form:

```
/compare                                    → model-ranking (default)
/compare?lens=agent-ranking                 → agent rankings
/compare?lens=agent-x-models&agentId=UUID   → detailed: fix agent
/compare?lens=model-x-agents&modelId=UUID   → detailed: fix model
```

**Canonicalization rules:**
- Invalid `lens` value → `redirect('/compare?lens=model-ranking')`
- `agent-x-models` without `agentId` → `redirect('/compare?lens=agent-x-models&agentId={firstAgentId}')` where first = alphabetically by name
- `model-x-agents` without `modelId` → `redirect('/compare?lens=model-x-agents&modelId={firstModelId}')` where first = alphabetically by name
- All redirects use `redirect()` from `next/navigation` (server-side, no flash)

This ensures every visible URL is fully qualified and shareable. "First available" is deterministic (alphabetical sort by name).

### 4.2 Empty States

| Condition | Behavior |
|-----------|----------|
| No results at all | "No results yet. Run a benchmark to see comparisons." + link to Matrix Builder (`/run`) |
| Lens with sparse data (e.g. 1 model) | Show available data + warning badge "Only N tested" |
| Cell without data (never tested) | `—` (dash), non-clickable |
| Cell error-only (all attempts failed) | Red `✕` icon + tooltip "N attempts failed — no successful result yet". Clickable → opens drill-down with `latest: null`, history shows error rows only |
| Stale cell (detailed) | Score shown + dashed border + tooltip "Latest run errored; showing previous result" |
| Stale cell (aggregated) | Score shown + dashed border + tooltip "N of M source results may be outdated" (using `staleCount`/`sourceCount`) |

### 4.3 Loading

- Initial page load: server-side fetch, no loading state needed (SSR)
- Tab switch: `router.push()` triggers server component re-render; use `loading.tsx` Suspense boundary with skeleton
- Drill-down/breakdown: client-side fetch with skeleton inside panel/popover

### 4.4 Error Handling

- Server fetch failure: Next.js `error.tsx` boundary with retry button
- Drill-down/breakdown API failure: inline error message inside the panel/popover ("Failed to load details") + retry button. No toast — the project has no toast infrastructure and adding one is out of scope
- Partial data: `latest_results` matview contains only `completed`/`failed` rows (`pending`/`running`/`cancelled` are excluded). `error` rows are excluded from `latest_results` but surfaced separately via the error-only detection query (see 1.6) — they appear as `✕` cells in the heatmap, as `errorOnlyCounterparts` in breakdown responses (see 2.2a), and as error entries in drill-down `history` (see 2.2b)

### 4.5 Responsive Strategy

| Breakpoint | Layout |
|-----------|--------|
| ≥ 1024px (desktop) | Tabs + Split Panel: leaderboard (280px fixed) + heatmap (flex-1). Drill-down slide-over 480px wide. |
| 768–1023px (tablet) | Tabs stacked. Leaderboard collapses to horizontal scrolling cards above heatmap. Heatmap full-width with horizontal scroll. Drill-down slide-over full-width. |
| < 768px (mobile) | Tabs as horizontal scroll pills. Leaderboard stacked above heatmap. Both full-width, vertical scroll. Drill-down as full-screen overlay. |

Heatmap always scrolls horizontally when columns exceed viewport. First column (scenario name) is sticky.

### 4.6 Performance

- **Leaderboard** (all lenses): reads directly from `score_by_model`/`score_by_agent` matviews — O(1) per entity, no runtime aggregation
- **Heatmap (detailed lenses)**: reads from `latest_results` matview with unique index — O(scenarios × entities), direct lookups
- **Heatmap (aggregated lenses)**: requires runtime `GROUP BY` on `latest_results` to compute per-cell AVG across hidden counterparts. This is a lightweight query over the matview (not raw `run_results`), bounded by `|scenarios| × |entities| × |counterparts|`. For typical dataset sizes (≤50 scenarios, ≤10 models, ≤5 agents) this is sub-millisecond
- **Staleness check**: correlated subquery against `run_results` for each displayed cell. Bounded by cell count. Consider caching in a matview if dataset grows
- New `idx_run_results_latest_wins` partial index accelerates matview refresh
- Drill-down is lazy — data fetched only on cell click
- No polling — compare operates on completed runs only

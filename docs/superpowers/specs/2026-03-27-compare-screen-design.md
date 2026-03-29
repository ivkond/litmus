# Compare Screen — Phase 3 Design Spec

> **Status:** In Review — 2026-03-27 (v2, post code-review)

## Overrides from UX Spec

This spec supersedes the UX spec (`2026-03-26-ux-redesign-design.md`) for the Compare Screen in these areas:

| UX spec says | This spec says | Rationale |
|--------------|----------------|-----------|
| Detailed lenses have no leaderboard | All lenses use Tabs + Split Panel (leaderboard + heatmap) | Consistent layout; leaderboard doubles as visual ranking even for detailed view |
| Radar / Table view toggle | Heatmap only | YAGNI — radar and table can be added later without architectural changes |

All other UX spec requirements carry forward unchanged.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Aggregation base | Materialized views (`latest_results`, `score_by_model`, `score_by_agent`) | Already exist; single source of truth; refreshed after each run |
| Aggregation formula | Two-step: AVG per (entity, scenario), then AVG across scenarios | Equal weight per scenario regardless of counterpart count (per UX spec) |
| Heatmap cell (aggregated) | AVG across hidden dimension | model-ranking: cell = AVG of model×scenario across all agents |
| API shape | Single `/api/compare` + drill-down endpoint | One fetch per view; materialized view reads |
| Layout | Tabs + Split Panel (variant A) | Dense, wide-screen friendly |
| Drill-down (aggregated) | Shows per-counterpart breakdown, not single run | Aggregated cell has no single (agent, model, scenario) key |
| Drill-down (detailed) | Full: scores + lineage slide-over | Direct key available; spec-complete |
| URL state | Server component `searchParams` + canonical redirects | Shareable; SSR-friendly; no hidden state |

## 1. Data Layer

### 1.1 Materialized Views (existing)

Located in `web/src/db/migrate-views.ts`.

**Refresh trigger (new work required):** Currently, no code refreshes matviews at runtime. The scheduler must call `REFRESH MATERIALIZED VIEW CONCURRENTLY` for all three views after updating `runs.status` to `completed`/`cancelled` in `scheduler.execute()` (line ~92 of `scheduler.ts`). Use `CONCURRENTLY` to avoid locking reads during refresh. This requires the unique indexes that already exist on each view.

```typescript
// In scheduler.execute(), after updating runs.status:
await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY latest_results`);
await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY score_by_model`);
await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY score_by_agent`);
```

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

**Migration:** Update `migrate-views.ts` with corrected SQL. Existing view refresh logic in Phase 2 reconciler remains unchanged.

### 1.3 New Index for `run_results`

The `DISTINCT ON` in `latest_results` needs a composite index for efficient execution:

```sql
CREATE INDEX idx_run_results_latest_wins
    ON run_results(agent_id, model_id, scenario_id, created_at DESC)
    WHERE status IN ('completed', 'failed');
```

Add this as a Drizzle migration. The existing `idx_run_results_agent_model` and `idx_run_results_scenario` remain for other query patterns.

### 1.4 Staleness Detection

**Problem:** If the most recent `run_results` row for a combo has `status = 'error'`, `latest_results` shows an older `completed`/`failed` row without indicating it may be stale.

**Solution:** API response includes a `stale` flag per cell. Computed by checking if any `run_results` row with `status = 'error'` has `created_at` newer than the `latest_results` row for that combo.

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

## 2. Data Access + API

### 2.1 Main Compare Data (server-side, no API route)

The server component `page.tsx` queries matviews directly via `web/src/lib/compare/queries.ts`. No public `/api/compare` route — the data is fetched during SSR and passed as props to the client component. This eliminates a serialization layer and lets Next.js handle caching via its built-in mechanisms.

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

interface HeatmapCell {
  score: number;
  bestInRow: boolean;
  stale: boolean;                // true if latest run was error (see 1.4)
  /** Present only for detailed lenses (single latest_results row) */
  testsPassed?: number;
  testsTotal?: number;
  status?: 'completed' | 'failed';
  /** Present only for aggregated lenses */
  counterpartCount?: number;     // how many agents/models were averaged
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
  avgScore: number;

  /** Per-counterpart rows from latest_results */
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
}
```

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

  latest: {
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
    status: 'completed' | 'failed';
    agentVersion: string | null;
    scenarioVersion: string | null;
    artifactsS3Key: string | null;
    createdAt: string;
    trend: number | null;
    isLatest: boolean;
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
- `page.tsx` is a Server Component: reads `searchParams` (Promise in Next.js 16), validates, redirects if needed, fetches data server-side — no waterfall.
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
- Latest run: green badge "used for scores", full details (run ID, date, duration, score, agent version, scenario version)
- Previous runs: compact rows with score, versions, trend (`+7%` green / `-3%` red)
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
| Cell without data | `—` (dash), non-clickable |
| Stale cell | Score shown + dashed border + tooltip "Latest run errored; showing previous result" |

### 4.3 Loading

- Initial page load: server-side fetch, no loading state needed (SSR)
- Tab switch: `router.push()` triggers server component re-render; use `loading.tsx` Suspense boundary with skeleton
- Drill-down/breakdown: client-side fetch with skeleton inside panel/popover

### 4.4 Error Handling

- Server fetch failure: Next.js `error.tsx` boundary with retry button
- Drill-down API failure: toast "Failed to load details" + retry button inside panel
- Partial data: only `completed`/`failed` rows shown; `pending`/`running`/`error`/`cancelled` filtered by matview

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

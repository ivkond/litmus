# Litmus Web — Roadmap

> **Spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md`
> **Plans:** `docs/superpowers/plans/`

---

## Completed Phases

### Phase 1: Foundation (2026-03-26) — 8 tasks
Next.js 15 App Router, Docker Compose infrastructure (PostgreSQL + Garage S3 + socket-proxy), Drizzle ORM schema with migrations, Lab Instrument design system (dark + light themes, CSS variables), Dashboard page with stat cards and seed data.

**Commit:** `aab9b7f feat(web): Phase 1 — foundation, design system, dashboard`
**Plan:** `2026-03-26-web-phase1-foundation.md`

### Phase 2: Run Engine (2026-03-27) — 16 tasks
End-to-end benchmark execution: matrix builder UI, lane-based Docker scheduler, SSE streaming progress, result reconciliation pipeline. Progress view with real-time matrix fill.

**Commit:** `c79283c feat(web): Phase 2 — run engine, orchestrator, progress view`
**Plan:** `2026-03-27-web-phase2-run-engine.md`

### Phase 3: Compare Screen (2026-03-27) — 11 tasks
4-lens comparison (model-ranking, agent-ranking, agent×models, model×agents), heatmap with color-coded cells, leaderboard with medals, drill-down panel with judge scores and run lineage, breakdown popover. Backed by PostgreSQL materialized views.

**Commit:** `d1a855a feat(web): Phase 3 — compare screen + judge system`
**Plan:** `2026-03-27-web-phase3-compare-screen.md`

### Phase 4: Scenarios Screen (2026-03-29) — 11 tasks
Scenario card library with search/filter, tabbed detail page (Prompt / Task / Scoring / Project / Tests), inline editing, `.litmus-pack` import/export via Garage S3, CRUD API with Zod validation.

**Commit:** `25b3254 feat(web): Phase 5 — scenarios CRUD, env/redis fixes, docs cleanup`
**Plan:** `2026-03-29-web-phase4-scenarios-screen.md`

### Phase 5: Agents + Settings (2026-03-29) — 8 tasks
Settings page with 4 sections: Agents (CRUD, health check, model discovery), Judge Providers, Scoring Config, General (theme toggle, auto-judge, parallel lanes). Agent DELETE with FK constraint handling (409), PUT with executor upsert.

**Commits:** `20f539a..f043b07` (17 commits)
**Plan:** `2026-03-29-web-phase5-agents-settings.md`

---

## Upcoming Phases

### Phase 6: Polish + UX Hardening

Dashboard, compare, nav, and design system polish — closing visual gaps between implementation and spec.

| # | Task | Origin | Description |
|---|------|--------|-------------|
| 6.1 | ~~Dashboard recent activity table~~ | **DONE** | Already implemented in `web/src/app/page.tsx` (stat cards + quick-action cards + Recent Activity table). |
| 6.2 | Compare: "Run more tests" action | Spec gap | Global toolbar action → prefilled Matrix Builder. Coverage badge + winner callout already shipped in Phase 3. |
| 6.3 | Responsive nav (hamburger <768px) | Spec: "deferred to Phase 4: Polish" | Pill-bar collapses to hamburger menu on narrow viewports. |
| 6.4 | Design system audit | TODO.md | Audit all screens against Lab Instrument spec. Fix spacing, typography, color inconsistencies. Ensure CSS variables used consistently. |
| 6.5 | Settings section panels / tabs | TODO.md | Wrap each settings section in collapsible panels or tab navigation for better UX. |

### Phase 7: Agent Health + Soft-Delete

Fix agent lifecycle gaps — health checks that actually verify agents, and safe deletion of agents with historical data.

| # | Task | Origin | Description |
|---|------|--------|-------------|
| 7.1 | Real agent health check | TODO.md | Current `DockerExecutor.healthCheck()` only calls `docker.ping()`. Should verify Docker image exists (`docker.getImage(slug).inspect()`). For `host` type, verify `binaryPath` is executable. |
| 7.2 | Agent soft-delete / archiving | TODO.md | DELETE returns 409 when agent has `run_results` or `run_tasks`. Design `archived_at` column + filter archived agents from active queries. Allows cleanup without losing historical data. |

### Phase 8: Runtime Image + Executor Rework

Execution infrastructure — build the universal runtime image and simplify the executor model.

| # | Task | Origin | Description |
|---|------|--------|-------------|
| 8.1 | Runtime image (`litmus/runtime-polyglot`) | Spec | Build universal dev container image with Python, Node, Go, JDK, C++ via Dev Container Features. Publish build script. |
| 8.2 | Executor model rework | TODO.md | Executor type (docker/host/kubernetes) should be application-level config, not per-agent. Remove executor type from agent CRUD, move to app config / environment. Agents reference a single configured executor instance. |

### Phase 9: Judge Criteria + Advanced Features

Configurable evaluation criteria and auth layer.

| # | Task | Origin | Description |
|---|------|--------|-------------|
| 9.1 | CRUD for judge criteria | TODO.md | UI and API for managing evaluation criteria (currently hardcoded in `lib/judge/criteria.ts`). Create, edit, reorder, enable/disable. Persist to DB, reference from scoring config. |
| 9.2 | Authentication and authorization | TODO.md | User login (OAuth / credentials), role-based access (admin: delete/modify, viewer: read-only), API key auth for programmatic access. |

---

## Phase Rationale

- **Phase 6** groups visual/UX polish work. Mostly frontend-only; one minor backend addition (`CompareResponse.participants` field in existing queries — no schema migration, no new endpoints).
- **Phase 7** isolates agent lifecycle fixes — both require schema migration (`archived_at`) and are tightly coupled.
- **Phase 8** groups execution infrastructure — runtime image and executor rework are interdependent (rework affects how images are selected).
- **Phase 9** collects features that change the data model significantly (criteria tables, user/role tables) and can be deferred longest.

# Design System Audit — Litmus Web

**Date:** 2026-03-30
**Branch:** feature/research
**Phase:** 6 — Polish + UX Hardening (Tasks 1 & 2)

---

## Pass 1: Automated Scan Results

### Scan scope

- Directory: `web/src/` (all `.tsx` and `.ts` files)
- Excluded: `globals.css`, `__tests__/` directories
- Patterns scanned:
  1. Hardcoded hex colors: `#[0-9a-fA-F]{3,8}`
  2. Hardcoded rgb/hsl functions: `rgb(|rgba(|hsl(|hsla(`
  3. Arbitrary Tailwind values: `text-[`, `p-[`, `gap-[`, `w-[`, etc. (filtering out `var(--)` references)

### Category A: Hardcoded colors (hex / rgb / hsl)

| File | Line | Pattern | Finding |
|------|------|---------|---------|
| — | — | — | **No violations found** |

All colors in `web/src/` use `var(--*)` tokens from the design system (defined in `globals.css`) or semantic Tailwind color utilities (e.g., `red-500/10`, `red-400` for error states). No bare hex or rgb/hsl values appear in any `.tsx` or `.ts` file outside `globals.css`.

### Category B: Hardcoded spacing / sizing arbitrary values

| File | Line | Class | Classification |
|------|------|-------|---------------|
| `web/src/app/layout.tsx` | 45 | `max-w-[1440px]` | **Exception** — layout-specific max-width constraint |
| `web/src/app/scenarios/[id]/scenario-tabs.tsx` | 102 | `min-h-[400px]` | **Exception** — layout-specific min-height constraint |
| `web/src/components/compare/drill-down-panel.tsx` | 202 | `text-[0.65rem]` | **Exception** — sub-scale value, no Tailwind equivalent |
| `web/src/components/compare/heatmap-cell.tsx` | 72 | `text-[0.55rem]` | **Exception** — sub-scale value (smaller than `text-xs`/0.75rem) |
| `web/src/components/compare/heatmap-cell.tsx` | 80 | `text-[0.6rem]` | **Exception** — sub-scale value, no Tailwind equivalent |

**Result: 0 violations found. All findings are allowed exceptions.**

---

## Allowed Exceptions

The following patterns are intentionally permitted and do not count as violations:

| Pattern | Reason |
|---------|--------|
| `text-[0.6rem]`, `text-[0.65rem]`, `text-[0.55rem]` | Sub-scale font sizes smaller than `text-xs` (0.75rem). No standard Tailwind utility exists for these values. Used in dense heatmap cells where space is extremely constrained. |
| `max-w-[1440px]` | Layout-specific max-width for the app container. A fixed-pixel breakpoint, not a design token concern. |
| `min-h-[400px]`, `min-h-[...]` | Layout-specific minimum height constraints for content panels. |
| `max-w-[300px]` | Layout-specific max-width on a table cell (truncation constraint). |
| `max-h-[70vh]` | Viewport-relative constraint — not a pixel-based design token. |
| `w-[280px]` | Layout-specific fixed sidebar/panel width. |
| `border-[var(--*)]`, `text-[var(--*)]`, etc. | All `[var(--*)]` references use design system tokens — these are correct usage, not violations. |
| `red-500/10`, `red-500/30`, `red-400` | Semantic Tailwind colors for error states. Not subject to design token replacement. |

---

## Pass 2: Visual Diff Results

Each screen was compared against `docs/superpowers/specs/2026-03-26-litmus-web-design.md`.

### Screen 1: Dashboard

| Spec requirement | Implementation | Status |
|-----------------|----------------|--------|
| 4 stat cards (Total Runs, Agents, Models, Avg Score) | `StatCard` grid, 2-col on mobile / 4-col on lg | MATCH |
| Quick-action cards: New Run + Compare (disabled when no data) | Two `Card` components, Compare has `opacity-50 cursor-not-allowed` when no data | MATCH |
| Recent Activity table: Run ID, Agent×Model, Scenarios, Pass Rate, Date | All 5 columns present with correct font-mono styling | MATCH |
| Typography: font-mono for labels, text-xs/text-sm sizes | Correct throughout | MATCH |
| Design tokens used for all colors | All text and border colors use `var(--*)` | MATCH |

### Screen 2: Run / Matrix Builder

| Spec requirement | Implementation | Status |
|-----------------|----------------|--------|
| Two-column layout: Agents&Models left, Scenarios right | `AgentCard` + `ScenarioList` + `SummaryBar` components | MATCH |
| Agent cards with model chips and accent left border | `agent-card.tsx` uses `border-l-2 border-[var(--accent)]` | MATCH |
| Summary bar: live formula + Start Run button | `summary-bar.tsx` with run count formula | MATCH |
| Progress view: progress bar + now-running indicator + matrix | `progress-bar.tsx`, `now-running.tsx`, `progress-matrix.tsx` | MATCH |
| Cell states: completed (score), running (amber), pending (dash), failed (score+warning), error (red X) | Score color-coded via `var(--score-*)` tokens | MATCH |

### Screen 3: Compare

| Spec requirement | Implementation | Status |
|-----------------|----------------|--------|
| Lens picker: 2×2 grid of comparison modes | `tab-bar.tsx` with 4 lens options | MATCH |
| Leaderboard: medals, avg score, coverage bar, warning icon | `leaderboard.tsx` with all required elements | MATCH |
| Heatmap: color-coded cells, best-in-row accent outline, TOTAL row | `heatmap.tsx` + `heatmap-cell.tsx` | MATCH |
| Drill-down panel: left (scores) + right (run lineage) | `drill-down-panel.tsx` with two-column layout | MATCH |
| Heatmap axis orientation | See intentional deviation note below | DEVIATION (intentional) |

### Screen 4: Scenarios

| Spec requirement | Implementation | Status |
|-----------------|----------------|--------|
| Library grid with scenario cards | Scenarios components in `web/src/components/scenarios/` | MATCH |
| Scenario detail tabs: Prompt / Task / Scoring / Project files / Tests | `scenario-tabs.tsx` with tab navigation | MATCH |
| Import pack / New scenario actions | API routes exist at `/api/scenarios/import` and `/api/scenarios` | MATCH |

### Screen 5: Settings

| Spec requirement | Implementation | Status |
|-----------------|----------------|--------|
| Agents section with executor type, health check | `settings/page.tsx` with agent configuration | MATCH |
| LLM Judge section: model, API key (masked), base URL | Settings sections present | MATCH |
| General: theme toggle | Theme toggle in nav-bar | MATCH |
| Section dividers using `var(--border)` | `<hr className="border-[var(--border)]" />` | MATCH |

---

## Intentional Deviations

### Heatmap Axis Inversion (Compare Screen)

**Spec:** Rows = scenarios, columns = entities being compared

**Implementation:** Rows = entities (agents/models), columns = scenarios

**Rationale:** The shipped implementation inverts this axis for better leaderboard-to-heatmap visual mapping. In the leaderboard view, each row represents an entity (agent or model) with an aggregate score. The heatmap maintains this row-per-entity layout so users can scan from leaderboard to heatmap without re-orienting. Columns = scenarios allows horizontal scrolling for many-scenario datasets, which is the more common growth dimension.

**Documentation:** This deviation is recorded in `docs/AUDIT.md` (this file) and noted in the parent spec at the relevant section.

---

## Conclusion

**Pass 1 (Automated Scan): CLEAN** — 0 violations found across all `.tsx` and `.ts` files in `web/src/`. All hex/rgb color scans returned empty. All arbitrary Tailwind value findings are allowed exceptions (sub-scale fonts, layout-specific dimensions).

**Pass 2 (Visual Diff): CLEAN** — All 5 screens match their spec descriptions. One intentional deviation documented: heatmap axis inversion (rows=entities, columns=scenarios vs. spec's rows=scenarios, columns=entities).

The design system is consistently applied. All colors use `var(--*)` tokens from the Lab Instrument design system. All spacing uses standard Tailwind utilities, with the narrow set of exceptions listed above.

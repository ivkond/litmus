# Phase 6: Polish + UX Hardening

**Date:** 2026-03-30
**Status:** Approved
**Parent spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md`
**Roadmap:** Phase 6 in `docs/ROADMAP.md`

## Problem

Phase 1–5 delivered all core features (dashboard, run engine, compare, scenarios, settings). Visual and UX gaps remain between the implementation and the Lab Instrument design spec: no responsive navigation, settings page lacks structured navigation, compare screen missing "run more tests" flow, and no formal design system audit has been done.

## Scope

| # | Task | Status | Summary |
|---|------|--------|---------|
| 6.1 | Dashboard Recent Activity | **DONE** | Already implemented in `web/src/app/page.tsx` |
| 6.2 | Compare: "Run more tests" action | To do | Global toolbar action → prefilled Matrix Builder. Coverage badge + winner callout already shipped in Phase 3. |
| 6.3 | Responsive nav (hamburger <768px) | To do | Pill-bar collapses to hamburger with dropdown overlay |
| 6.4 | Design system audit | To do | Visual diff with spec + consistency scan |
| 6.5 | Settings horizontal tabs | To do | Replace stacked sections with tab navigation |

**Implementation order:** 6.4 → 6.5 → 6.3 → 6.2 (audit-first — clean base before new work).

**Rationale:** The audit may reveal inconsistencies in components that 6.5, 6.3, and 6.2 will touch. Fixing those first avoids rework. The audit also serves as a quality gate — any findings in existing code are resolved before adding new UI.

## Design

### 6.4 Design System Audit

**Goal:** Bring all screens into full compliance with the Lab Instrument spec and eliminate CSS inconsistencies.

**Two passes:**

**Pass 1 — Consistency scan (automated):**
- Grep `web/src/` for hardcoded colors (hex, rgb, hsl outside `globals.css`)
- Grep for hardcoded spacing/font-size values outside Tailwind utilities. Arbitrary value classes (`text-[14px]`, `p-[12px]`, `gap-[8px]`) count as hardcoded — they bypass the design system. Exception: `text-[0.6rem]`/`text-[0.65rem]` and similar sub-scale values where Tailwind has no equivalent utility
- Verify all components use `var(--*)` design tokens
- Output: list of violations with file paths and line numbers

**Pass 2 — Visual diff with spec (manual):**
- Screens: Dashboard, Run, Compare, Scenarios, Settings
- Per screen: compare implementation against description in `litmus-web-design.md`
- Checklist per screen: typography (font-family, size, weight), spacing (padding, gap, margin), colors (backgrounds, borders, text), border-radius, component patterns (Card, Badge, Button)
- Output: `docs/AUDIT.md` with findings and applied fixes

**Known deviation from parent spec (intentional):** The parent spec (`litmus-web-design.md:609`) defines heatmap as "rows = scenarios, columns = entities". The implementation inverts this: rows = entities, columns = scenarios. This was a deliberate UX decision during Phase 3 — entity-as-row gives a better leaderboard-to-heatmap visual mapping. The audit should **not** treat this as a finding.

**Exit criteria:** All findings fixed, all screens match spec (accounting for documented intentional deviations above). Specifically:
- Zero hardcoded color values (hex, rgb, hsl) outside `globals.css` — all colors must use `var(--*)` tokens
- Standard Tailwind utility classes (`text-sm`, `p-4`, `gap-2`) are allowed — they are part of the design system
- Arbitrary-value Tailwind classes with hardcoded values (`text-[14px]`, `p-[12px]`, `gap-[8px]`) are violations — they bypass the design system scale. Exception: sub-scale values where Tailwind has no equivalent (`text-[0.6rem]`, `text-[0.65rem]`)

### 6.5 Settings Horizontal Tabs

**Goal:** Replace the stacked `<hr>`-separated settings sections with horizontal tab navigation — one section visible at a time.

**Tab bar design:**
- Follow the visual pattern of `web/src/components/compare/tab-bar.tsx` (underline indicator, active/inactive styles) but implement a new generic `SettingsTabs` component — the existing `TabBar` is coupled to compare-specific lens routing. Note: `web/src/app/scenarios/[id]/scenario-tabs.tsx` uses a different tab pattern (accent-dim backgrounds); Settings tabs should follow the Compare underline style for consistency.
- 4 tabs: **Agents** | **Judge Providers** | **Scoring** | **General**
- Active tab: `var(--accent)` underline, `var(--text-primary)` text
- Inactive tabs: `var(--text-muted)`, `var(--text-primary)` on hover
- Default tab: `agents` (most frequently used)

**URL state:**
- Active tab stored in query param `?tab=agents`
- Supports deep linking and browser back/forward navigation
- Pattern matches Compare screen lens param behavior

**Mobile behavior (<768px):**
- Tabs scroll horizontally with `overflow-x: auto`
- No line break — horizontal scroll is sufficient for 4 items

**Component structure:**
- New: `web/src/app/settings/settings-tabs.tsx` — tab bar + conditional rendering (client component)
- Modified: `web/src/app/settings/page.tsx` — remove `<hr>` dividers, wrap sections in `<SettingsTabs>`
- Unchanged: `AgentManager`, `JudgeProviders`, `ScoringConfig`, `GeneralSettings`

### 6.3 Responsive Navigation (Hamburger Menu)

**Goal:** Pill-bar navigation collapses to a hamburger menu on viewports <768px.

**Breakpoint:** `md` (768px), matching Tailwind default.

**Desktop (>=768px):** No changes — existing pill-bar with 5 items + ThemeToggle.

**Mobile (<768px):**
- Pill-bar hidden (`hidden md:flex`)
- Visible: **"LITMUS" logo** (left) + **hamburger button** (right, ☰ character)
- Header height remains 48px (per spec)

**Dropdown overlay:**
- Opens on hamburger click
- Closes on: menu item click, click outside, Escape key
- Position: `absolute`, directly below header, `z-50`, full width
- Background: `var(--bg-overlay)`, `border-bottom: 1px solid var(--border)`
- 5 navigation items in a vertical list + ThemeToggle at bottom
- Active item: accent background (matching desktop pill-bar active state)
- Touch targets: minimum 44×44 CSS px (Apple HIG / Material Design recommendation; WCAG 2.5.5 Level AAA requires 44×44, WCAG 2.5.8 Level AA requires 24×24)

**Accessibility:**
- Hamburger button: `aria-expanded={isOpen}`, `aria-controls="mobile-menu"`
- Menu container: `id="mobile-menu"`, `role="navigation"`
- On close: return focus to hamburger button

**Component structure:**
- All logic in existing `web/src/components/nav-bar.tsx`
- Add `useState` for `isOpen`, `useEffect` for Escape handler, `useEffect` for click-outside handler (mousedown on document, check if target is outside menu ref)
- If mobile menu logic exceeds ~40 lines, extract `MobileMenu` component

**Animation:** None. Simple `hidden`/`block` toggle. Lab Instrument aesthetic — precise, not decorative.

### 6.2 Compare: "Run More Tests" Action

**Goal:** Add a global "Run more tests" action in the compare toolbar that navigates to the Matrix Builder with all current participants prefilled.

**What already exists:**
- Leaderboard shows "low coverage" badge when entity tested with <=1 counterpart
- Heatmap highlights leader row with `bg-[var(--accent-dim)]`
- Winner callout (leader with medal emoji) implemented

**What to add:**

**1. Global "Run more tests" action in compare view (`web/src/app/compare/compare-view.tsx`):**
- Position: in the header row, left of the existing "Actions ▾" dropdown (the dropdown contains Re-evaluate/Recalculate items)
- Visible when: compare data has results (i.e., `leaderboard.length > 0`). The button is always available as a convenience to rerun the matrix — not gated by `lowCoverage`, since detailed lenses always set `lowCoverage: false` and the action is useful regardless of coverage level
- Style: text link, `var(--accent)` color, monospace, `text-xs`
- Text: `"+ Run more tests"`
- Rationale: the action prefills the entire compare matrix (all participants), so it is a view-level action, not row-specific. Placing it per-row next to "low coverage" would generate identical URLs across rows, which is misleading.

**2. Prefill URL construction (in `web/src/app/compare/compare-view.tsx`):**
- Link format: `/run?agents=uuid1,uuid2&models=uuid1,uuid2&scenarios=uuid1,uuid2` (all UUIDs)

**API change required:** Current `CompareResponse` does not contain counterpart IDs for ranking lenses. In ranking mode, `heatmap.columns` = scenarios (not counterparts), and `leaderboard[].counterpartCount` is a number without IDs. Add a `participants` field to `CompareResponse`:

```ts
// in web/src/lib/compare/types.ts
export interface CompareResponse {
  // ... existing fields ...
  participants: {
    agentIds: string[];
    modelIds: string[];
    scenarioIds: string[];
  };
}
```

**Population per lens:**
- `model-ranking`: `modelIds` from `leaderboard[].entityId`, `agentIds` from `SELECT DISTINCT agent_id FROM latest_results` (new query in `fetchRankingData`), `scenarioIds` from `heatmap.columns[].id`
- `agent-ranking`: `agentIds` from `leaderboard[].entityId`, `modelIds` from `SELECT DISTINCT model_id FROM latest_results` (new query), `scenarioIds` from `heatmap.columns[].id`
- `agent-x-models`: `agentIds` = `[anchor.id]`, `modelIds` from `heatmap.rows[].id` (entities), `scenarioIds` from `heatmap.columns[].id`
- `model-x-agents`: `modelIds` = `[anchor.id]`, `agentIds` from `heatmap.rows[].id` (entities), `scenarioIds` from `heatmap.columns[].id`

**`participants` contract guarantees:**
- All ID arrays are deduplicated (no duplicates)
- All ID arrays are sorted lexicographically (UUID sort) for stable, deterministic URLs
- Empty arrays are valid (e.g., no agents in an empty compare view)

**Prefill URL** is built in `compare-view.tsx` from `data.participants`.

**URL length safety:** UUID = 36 chars, comma separator = 1 char. For 10 agents + 10 models + 50 scenarios: `(70 × 37) + param_names ≈ 2.6KB` — well within the 8KB browser limit. Before navigation, compute the full query string byte length. If it exceeds 6KB (conservative threshold), progressively drop scenarios (from the end of the sorted array) until the URL fits, retaining at least 1 scenario. Agents and models are **never** truncated — the run page matches models to agents by ownership, so independently dropping agent or model IDs would orphan the remaining counterparts and produce zero preselected lanes. Log a `console.warn` with original and truncated scenario counts. If the URL still exceeds 6KB after reducing scenarios to 1 (a degenerate case requiring hundreds of agents×models, unrealistic for Litmus), return the URL as-is. This is an edge case unlikely in practice (Litmus is a team-internal tool), but the behavior is deterministic.

**3. Matrix Builder prefill support (`web/src/app/run/page.tsx`):**
- Read `useSearchParams()` for `agents`, `models`, `scenarios` query params (client component — cannot use server-side `searchParams` prop)
- Pass parsed UUIDs as initial selection state to the run page's `AgentCard` (preselect models) and scenario list (precheck scenarios)
- Preselect corresponding checkboxes when params present

**Edge cases for prefill params:**
- Invalid/unknown UUIDs in params are silently dropped
- If all params resolve to empty after filtering, show default empty Matrix Builder
- Malformed params (non-UUID strings) are ignored

**Components affected:**
- `web/src/lib/compare/types.ts` — add `participants` field to `CompareResponse`
- `web/src/lib/compare/queries.ts` — populate `participants` in `fetchRankingData` (new `SELECT DISTINCT` query for counterpart IDs) and `fetchDetailedData`
- `web/src/app/compare/compare-view.tsx` — add "Run more tests" toolbar action, compute prefill URL from `data.participants`
- `web/src/app/compare/page.tsx` — passes `CompareResponse` to `CompareView` (no change needed, `participants` flows through)
- `web/src/app/run/page.tsx` — parse query params via `useSearchParams()`
- Run page selection state — support initial values from URL
- Existing compare query tests (if any) — update to assert `participants` field presence and correctness

## Testing Strategy

**6.4 (Audit):**
- Automated: grep-based scan produces zero violations after fixes
- Manual: visual comparison screenshots against spec descriptions
- Doc: parent spec (`litmus-web-design.md`) updated with note documenting intentional heatmap axis deviation (rows=entities, columns=scenarios)

**6.5 (Settings tabs):**
- Unit: tab switching renders correct section
- Integration: URL param `?tab=X` activates correct tab on page load
- Integration: browser back/forward navigates between previously visited tabs
- Edge: unknown tab param falls back to default (`agents`)

**6.3 (Responsive nav):**
- Unit: hamburger toggle state
- Integration: menu opens/closes, navigation works, items route correctly
- Integration: click outside menu closes the overlay
- Accessibility: Escape closes menu, focus returns to hamburger button, `aria-expanded` reflects state
- Responsive: verify breakpoint behavior at 767px and 768px

**6.2 (Run more tests):**
- Unit: `participants` field correctly populated for all 4 lens types (`model-ranking`, `agent-ranking`, `agent-x-models`, `model-x-agents`)
- Unit: `participants` arrays are deduplicated and sorted
- Unit: `participants` is empty arrays when no results exist
- Unit: prefill URL built correctly from `participants`
- Integration: clicking "Run more tests" navigates to `/run` with prefilled matrix
- Integration: prefilled checkboxes match the compare view participants
- Edge: empty compare view (no data) — button not shown
- Edge: very large participant sets — URL truncation applies gracefully

## Out of Scope

- Mobile-first redesign of data-heavy screens (heatmap, scoring config)
- Accessibility audit beyond hamburger menu touch targets
- Performance optimization
- New features not listed in roadmap Phase 6

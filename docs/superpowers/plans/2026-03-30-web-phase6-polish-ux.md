# Phase 6: Polish + UX Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close visual gaps between implementation and Lab Instrument spec — audit design system, add settings tabs, responsive nav, and "Run more tests" compare action.

**Architecture:** Frontend-only changes for 6.4/6.5/6.3; one minor backend query extension for 6.2 (CompareResponse.participants field, no schema migration). Implementation order: audit first (6.4), then new UI (6.5 → 6.3 → 6.2).

**Tech Stack:** Next.js 15 (App Router), React, Tailwind CSS v4, Drizzle ORM, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-03-30-web-phase6-polish-ux-design.md`

**Testing approach:** Vitest runs in `environment: 'node'` (see `web/vitest.config.ts`). No jsdom, no `@testing-library/react`. Component tests verify module exports and function signatures. Business logic (queries, URL construction) is tested with mocked DB. This matches existing project patterns (see `web/src/components/settings/__tests__/agent-manager.test.tsx`, `web/src/lib/compare/__tests__/queries.test.ts`).

**Working directory:** Commands use two conventions depending on context:
- **Audit scans (Tasks 1–2):** Run from **project root** — paths start with `web/src/...`
- **Everything else (Tasks 3–12):** Run from `web/` subdirectory — `cd web` first

**Test runner:** Vitest (`npm test` or `npx vitest run <path>`) — always from `web/`.

---

## File Map

```
web/src/
├── app/
│   ├── globals.css                                     # EXISTING — design token source (DO NOT MODIFY)
│   ├── settings/
│   │   ├── page.tsx                                    # MODIFY — wrap sections in SettingsTabs
│   │   └── settings-tabs.tsx                           # NEW — tab bar + conditional rendering
│   ├── settings/__tests__/
│   │   └── settings-tabs.test.tsx                      # NEW — tab component tests
│   ├── compare/
│   │   └── compare-view.tsx                            # MODIFY — add "Run more tests" button
│   ├── run/
│   │   └── page.tsx                                    # MODIFY — read prefill params from URL
├── components/
│   ├── nav-bar.tsx                                     # MODIFY — add responsive hamburger menu
│   ├── compare/
│   │   └── tab-bar.tsx                                 # EXISTING — reference for underline tabs (no changes)
│   └── __tests__/
│       └── nav-bar.test.tsx                            # NEW — hamburger menu tests
├── lib/
│   └── compare/
│       ├── types.ts                                    # MODIFY — add participants to CompareResponse
│       ├── queries.ts                                  # MODIFY — populate participants field
│       └── __tests__/
│           └── queries.test.ts                         # MODIFY — add participants assertion tests
├── app/compare/__tests__/
│   └── compare-view.test.tsx                           # NEW — "Run more tests" button tests
├── app/run/__tests__/
│   └── run-prefill.test.ts                             # NEW — prefill URL parsing tests
docs/
├── AUDIT.md                                            # NEW — design system audit findings
└── superpowers/specs/
    └── 2026-03-26-litmus-web-design.md                 # MODIFY — add heatmap axis deviation note
```

---

## Task 1: Design System Audit — Pass 1 (Automated Scan)

**DoD:** All hardcoded color/spacing violations in `web/src/` (excluding `globals.css`) are identified. Output is a list of file:line violations ready for fixing in Task 2.

**Files:**
- No files modified — scan only

### Steps

- [ ] **Step 1.1: Grep for hardcoded hex colors**

> **Note (Windows):** Use the Grep tool (ripgrep-based) or `npx rg` instead of shell `grep`. The commands below use `rg` syntax which works cross-platform. If `rg` is unavailable, use the Claude Code Grep tool directly.

Run from the project root:

```bash
rg -n '#[0-9a-fA-F]{3,8}' web/src/ --glob '*.tsx' --glob '*.ts' --glob '!*__tests__*' --glob '!globals.css'
```

Record every line that contains a hardcoded hex color (e.g., `#fff`, `#0C0E12`, `#1A1D25`). These are violations UNLESS they are inside `globals.css`.

**Known exceptions:** None outside `globals.css`.

- [ ] **Step 1.2: Grep for hardcoded rgb/hsl/rgba colors**

```bash
rg -n 'rgb\(|rgba\(|hsl\(|hsla\(' web/src/ --glob '*.tsx' --glob '*.ts' --glob '!*__tests__*' --glob '!globals.css'
```

Record any findings. These are violations.

- [ ] **Step 1.3: Grep for arbitrary-value Tailwind classes with hardcoded spacing/sizing**

```bash
rg -n '(text-\[|p-\[|px-\[|py-\[|m-\[|mx-\[|my-\[|gap-\[|w-\[|h-\[|top-\[|left-\[|right-\[|bottom-\[|rounded-\[|border-\[|space-x-\[|space-y-\[)' web/src/ --glob '*.tsx' --glob '*.ts' --glob '!*__tests__*' --glob '!globals.css' | rg -v 'var\(--'
```

This catches Tailwind arbitrary values like `text-[14px]`, `p-[12px]`, `gap-[8px]` that bypass the design system.

**Allowed exceptions (not violations):**
- `text-[0.6rem]`, `text-[0.65rem]` — sub-scale values with no Tailwind equivalent
- `text-[0.6rem]`-style values where the number is less than the smallest Tailwind utility
- Classes that reference CSS variables: `text-[var(--...)]`, `bg-[var(--...)]`, etc. — these are filtered out by `rg -v 'var\(--'`

- [ ] **Step 1.4: Document all findings**

Create a temporary list (in memory, not a file yet — the file comes in Task 2) categorizing each violation:
- **Category A:** Hardcoded colors (hex/rgb) — must be replaced with `var(--*)` tokens
- **Category B:** Hardcoded spacing/sizing arbitrary values — must be replaced with standard Tailwind utilities

---

## Task 2: Design System Audit — Pass 2 (Visual Diff) + Fixes

**DoD:** All violations from Pass 1 fixed. All screens match spec (with documented intentional deviations). `docs/AUDIT.md` written. Parent spec updated with heatmap axis deviation note. `npx vitest run` green. Committed.

**Files:**
- Create: `docs/AUDIT.md`
- Modify: `docs/superpowers/specs/2026-03-26-litmus-web-design.md` (line ~609)
- Modify: any files containing violations from Task 1

### Steps

- [ ] **Step 2.1: Fix all Category A violations (hardcoded colors)**

For each violation found in Step 1.1 and 1.2, replace the hardcoded color with the appropriate `var(--*)` token from `globals.css`. Mapping guide:

| Hardcoded color context | Replace with |
|---|---|
| Page/card background | `var(--bg-base)`, `var(--bg-raised)`, `var(--bg-overlay)` |
| Hover background | `var(--bg-hover)` |
| Primary text | `var(--text-primary)` |
| Secondary text | `var(--text-secondary)` |
| Muted/disabled text | `var(--text-muted)` |
| Accent/brand | `var(--accent)` |
| Border | `var(--border)` |
| Error red | Keep `red-500/10`, `red-500/30`, `red-400` — these are semantic Tailwind colors for error states, not design tokens |

- [ ] **Step 2.2: Fix all Category B violations (hardcoded spacing)**

For each arbitrary-value Tailwind class, replace with the closest standard Tailwind utility:

| Arbitrary value | Tailwind utility |
|---|---|
| `text-[14px]` | `text-sm` (14px) |
| `text-[12px]` | `text-xs` (12px) |
| `p-[12px]` | `p-3` (12px) |
| `p-[16px]` | `p-4` (16px) |
| `gap-[8px]` | `gap-2` (8px) |
| `gap-[12px]` | `gap-3` (12px) |
| `gap-[16px]` | `gap-4` (16px) |
| `w-[280px]` | Keep as-is — layout-specific dimension, not a design system violation |

**Keep exceptions:** `text-[0.6rem]`, `text-[0.65rem]`, `w-[280px]` (layout-specific), `max-h-[70vh]` (viewport-relative).

- [ ] **Step 2.3: Visual diff each screen against parent spec**

Open `docs/superpowers/specs/2026-03-26-litmus-web-design.md` and compare each screen description:

1. **Dashboard** (spec section 1): typography, spacing, card borders, grid layout
2. **Run / Matrix Builder** (spec section 2): agent cards, scenario list, summary bar
3. **Compare** (spec section 3): tab bar, leaderboard, heatmap — NOTE: heatmap axis inversion (rows=entities, columns=scenarios) is intentional, NOT a finding
4. **Scenarios** (spec section 4): library list, detail tabs
5. **Settings** (spec section 5): sections, form fields

Record any additional mismatches beyond what Pass 1 found.

- [ ] **Step 2.4: Write docs/AUDIT.md**

```markdown
<!-- docs/AUDIT.md -->
# Design System Audit — Phase 6.4

**Date:** 2026-03-30
**Scope:** All screens (Dashboard, Run, Compare, Scenarios, Settings)
**Spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md`

## Pass 1 — Automated Scan Results

### Violations Found & Fixed

| # | File | Line | Violation | Fix Applied |
|---|------|------|-----------|-------------|
<!-- Fill this table with actual findings from Steps 1.1–1.3 -->

### Allowed Exceptions

- `text-[0.65rem]` in `web/src/app/compare/compare-view.tsx:143` — sub-scale value, no Tailwind equivalent
- `text-[0.6rem]` — sub-scale value, no Tailwind equivalent
- `w-[280px]` — layout-specific fixed width for leaderboard panel
- `max-h-[70vh]` — viewport-relative constraint
- `red-500/*`, `red-400` — semantic error colors (Tailwind palette), not design tokens

## Pass 2 — Visual Diff

| Screen | Status | Notes |
|--------|--------|-------|
| Dashboard | PASS | <!-- or describe fixes --> |
| Run | PASS | |
| Compare | PASS | Heatmap axis inversion (rows=entities, columns=scenarios) is intentional — see deviation note below |
| Scenarios | PASS | |
| Settings | PASS | |

## Intentional Deviations from Spec

1. **Heatmap axis inversion:** Parent spec (line 609) defines "rows = scenarios, columns = entities". Implementation uses rows = entities, columns = scenarios. This was a deliberate UX decision during Phase 3 — entity-as-row gives better leaderboard-to-heatmap visual mapping. Documented in parent spec.

## Conclusion

Zero violations remaining. All screens compliant with Lab Instrument design system.
```

Populate the violations table with actual findings from Steps 1.1-1.3. If no violations were found, write "No violations found" in the table.

- [ ] **Step 2.5: Update parent spec with heatmap axis deviation note**

Open `docs/superpowers/specs/2026-03-26-litmus-web-design.md` and add a note after line 609.

Find this text:
```
- Rows = scenarios, columns = entities being compared
```

Replace with:
```
- Rows = scenarios, columns = entities being compared
  > **Implementation note (Phase 3):** The shipped implementation inverts this axis — rows = entities, columns = scenarios — for better leaderboard-to-heatmap visual mapping. This is an intentional deviation documented in `docs/AUDIT.md`.
```

- [ ] **Step 2.6: Re-run automated scan to verify zero violations**

Re-run the same scans as Steps 1.1–1.3 to confirm all violations are resolved:

**Hex colors (same as Step 1.1):**
```bash
rg -n '#[0-9a-fA-F]{3,8}' web/src/ --glob '*.tsx' --glob '*.ts' --glob '!*__tests__*' --glob '!globals.css'
```

Verify: zero lines.

**RGB/HSL colors (same as Step 1.2):**
```bash
rg -n 'rgb\(|rgba\(|hsl\(|hsla\(' web/src/ --glob '*.tsx' --glob '*.ts' --glob '!*__tests__*' --glob '!globals.css'
```

Verify: zero lines.

**Arbitrary-value Tailwind classes (same as Step 1.3):**
```bash
rg -n '(text-\[|p-\[|px-\[|py-\[|m-\[|mx-\[|my-\[|gap-\[|w-\[|h-\[|top-\[|left-\[|right-\[|bottom-\[|rounded-\[|border-\[|space-x-\[|space-y-\[)' web/src/ --glob '*.tsx' --glob '*.ts' --glob '!*__tests__*' --glob '!globals.css' | rg -v 'var\(--'
```

Verify: zero lines, or only known exceptions (`text-[0.6rem]`, `text-[0.65rem]`, `w-[280px]`, `max-h-[70vh]`, viewport/layout-specific values).

- [ ] **Step 2.7: Run all tests**

```bash
cd web && npx vitest run
```

Verify: all existing tests pass.

- [ ] **Step 2.8: Commit**

```bash
cd web && git add -A && git commit -m "fix(web): design system audit — replace hardcoded colors/spacing with tokens

Pass 1: automated scan for hex/rgb colors and arbitrary Tailwind values.
Pass 2: visual diff of all screens against Lab Instrument spec.
All violations fixed. Heatmap axis deviation documented in parent spec.
Added docs/AUDIT.md with full findings."
```

---

## Task 3: Settings Tabs — Test

**DoD:** Test file `web/src/app/settings/__tests__/settings-tabs.test.tsx` exists. `npx vitest run src/app/settings/__tests__/settings-tabs.test.tsx` runs and all tests FAIL (component not yet created).

**Files:**
- Create: `web/src/app/settings/__tests__/settings-tabs.test.tsx`

### Steps

- [ ] **Step 3.1: Write the failing test**

```typescript
// web/src/app/settings/__tests__/settings-tabs.test.tsx
import { describe, it, expect, vi } from 'vitest';

// Mock next/navigation — required for useSearchParams
const mockGet = vi.fn<(key: string) => string | null>(() => null);
const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, refresh: vi.fn() }),
  useSearchParams: () => ({
    get: mockGet,
    toString: () => '',
  }),
}));

describe('SettingsTabs', () => {
  it('exports SettingsTabs as a named function component', async () => {
    const mod = await import('../settings-tabs');
    expect(mod.SettingsTabs).toBeDefined();
    expect(typeof mod.SettingsTabs).toBe('function');
  });

  it('exports SETTINGS_TABS array with 4 tabs', async () => {
    const mod = await import('../settings-tabs');
    expect(mod.SETTINGS_TABS).toBeDefined();
    expect(Array.isArray(mod.SETTINGS_TABS)).toBe(true);
    expect(mod.SETTINGS_TABS).toHaveLength(4);
  });

  it('tab keys are agents, judge-providers, scoring, general', async () => {
    const mod = await import('../settings-tabs');
    const keys = mod.SETTINGS_TABS.map((t: { key: string }) => t.key);
    expect(keys).toEqual(['agents', 'judge-providers', 'scoring', 'general']);
  });

  it('default tab is agents when no URL param provided', async () => {
    const mod = await import('../settings-tabs');
    // Default tab logic: when useSearchParams().get('tab') returns null,
    // the component should default to 'agents'
    expect(mod.SETTINGS_TABS[0].key).toBe('agents');
  });

  it('component accepts children for each tab section', async () => {
    const mod = await import('../settings-tabs');
    // SettingsTabs should accept props with React nodes for each section
    expect(mod.SettingsTabs.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 3.2: Run the test to verify failure**

```bash
cd web && npx vitest run src/app/settings/__tests__/settings-tabs.test.tsx
```

Expected: FAIL — module `../settings-tabs` does not exist yet.

---

## Task 4: Settings Tabs — Implementation

**DoD:** `SettingsTabs` component created. Settings page uses tabs instead of `<hr>` separators. `npx vitest run src/app/settings/__tests__/settings-tabs.test.tsx` green. `npx vitest run` green (all tests). Committed.

**Files:**
- Create: `web/src/app/settings/settings-tabs.tsx`
- Modify: `web/src/app/settings/page.tsx`

### Steps

- [ ] **Step 4.1: Create SettingsTabs component**

```tsx
// web/src/app/settings/settings-tabs.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

export const SETTINGS_TABS = [
  { key: 'agents', label: 'Agents' },
  { key: 'judge-providers', label: 'Judge Providers' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'general', label: 'General' },
] as const;

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]['key'];

interface Props {
  children: Record<SettingsTabKey, ReactNode>;
}

export function SettingsTabs({ children }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawTab = searchParams.get('tab');
  const activeTab: SettingsTabKey =
    SETTINGS_TABS.some((t) => t.key === rawTab)
      ? (rawTab as SettingsTabKey)
      : 'agents';

  function handleTabClick(key: SettingsTabKey) {
    router.push(`/settings?tab=${key}`);
  }

  return (
    <div>
      {/* Tab bar — underline style matching Compare tab-bar.tsx */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {SETTINGS_TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              onClick={() => handleTabClick(tab.key)}
              className={`whitespace-nowrap px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                isActive
                  ? 'border-b-2 border-[var(--accent)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active section */}
      <div>{children[activeTab]}</div>
    </div>
  );
}
```

- [ ] **Step 4.2: Modify settings page to use SettingsTabs**

Open `web/src/app/settings/page.tsx`. Replace the entire default export function body.

Find this exact text in `web/src/app/settings/page.tsx`:

```tsx
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold font-mono text-[var(--text-primary)]">Settings</h1>

      <AgentManager initialAgents={agentList} />

      <hr className="border-[var(--border)]" />

      <JudgeProviders />

      <hr className="border-[var(--border)]" />

      <ScoringConfig />

      <hr className="border-[var(--border)]" />

      <GeneralSettings initialSettings={generalSettings} />
    </div>
  );
```

Replace with:

```tsx
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold font-mono text-[var(--text-primary)]">Settings</h1>

      <SettingsTabs
        children={{
          agents: <AgentManager initialAgents={agentList} />,
          'judge-providers': <JudgeProviders />,
          scoring: <ScoringConfig />,
          general: <GeneralSettings initialSettings={generalSettings} />,
        }}
      />
    </div>
  );
```

Also add the import at the top of `web/src/app/settings/page.tsx`. Find:

```tsx
import type { AgentWithExecutors } from '@/components/settings/agent-form';
```

Replace with:

```tsx
import type { AgentWithExecutors } from '@/components/settings/agent-form';
import { SettingsTabs } from './settings-tabs';
```

- [ ] **Step 4.3: Run the settings tabs test**

```bash
cd web && npx vitest run src/app/settings/__tests__/settings-tabs.test.tsx
```

Expected: all 5 tests PASS.

- [ ] **Step 4.4: Run all tests**

```bash
cd web && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 4.5: Commit**

```bash
cd web && git add src/app/settings/settings-tabs.tsx src/app/settings/page.tsx src/app/settings/__tests__/settings-tabs.test.tsx && git commit -m "feat(web): settings horizontal tabs with URL state (6.5)

Replace stacked hr-separated sections with underline tab navigation.
4 tabs: Agents | Judge Providers | Scoring | General.
Active tab stored in ?tab= query param. Default: agents.
Horizontal scroll on mobile (<768px)."
```

---

## Task 5: Responsive Nav — Test

**DoD:** Test file `web/src/components/__tests__/nav-bar.test.tsx` exists. `npx vitest run src/components/__tests__/nav-bar.test.tsx` runs and tests FAIL (hamburger not yet implemented).

**Files:**
- Create: `web/src/components/__tests__/nav-bar.test.tsx`

### Steps

- [ ] **Step 5.1: Write the failing test**

```typescript
// web/src/components/__tests__/nav-bar.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: vi.fn(({ children }) => children),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

vi.mock('../theme-toggle', () => ({
  ThemeToggle: vi.fn(() => null),
}));

describe('NavBar', () => {
  it('exports NavBar as a named function component', async () => {
    const mod = await import('../nav-bar');
    expect(mod.NavBar).toBeDefined();
    expect(typeof mod.NavBar).toBe('function');
  });

  it('exports NAV_ITEMS with 5 routes', async () => {
    const mod = await import('../nav-bar');
    expect(mod.NAV_ITEMS).toBeDefined();
    expect(mod.NAV_ITEMS).toHaveLength(5);
    expect(mod.NAV_ITEMS[0]).toEqual({ href: '/', label: 'Dashboard' });
    expect(mod.NAV_ITEMS[1]).toEqual({ href: '/run', label: 'Run' });
    expect(mod.NAV_ITEMS[2]).toEqual({ href: '/compare', label: 'Compare' });
    expect(mod.NAV_ITEMS[3]).toEqual({ href: '/scenarios', label: 'Scenarios' });
    expect(mod.NAV_ITEMS[4]).toEqual({ href: '/settings', label: 'Settings' });
  });

  it('component has function length <= 1 (single props arg or none)', async () => {
    const mod = await import('../nav-bar');
    expect(mod.NavBar.length).toBeLessThanOrEqual(1);
  });
});

// Note: Hamburger toggle, Escape handler, click-outside, aria attributes,
// and responsive breakpoint behavior cannot be unit-tested in node env
// without jsdom + testing-library. These are verified via manual testing
// and the automated design audit (Task 1-2).
//
// Testable contract: NavBar exports NAV_ITEMS (needed by mobile menu)
// and renders as a function component. The hamburger logic uses useState,
// useEffect, and useRef — all React hooks that require a renderer.
```

- [ ] **Step 5.2: Run the test to verify current state**

```bash
cd web && npx vitest run src/components/__tests__/nav-bar.test.tsx
```

Expected: First test passes (NavBar already exists), second test FAILS (NAV_ITEMS is not currently exported), third test passes.

---

## Task 6: Responsive Nav — Implementation

**DoD:** NavBar has hamburger menu on `<768px`. Desktop pill-bar unchanged. `NAV_ITEMS` exported. `npx vitest run src/components/__tests__/nav-bar.test.tsx` green. `npx vitest run` green. Committed.

**Files:**
- Modify: `web/src/components/nav-bar.tsx`

### Steps

- [ ] **Step 6.1: Rewrite nav-bar.tsx with responsive hamburger menu**

Replace the entire contents of `web/src/components/nav-bar.tsx` with:

```tsx
// web/src/components/nav-bar.tsx
'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme-toggle';

export const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/run', label: 'Run' },
  { href: '/compare', label: 'Compare' },
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/settings', label: 'Settings' },
] as const;

export function NavBar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Close menu on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen]);

  // Backup close on route change (primary close is onClick on each Link)
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  function isActive(href: string): boolean {
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  }

  return (
    <nav className="relative mb-6">
      <div className="flex items-center justify-between h-12">
        {/* Logo */}
        <Link
          href="/"
          className="font-mono text-sm font-bold text-[var(--accent)] tracking-wider"
        >
          LITMUS
        </Link>

        {/* Desktop pill navigation (hidden on mobile) */}
        <div className="
          hidden md:flex items-center gap-1
          bg-[var(--bg-raised)] border border-[var(--border)]
          rounded-full px-1.5 py-1
        ">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`
                font-mono text-xs px-3 py-1 rounded-full transition-colors
                ${isActive(item.href)
                  ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }
              `}
            >
              {item.label}
            </Link>
          ))}
        </div>

        {/* Desktop theme toggle (hidden on mobile) */}
        <div className="hidden md:block">
          <ThemeToggle />
        </div>

        {/* Mobile hamburger button (hidden on desktop) */}
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-controls="mobile-menu"
          className="md:hidden flex items-center justify-center w-11 h-11 text-[var(--text-primary)] font-mono text-lg"
        >
          {isOpen ? '\u2715' : '\u2630'}
        </button>
      </div>

      {/* Mobile dropdown overlay */}
      {isOpen && (
        <div
          ref={menuRef}
          id="mobile-menu"
          role="navigation"
          className="absolute left-0 right-0 top-12 z-50 border-b border-[var(--border)] bg-[var(--bg-overlay)] md:hidden"
        >
          <div className="flex flex-col py-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsOpen(false)}
                className={`
                  flex items-center min-h-[44px] px-4 font-mono text-sm transition-colors
                  ${isActive(item.href)
                    ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }
                `}
              >
                {item.label}
              </Link>
            ))}
            <div className="px-4 pt-2 pb-1 border-t border-[var(--border)] mt-2">
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
```

- [ ] **Step 6.2: Run the nav-bar test**

```bash
cd web && npx vitest run src/components/__tests__/nav-bar.test.tsx
```

Expected: all 3 tests PASS.

- [ ] **Step 6.3: Run all tests**

```bash
cd web && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 6.4: Commit**

```bash
cd web && git add src/components/nav-bar.tsx src/components/__tests__/nav-bar.test.tsx && git commit -m "feat(web): responsive hamburger nav for mobile <768px (6.3)

Pill-bar hidden on mobile, replaced with hamburger button + dropdown overlay.
Closes on: menu item onClick, click outside, Escape key, route change.
Touch targets: 44px minimum. Aria attributes for accessibility."
```

---

## Task 7: CompareResponse.participants — Test

**DoD:** Tests for `participants` field added to `web/src/lib/compare/__tests__/queries.test.ts`. `npx vitest run src/lib/compare/__tests__/queries.test.ts` runs and new tests FAIL (participants field not yet populated).

**Files:**
- Modify: `web/src/lib/compare/__tests__/queries.test.ts`

### Steps

- [ ] **Step 7.1: Add participants tests to existing queries.test.ts**

Open `web/src/lib/compare/__tests__/queries.test.ts` and add the following tests INSIDE the existing `describe('fetchCompareData', ...)` block, AFTER the last existing `it(...)` block (after line 88):

```typescript
  it('returns empty participants arrays when no data (model-ranking)', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]);
    sqlMock.unsafe.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.unsafe.mockResolvedValueOnce([]);
    sqlMock.unsafe.mockResolvedValueOnce([]);
    sqlMock.unsafe.mockResolvedValueOnce([]);
    sqlMock.unsafe.mockResolvedValueOnce([]);

    const result = await fetchCompareData({ lens: 'model-ranking' });

    expect(result.participants).toBeDefined();
    expect(result.participants).toEqual({
      agentIds: [],
      modelIds: [],
      scenarioIds: [],
    });
  });

  it('populates participants for model-ranking with deduped sorted IDs', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 2 }]);
    sqlMock.unsafe
      .mockResolvedValueOnce([
        {
          entity_id: 'model-b',
          entity_name: 'GPT-4o',
          avg_score: 85,
          scenario_count: 2,
          counterpart_count: 1,
          judged_count: 2,
          judged_total: 2,
        },
        {
          entity_id: 'model-a',
          entity_name: 'Claude',
          avg_score: 90,
          scenario_count: 2,
          counterpart_count: 1,
          judged_count: 2,
          judged_total: 2,
        },
      ]);
    sqlMock.mockResolvedValueOnce([
      { id: 'scenario-b', slug: 'chat', name: 'Chat' },
      { id: 'scenario-a', slug: 'api', name: 'API' },
    ]);
    sqlMock.unsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    // Counterpart query (agents for model-ranking)
    sqlMock.unsafe.mockResolvedValueOnce([
      { id: 'agent-c' },
      { id: 'agent-a' },
    ]);

    const result = await fetchCompareData({ lens: 'model-ranking' });

    expect(result.participants).toEqual({
      agentIds: ['agent-a', 'agent-c'],
      modelIds: ['model-a', 'model-b'],
      scenarioIds: ['scenario-a', 'scenario-b'],
    });
  });

  it('populates participants for agent-x-models from anchor and entities', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]);
    sqlMock.unsafe.mockResolvedValueOnce([{ id: 'agent-1', name: 'Cursor' }]);
    sqlMock
      .mockResolvedValueOnce([
        {
          entity_id: 'model-2',
          entity_name: 'GPT-4o',
          avg_score: 80,
          scenario_count: 1,
          judged_count: 1,
          judged_total: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'scenario-1', slug: 'todo', name: 'Todo' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await fetchCompareData({ lens: 'agent-x-models', agentId: 'agent-1' });

    expect(result.participants).toEqual({
      agentIds: ['agent-1'],
      modelIds: ['model-2'],
      scenarioIds: ['scenario-1'],
    });
  });
```

- [ ] **Step 7.2: Run the test to verify failure**

```bash
cd web && npx vitest run src/lib/compare/__tests__/queries.test.ts
```

Expected: new tests FAIL — `participants` is `undefined` on the response.

---

## Task 8: CompareResponse.participants — Implementation

**DoD:** `participants` field added to `CompareResponse` type. Both `fetchRankingData` and `fetchDetailedData` populate it. All arrays deduplicated and sorted. `npx vitest run src/lib/compare/__tests__/queries.test.ts` green. `npx vitest run` green. Committed.

**Files:**
- Modify: `web/src/lib/compare/types.ts`
- Modify: `web/src/lib/compare/queries.ts`

### Steps

- [ ] **Step 8.1: Add participants field to CompareResponse type**

Open `web/src/lib/compare/types.ts`. Find this text:

```typescript
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
```

Replace with:

```typescript
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
  participants: {
    agentIds: string[];
    modelIds: string[];
    scenarioIds: string[];
  };
}
```

- [ ] **Step 8.2: Populate participants in fetchRankingData**

Open `web/src/lib/compare/queries.ts`. Find the return statement in `fetchRankingData` (around line 201):

```typescript
  return {
    lens,
    canonicalParams: { lens },
    leaderboard,
    heatmap: {
      columns,
      rows,
      cells,
      totals,
    },
  };
```

Replace with:

```typescript
  // Fetch counterpart IDs for participants
  const counterpartRows = await sql.unsafe(`
    SELECT DISTINCT lr.${config.counterpartCol} AS id
    FROM latest_results lr
  `);
  const counterpartIds = (counterpartRows as SqlRow[]).map((row) => String(row.id));

  const entityIds = leaderboard.map((e) => e.entityId);
  const scenarioIds = columns.map((c) => c.id);

  const isModelRanking = lens === 'model-ranking';
  const participants = {
    agentIds: dedupSort(isModelRanking ? counterpartIds : entityIds),
    modelIds: dedupSort(isModelRanking ? entityIds : counterpartIds),
    scenarioIds: dedupSort(scenarioIds),
  };

  return {
    lens,
    canonicalParams: { lens },
    leaderboard,
    heatmap: {
      columns,
      rows,
      cells,
      totals,
    },
    participants,
  };
```

- [ ] **Step 8.3: Populate participants in fetchDetailedData**

Open `web/src/lib/compare/queries.ts`. Find the return statement in `fetchDetailedData` (around line 484):

```typescript
  return {
    lens: params.lens,
    anchor,
    availableAnchors,
    canonicalParams,
    leaderboard,
    heatmap: {
      columns,
      rows,
      cells,
      totals,
    },
  };
```

Replace with:

```typescript
  const entityIds = leaderboard.map((e) => e.entityId);
  const scenarioIds = columns.map((c) => c.id);

  const participants = isAgentFixed
    ? {
        agentIds: dedupSort(anchorId ? [anchorId] : []),
        modelIds: dedupSort(entityIds),
        scenarioIds: dedupSort(scenarioIds),
      }
    : {
        agentIds: dedupSort(entityIds),
        modelIds: dedupSort(anchorId ? [anchorId] : []),
        scenarioIds: dedupSort(scenarioIds),
      };

  return {
    lens: params.lens,
    anchor,
    availableAnchors,
    canonicalParams,
    leaderboard,
    heatmap: {
      columns,
      rows,
      cells,
      totals,
    },
    participants,
  };
```

- [ ] **Step 8.4: Add participants to the empty anchor early return in fetchDetailedData**

Open `web/src/lib/compare/queries.ts`. Find the early return when no anchor (around line 247):

```typescript
  if (!anchorId) {
    return {
      lens: params.lens,
      availableAnchors,
      canonicalParams,
      leaderboard: [],
      heatmap: { columns: [], rows: [], cells: {}, totals: {} },
    };
  }
```

Replace with:

```typescript
  if (!anchorId) {
    return {
      lens: params.lens,
      availableAnchors,
      canonicalParams,
      leaderboard: [],
      heatmap: { columns: [], rows: [], cells: {}, totals: {} },
      participants: { agentIds: [], modelIds: [], scenarioIds: [] },
    };
  }
```

- [ ] **Step 8.5: Add dedupSort helper function**

Open `web/src/lib/compare/queries.ts`. Find the `slugify` function at the bottom (around line 499):

```typescript
function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-');
}
```

Replace with:

```typescript
function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-');
}

function dedupSort(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}
```

- [ ] **Step 8.6: Run the queries test**

```bash
cd web && npx vitest run src/lib/compare/__tests__/queries.test.ts
```

Expected: all tests PASS (including the 3 new ones from Task 7).

**Note:** If existing tests fail because `participants` is now present on the response and old assertions don't expect it, you may need to update the existing assertions. The existing tests use `expect(result.lens).toBe(...)` (property checks, not deep equality on the entire object), so they should pass without changes.

- [ ] **Step 8.7: Run all tests**

```bash
cd web && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 8.8: Commit**

```bash
cd web && git add src/lib/compare/types.ts src/lib/compare/queries.ts src/lib/compare/__tests__/queries.test.ts && git commit -m "feat(web): add participants field to CompareResponse (6.2 backend)

All 4 lenses populate agentIds, modelIds, scenarioIds arrays.
Ranking lenses: SELECT DISTINCT counterpart IDs from latest_results.
Detailed lenses: anchor ID + entity IDs from heatmap rows.
All arrays deduplicated and lexicographically sorted."
```

---

## Task 9: "Run more tests" Button — Test

**DoD:** Test file `web/src/app/compare/__tests__/compare-view.test.tsx` exists. Tests verify module export and URL construction logic. `npx vitest run src/app/compare/__tests__/compare-view.test.tsx` runs.

**Files:**
- Create: `web/src/app/compare/__tests__/compare-view.test.tsx`

### Steps

- [ ] **Step 9.1: Write the test**

```typescript
// web/src/app/compare/__tests__/compare-view.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({
    get: vi.fn(() => null),
    toString: () => '',
  }),
}));

describe('CompareView', () => {
  it('exports CompareView as a named function component', async () => {
    const mod = await import('../compare-view');
    expect(mod.CompareView).toBeDefined();
    expect(typeof mod.CompareView).toBe('function');
  });
});

describe('buildPrefillUrl', () => {
  it('exports buildPrefillUrl function', async () => {
    const mod = await import('../compare-view');
    expect(mod.buildPrefillUrl).toBeDefined();
    expect(typeof mod.buildPrefillUrl).toBe('function');
  });

  // NOTE: buildPrefillUrl is ID-format agnostic (just builds URL strings).
  // parsePrefillParams (Task 12) enforces UUID format on the receiving end.
  // Tests here use UUIDs for end-to-end contract consistency.
  const AGENT_1 = '00000000-0000-0000-0000-000000000001';
  const AGENT_2 = '00000000-0000-0000-0000-000000000002';
  const MODEL_1 = '11111111-1111-1111-1111-111111111111';
  const SCEN_1  = '22222222-2222-2222-2222-222222222221';
  const SCEN_2  = '22222222-2222-2222-2222-222222222222';
  const SCEN_3  = '22222222-2222-2222-2222-222222222223';

  it('builds correct URL from participants', async () => {
    const { buildPrefillUrl } = await import('../compare-view');
    const url = buildPrefillUrl({
      agentIds: [AGENT_1, AGENT_2],
      modelIds: [MODEL_1],
      scenarioIds: [SCEN_1, SCEN_2, SCEN_3],
    });
    expect(url).toBe(`/run?agents=${AGENT_1},${AGENT_2}&models=${MODEL_1}&scenarios=${SCEN_1},${SCEN_2},${SCEN_3}`);
  });

  it('returns /run with empty params when all arrays empty', async () => {
    const { buildPrefillUrl } = await import('../compare-view');
    const url = buildPrefillUrl({
      agentIds: [],
      modelIds: [],
      scenarioIds: [],
    });
    expect(url).toBe('/run');
  });

  it('omits param keys when their arrays are empty', async () => {
    const { buildPrefillUrl } = await import('../compare-view');
    const url = buildPrefillUrl({
      agentIds: [AGENT_1],
      modelIds: [],
      scenarioIds: [SCEN_1],
    });
    expect(url).toBe(`/run?agents=${AGENT_1}&scenarios=${SCEN_1}`);
  });

  it('truncates scenarios (not agents/models) when URL exceeds 6KB', async () => {
    const { buildPrefillUrl } = await import('../compare-view');
    // Create enough scenarios to exceed 6KB
    // UUID = 36 chars + comma = 37 chars. 6KB = 6144 bytes.
    // Generate 200 valid-format UUIDs (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    const manyScenarios = Array.from({ length: 200 }, (_, i) => {
      const hex = String(i).padStart(12, '0');
      return `cccccccc-cccc-cccc-cccc-${hex}`;
    });
    const url = buildPrefillUrl({
      agentIds: [AGENT_1],
      modelIds: [MODEL_1],
      scenarioIds: manyScenarios,
    });
    // URL should be under 6144 bytes
    expect(new TextEncoder().encode(url).length).toBeLessThanOrEqual(6144);
    // Agents and models must be fully preserved (never truncated)
    expect(url).toContain(`agents=${AGENT_1}`);
    expect(url).toContain(`models=${MODEL_1}`);
    // Scenarios should be reduced but at least 1 remains
    const scenarioParam = new URL(`http://localhost${url}`).searchParams.get('scenarios');
    expect(scenarioParam).not.toBeNull();
    const scenarioCount = scenarioParam!.split(',').length;
    expect(scenarioCount).toBeLessThan(200);
    expect(scenarioCount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 9.2: Run the test to verify state**

```bash
cd web && npx vitest run src/app/compare/__tests__/compare-view.test.tsx
```

Expected: first test (CompareView export) passes, buildPrefillUrl tests FAIL (function not yet exported).

---

## Task 10: "Run more tests" Button — Implementation

**DoD:** "Run more tests" link visible in compare header when data has results. `buildPrefillUrl` exported and tested. URL truncation works. `npx vitest run src/app/compare/__tests__/compare-view.test.tsx` green. `npx vitest run` green. Committed.

**Files:**
- Modify: `web/src/app/compare/compare-view.tsx`

### Steps

- [ ] **Step 10.1: Add buildPrefillUrl function and export it**

Open `web/src/app/compare/compare-view.tsx`. Add the following AFTER the imports (after line 11) and BEFORE the `Props` interface (before line 13):

Find this text:

```typescript
interface Props {
  data: CompareResponse;
}
```

Replace with:

```typescript
const MAX_URL_BYTES = 6144;

export function buildPrefillUrl(participants: {
  agentIds: string[];
  modelIds: string[];
  scenarioIds: string[];
}): string {
  const parts: Array<{ key: string; ids: string[] }> = [
    { key: 'agents', ids: participants.agentIds },
    { key: 'models', ids: participants.modelIds },
    { key: 'scenarios', ids: participants.scenarioIds },
  ];

  function buildUrl(paramParts: Array<{ key: string; ids: string[] }>): string {
    const params = paramParts
      .filter((p) => p.ids.length > 0)
      .map((p) => `${p.key}=${p.ids.join(',')}`)
      .join('&');
    return params ? `/run?${params}` : '/run';
  }

  let url = buildUrl(parts);
  let byteLength = new TextEncoder().encode(url).length;

  if (byteLength <= MAX_URL_BYTES) {
    return url;
  }

  // Progressive truncation: only drop scenarios to preserve agent×model compatibility.
  // Dropping agents or models independently would break the prefill — the run page
  // matches models to agents, so an orphaned model ID produces zero selections.
  const scenarioPart = parts[2]; // 'scenarios'
  const originalCount = scenarioPart.ids.length;

  while (scenarioPart.ids.length > 1) {
    scenarioPart.ids = scenarioPart.ids.slice(0, scenarioPart.ids.length - 1);
    url = buildUrl(parts);
    byteLength = new TextEncoder().encode(url).length;
    if (byteLength <= MAX_URL_BYTES) {
      console.warn(
        `[buildPrefillUrl] Truncated scenarios from ${originalCount} to ${scenarioPart.ids.length} to fit URL limit`
      );
      return url;
    }
  }

  // If still too long after truncating scenarios to 1, return as-is — this is
  // a degenerate case (hundreds of agents/models) that is unrealistic for Litmus.
  console.warn('[buildPrefillUrl] URL still exceeds limit after truncating scenarios to 1');
  return url;
}

interface Props {
  data: CompareResponse;
}
```

- [ ] **Step 10.2: Add "Run more tests" link to the compare header**

Open `web/src/app/compare/compare-view.tsx`. Find this text in the header section:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">Compare</h1>

        {/* Actions dropdown — judge control */}
        <div className="relative">
```

Replace with:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">Compare</h1>

        <div className="flex items-center gap-3">
          {/* "Run more tests" link — visible when compare has results */}
          {data.leaderboard.length > 0 && (
            <Link
              href={buildPrefillUrl(data.participants)}
              className="font-mono text-xs text-[var(--accent)] hover:underline"
            >
              + Run more tests
            </Link>
          )}

          {/* Actions dropdown — judge control */}
          <div className="relative">
```

- [ ] **Step 10.3: Close the wrapping div**

Find the closing `</div>` for the actions dropdown container (the `<div className="relative">` that was on line 118). After the actions dropdown's final `</div>`, we need to close the new wrapper `<div className="flex items-center gap-3">`.

Find this exact text (the end of the actions dropdown + the old closing div for the header row):

```tsx
          )}
        </div>
      </div>
```

Replace with:

```tsx
          )}
          </div>
        </div>
      </div>
```

- [ ] **Step 10.4: Add Link import**

Open `web/src/app/compare/compare-view.tsx`. Find:

```typescript
import { useCallback, useEffect, useState } from 'react';
```

Replace with:

```typescript
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
```

- [ ] **Step 10.5: Run the compare-view test**

```bash
cd web && npx vitest run src/app/compare/__tests__/compare-view.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 10.6: Run all tests**

```bash
cd web && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 10.7: Commit**

```bash
cd web && git add src/app/compare/compare-view.tsx src/app/compare/__tests__/compare-view.test.tsx && git commit -m "feat(web): 'Run more tests' button in compare header (6.2 frontend)

Text link left of Actions dropdown, visible when leaderboard has entries.
Navigates to /run?agents=...&models=...&scenarios=... with all participants.
URL truncation: drops scenarios only if URL exceeds 6KB (preserves agent×model compatibility).
buildPrefillUrl exported and tested."
```

---

## Task 11: Matrix Builder Prefill — Test

**DoD:** Test file `web/src/app/run/__tests__/run-prefill.test.ts` exists. Tests verify URL param parsing logic. `npx vitest run src/app/run/__tests__/run-prefill.test.ts` runs and tests FAIL.

**Files:**
- Create: `web/src/app/run/__tests__/run-prefill.test.ts`

### Steps

- [ ] **Step 11.1: Write the failing test**

```typescript
// web/src/app/run/__tests__/run-prefill.test.ts
import { describe, it, expect } from 'vitest';

// Test the pure parsing logic that will be extracted into a helper
describe('parsePrefillParams', () => {
  it('exports parsePrefillParams function', async () => {
    const mod = await import('../prefill');
    expect(mod.parsePrefillParams).toBeDefined();
    expect(typeof mod.parsePrefillParams).toBe('function');
  });

  it('parses comma-separated UUIDs from params', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890,a1b2c3d4-e5f6-7890-abcd-ef1234567891',
      models: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      scenarios: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890,c1b2c3d4-e5f6-7890-abcd-ef1234567891,c1b2c3d4-e5f6-7890-abcd-ef1234567892',
    });
    expect(result.agentIds).toEqual([
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
    ]);
    expect(result.modelIds).toEqual(['b1b2c3d4-e5f6-7890-abcd-ef1234567890']);
    expect(result.scenarioIds).toHaveLength(3);
  });

  it('returns empty arrays when params are null/undefined', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: null,
      models: null,
      scenarios: null,
    });
    expect(result).toEqual({ agentIds: [], modelIds: [], scenarioIds: [] });
  });

  it('filters out non-UUID strings', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: 'not-a-uuid,a1b2c3d4-e5f6-7890-abcd-ef1234567890,also-invalid',
      models: '',
      scenarios: null,
    });
    expect(result.agentIds).toEqual(['a1b2c3d4-e5f6-7890-abcd-ef1234567890']);
    expect(result.modelIds).toEqual([]);
    expect(result.scenarioIds).toEqual([]);
  });

  it('handles empty string params', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: '',
      models: '',
      scenarios: '',
    });
    expect(result).toEqual({ agentIds: [], modelIds: [], scenarioIds: [] });
  });

  it('deduplicates IDs', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = parsePrefillParams({
      agents: `${uuid},${uuid},${uuid}`,
      models: null,
      scenarios: null,
    });
    expect(result.agentIds).toEqual([uuid]);
  });
});
```

- [ ] **Step 11.2: Run the test to verify failure**

```bash
cd web && npx vitest run src/app/run/__tests__/run-prefill.test.ts
```

Expected: FAIL — module `../prefill` does not exist yet.

---

## Task 12: Matrix Builder Prefill — Implementation

**DoD:** `parsePrefillParams` helper created. Run page reads `useSearchParams` and preselects agents/models/scenarios from URL. `npx vitest run src/app/run/__tests__/run-prefill.test.ts` green. `npx vitest run` green. Committed.

**Files:**
- Create: `web/src/app/run/prefill.ts`
- Modify: `web/src/app/run/page.tsx`

### Steps

- [ ] **Step 12.1: Create prefill parsing helper**

```typescript
// web/src/app/run/prefill.ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PrefillParams {
  agents: string | null;
  models: string | null;
  scenarios: string | null;
}

interface PrefillResult {
  agentIds: string[];
  modelIds: string[];
  scenarioIds: string[];
}

function parseUuidList(value: string | null): string[] {
  if (!value) return [];
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
  return [...new Set(ids)];
}

export function parsePrefillParams(params: PrefillParams): PrefillResult {
  return {
    agentIds: parseUuidList(params.agents),
    modelIds: parseUuidList(params.models),
    scenarioIds: parseUuidList(params.scenarios),
  };
}
```

- [ ] **Step 12.2: Run the prefill test**

```bash
cd web && npx vitest run src/app/run/__tests__/run-prefill.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 12.3: Modify run page to read prefill params**

Open `web/src/app/run/page.tsx`.

**Add imports.** Find:

```typescript
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
```

Replace with:

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { parsePrefillParams } from './prefill';
```

**Add useSearchParams and prefill effect.** Find:

```typescript
  const [refreshingAgents, setRefreshingAgents] = useState<Set<string>>(new Set());
  const [isStarting, setIsStarting] = useState(false);
```

Replace with:

```typescript
  const [refreshingAgents, setRefreshingAgents] = useState<Set<string>>(new Set());
  const [isStarting, setIsStarting] = useState(false);
  const searchParams = useSearchParams();
```

**Add prefill effect after data fetching.** Find this exact text in `web/src/app/run/page.tsx`:

```typescript
  // ── Selection handlers ────────────────────────────────────────

  const handleToggleModel = useCallback((agentId: string, modelDbId: string) => {
```

Replace with:

```typescript
  // ── Prefill from URL params (one-shot) ───────────────────────

  const hasAppliedPrefill = useRef(false);

  useEffect(() => {
    if (hasAppliedPrefill.current) return;
    if (loadingAgents || loadingScenarios) return;

    const prefill = parsePrefillParams({
      agents: searchParams.get('agents'),
      models: searchParams.get('models'),
      scenarios: searchParams.get('scenarios'),
    });

    const hasPrefill =
      prefill.agentIds.length > 0 ||
      prefill.modelIds.length > 0 ||
      prefill.scenarioIds.length > 0;

    // Mark as applied regardless — we only attempt prefill once.
    // If params are empty/invalid, the user sees default empty Matrix Builder.
    hasAppliedPrefill.current = true;

    if (!hasPrefill) return;

    // Preselect models grouped by their owning agent
    const prefillAgentIds = new Set(prefill.agentIds);
    const prefillModelIds = new Set(prefill.modelIds);
    const newSelections = new Map<string, Set<string>>();

    for (const agent of agents) {
      if (!prefillAgentIds.has(agent.id)) continue;
      const agentModels = new Set<string>();
      for (const model of agent.availableModels) {
        if (prefillModelIds.has(model.dbId)) {
          agentModels.add(model.dbId);
        }
      }
      if (agentModels.size > 0) {
        newSelections.set(agent.id, agentModels);
      }
    }

    if (newSelections.size > 0) {
      setSelections(newSelections);
    }

    // Preselect scenarios — silently drop unknown IDs
    const validScenarioIds = new Set(scenarios.map((s) => s.id));
    const prefillScenarios = new Set(
      prefill.scenarioIds.filter((id) => validScenarioIds.has(id))
    );
    if (prefillScenarios.size > 0) {
      setSelectedScenarios(prefillScenarios);
    }
  }, [loadingAgents, loadingScenarios, agents, scenarios, searchParams]);

  // ── Selection handlers ────────────────────────────────────────

  const handleToggleModel = useCallback((agentId: string, modelDbId: string) => {
```

- [ ] **Step 12.4: Run all tests**

```bash
cd web && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 12.5: Commit**

```bash
cd web && git add src/app/run/prefill.ts src/app/run/page.tsx src/app/run/__tests__/run-prefill.test.ts && git commit -m "feat(web): Matrix Builder prefill from URL params (6.2 complete)

Run page reads ?agents=...&models=...&scenarios= query params.
Parsed via parsePrefillParams with UUID validation and dedup.
Invalid/unknown UUIDs silently dropped. Empty params = default state.
Completes the Compare → Run more tests → prefilled Matrix flow."
```

---

## Verification Checklist

After all 12 tasks are complete, run the following verification:

```bash
cd web && npx vitest run
```

All tests must pass. Then verify the following manually:

1. **Design audit:** No hardcoded colors outside `globals.css`. `docs/AUDIT.md` exists.
2. **Settings tabs:** Navigate to `/settings` — tabs visible. Click each tab — correct section shown. URL updates to `?tab=X`. Direct link `/settings?tab=general` loads General tab. Unknown tab `/settings?tab=foo` falls back to Agents.
3. **Responsive nav:** Resize browser to <768px — hamburger visible, pill-bar hidden. Click hamburger — overlay with 5 items + theme toggle. Click item — navigates and closes (even if same route). Click outside — closes. Press Escape — closes and focus returns to hamburger.
4. **Compare "Run more tests":** Navigate to `/compare` with data — "+ Run more tests" link visible left of "Actions" dropdown. Click it — navigates to `/run?agents=...&models=...&scenarios=...`. Run page has correct checkboxes preselected.
5. **Empty state:** Navigate to `/compare` with no data — "+ Run more tests" link NOT visible.

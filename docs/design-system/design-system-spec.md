# Litmus Design System Specification

> **Audience:** AI-agents (developer & reviewer). This document is the single source of truth
> for building and evaluating any UI in the Litmus web application.
>
> **Aesthetic:** *Lab Instrument* — precise, data-dense, scientific.
> Think oscilloscope panels, Bloomberg terminals, scientific notebooks.

> **Implementation status:** This spec describes the **target state** of the design system.
> Some tokens and infrastructure (e.g. `@theme` block, shadcn variable bridge, `cn()` utility)
> do not yet exist in code and must be implemented as part of the design system rollout.
> The implementation plan accompanies this spec.

---

## 1. Design Tokens

All tokens live in `web/src/app/globals.css`, organized in **three blocks**:

| Block | What goes here | How Tailwind sees it |
| ----- | -------------- | -------------------- |
| **`@theme { }`** | Static tokens: typography scale, spacing, motion, shadows | First-class utilities (e.g. `text-xs`, `duration-fast`) |
| **Theme selectors** (`html[data-theme]`) | Color tokens: surfaces, text, accent, score, lens, border | Raw CSS custom properties — NOT visible to Tailwind by default |
| **`@theme inline { }`** | Aliases that point to the color tokens above | First-class color utilities (e.g. `bg-bg-raised`, `text-score-excellent`) |

The `@theme inline` block bridges colors into Tailwind without duplicating values.
See section 6.4 for the full mechanism.

### 1.1 Colors — Surfaces

4-level depth hierarchy. Each level is visually "above" the previous one.

| Token          | Dark      | Light     | Usage                              |
| -------------- | --------- | --------- | ---------------------------------- |
| `--bg-base`    | `#0C0E12` | `#FAF9F7` | Page background                    |
| `--bg-raised`  | `#12151B` | `#FFFFFF` | Cards, panels                      |
| `--bg-overlay` | `#1A1D25` | `#F3F1ED` | Dropdowns, popovers, modals        |
| `--bg-hover`   | `#22252F` | `#EBE9E4` | 4th surface level (hover for overlay) |

**Hover lookup table** — hover always shifts surface exactly one level up:

| Host surface   | Hover to       | Tailwind class         |
| -------------- | -------------- | ---------------------- |
| `bg-base`      | `bg-raised`    | `hover:bg-bg-raised`   |
| `bg-raised`    | `bg-overlay`   | `hover:bg-bg-overlay`  |
| `bg-overlay`   | `bg-hover`     | `hover:bg-bg-hover`    |

Never skip levels (e.g. base → overlay on hover is wrong).

### 1.2 Colors — Text

3-level hierarchy for information density control.

| Token              | Dark      | Light     | Usage                          |
| ------------------ | --------- | --------- | ------------------------------ |
| `--text-primary`   | `#E8E9ED` | `#2C2C30` | Headings, values, primary data |
| `--text-secondary` | `#8B8FA3` | `#6E6E7A` | Labels, descriptions           |
| `--text-muted`     | `#555970` | `#A5A5B0` | Placeholders, disabled text    |

### 1.3 Colors — Accent

| Token          | Dark                       | Light                      | Usage                        |
| -------------- | -------------------------- | -------------------------- | ---------------------------- |
| `--accent`     | `#D4A041`                  | `#B08530`                  | Primary action, active state |
| `--accent-dim` | `rgba(212, 160, 65, 0.12)` | `rgba(176, 133, 48, 0.10)` | Active tab bg, subtle highlight |

### 1.4 Colors — Border

| Token      | Dark      | Light     | Usage                  |
| ---------- | --------- | --------- | ---------------------- |
| `--border` | `#1E2130` | `#E0DDD7` | Card borders, dividers |

### 1.5 Colors — Score Scale

5-point continuous scale for model evaluation scores.

Each score level has a foreground (text) and background (cell fill) token.

| Token                  | Dark                        | Light     |
| ---------------------- | --------------------------- | --------- |
| `--score-excellent`    | `#3DD68C`                   | `#2D7A4A` |
| `--score-excellent-bg` | `rgba(61, 214, 140, 0.18)`  | `#D5F0E2` |
| `--score-good`         | `#7BC67E`                   | `#4E8A52` |
| `--score-good-bg`      | `rgba(123, 198, 126, 0.13)` | `#E4F2E5` |
| `--score-mid`          | `#C9B44E`                   | `#8D7B2A` |
| `--score-mid-bg`       | `rgba(201, 180, 78, 0.13)`  | `#F5F0D8` |
| `--score-poor`         | `#D4763A`                   | `#A85E2A` |
| `--score-poor-bg`      | `rgba(212, 118, 58, 0.13)`  | `#F8E8D8` |
| `--score-fail`         | `#C94444`                   | `#A8393B` |
| `--score-fail-bg`      | `rgba(201, 68, 68, 0.13)`   | `#F8DEDE` |

**Usage:** text color = fg token, cell/badge background = bg token.

### 1.6 Colors — Lens

| Token               | Dark                        | Light     |
| ------------------- | --------------------------- | --------- |
| `--lens-ranking`    | `#6B8AFF`                   | `#7B96E8` |
| `--lens-ranking-bg` | `rgba(107, 138, 255, 0.12)` | `#E8EDFB` |
| `--lens-detail`     | `#5EC4B6`                   | `#6BB8AD` |
| `--lens-detail-bg`  | `rgba(94, 196, 182, 0.12)`  | `#DEF2EF` |

### 1.7 Typography

Fonts are loaded via `next/font` in `layout.tsx` which sets `--font-mono` and `--font-sans`
CSS variables on `<html>`. Do NOT redeclare font-family in `@theme` — it would override
the optimized font-face names from Next.js.

| Token (class)  | Font             | Usage                            |
| -------------- | ---------------- | -------------------------------- |
| `font-mono`    | JetBrains Mono   | Data, numbers, labels, scores    |
| `font-sans`    | DM Sans          | UI text, descriptions, paragraphs |

**Size scale** (defined in `@theme`):

| Token         | Size      | Usage                              |
| ------------- | --------- | ---------------------------------- |
| `text-xs`     | `0.625rem` (10px)  | Small labels, tertiary info  |
| `text-sm`     | `0.6875rem` (11px) | Secondary labels, metadata   |
| `text-base`   | `0.8125rem` (13px) | Body text, default           |
| `text-lg`     | `0.9375rem` (15px) | Section headings             |
| `text-xl`     | `1.125rem` (18px)  | Page sub-headings            |
| `text-2xl`    | `1.5rem` (24px)    | Hero values, stat numbers    |

**Typography patterns:**

| Pattern          | Classes                                                      |
| ---------------- | ------------------------------------------------------------ |
| Stat label       | `font-mono text-xs uppercase tracking-wider text-text-secondary` |
| Stat value       | `font-mono text-2xl font-semibold text-text-primary`         |
| Section heading  | `font-sans text-lg font-semibold text-text-primary`          |
| Body text        | `font-sans text-base text-text-secondary`                    |
| Table header     | `font-mono text-xs uppercase tracking-wider text-text-muted` |
| Table cell data  | `font-mono text-sm text-text-primary`                        |

### 1.8 Spacing

Tailwind v4 uses `--spacing` as a multiplier. We set it to `0.25rem` (4px) — the
standard Tailwind default, which aligns with the "Lab Instrument" 4px grid.

```css
@theme {
  --spacing: 0.25rem;
}
```

All spacing uses the standard Tailwind scale: `p-1` = 4px, `p-2` = 8px, `p-4` = 16px, etc.
No custom `sp-*` tokens needed. No arbitrary spacing values (`p-[13px]`).

### 1.9 Borders

| Property | Value        | Usage           |
| -------- | ------------ | --------------- |
| Radius   | `rounded-lg` (8px) | Cards, panels   |
| Radius   | `rounded-md` (6px) | Buttons, inputs |
| Radius   | `rounded-full`     | Pills, badges   |
| Width    | `border` (1px)     | Default         |
| Color    | `border-border`    | All borders     |

### 1.10 Shadows

Used only in light theme for subtle card elevation:

```css
@theme {
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.06);
}
```

Dark theme: no shadows (depth conveyed by surface color).

### 1.11 Motion

| Token             | Value    | Usage                         |
| ----------------- | -------- | ----------------------------- |
| `duration-fast`   | `100ms`  | Hover color changes           |
| `duration-normal` | `200ms`  | Theme switch, overlay appear  |
| `duration-slow`   | `300ms`  | Complex transitions           |
| `ease-out`        | `cubic-bezier(0.16, 1, 0.3, 1)` | Enter / appear  |
| `ease-in`         | `cubic-bezier(0.7, 0, 0.84, 0)` | Exit / disappear |

**Rules:**
- Hover transitions: `transition-colors duration-fast`
- Overlay appear: `transition-all duration-normal ease-out`
- `prefers-reduced-motion: reduce` — disable all transitions
- No decorative animations. No page transitions. No skeleton pulse.

---

## 2. Color System

### 2.1 Theme Architecture

Two themes: **dark** (default) and **light** (pastel). Same token names, different values.

```
html[data-theme='dark'], html:not([data-theme])  → dark values
html[data-theme='light']                          → light values
```

Theme switching is handled by `ThemeToggle` component (cycle: dark → light → system).
localStorage key: `litmus-theme`. Values: `"dark"`, `"light"`, `"system"`.

**`system` mode behavior:** When `litmus-theme` is `"system"`, the `ThemeToggle`
reads `window.matchMedia('(prefers-color-scheme: dark)')` and sets
`data-theme="dark"` or `data-theme="light"` on `<html>` accordingly.
The CSS selector `html:not([data-theme])` serves only as a flash-prevention
fallback for the initial page load before JS runs — it defaults to dark.
Once JS executes, `data-theme` is always explicitly set, so
`html:not([data-theme])` never applies during normal usage.

### 2.2 Surface Hierarchy

```
base (page bg)
  └── raised (cards, panels)
       └── overlay (dropdowns, popovers, modals)
            └── hover (interactive hover state)
```

**Rule:** a component's hover state is always the next surface level.
Never skip levels (e.g. base → overlay on hover is wrong).

### 2.3 Score Colors

Scores map to the 5-point continuous scale (thresholds are inclusive lower bounds):

| Threshold   | Token             | Meaning       |
| ----------- | ----------------- | ------------- |
| `>= 0.85`   | `score-excellent` | Outstanding   |
| `>= 0.65`   | `score-good`      | Above average |
| `>= 0.45`   | `score-mid`       | Average       |
| `>= 0.25`   | `score-poor`      | Below average |
| `< 0.25`    | `score-fail`      | Failing       |

Usage: `text-score-excellent` for text, `bg-score-excellent-bg` for background.
Combine both for heatmap cells and score badges.

### 2.4 Contrast Requirements

| Pair                        | Minimum ratio | Standard        |
| --------------------------- | ------------- | --------------- |
| `text-primary` on `bg-base`   | 4.5:1         | WCAG AA normal  |
| `text-primary` on `bg-raised` | 4.5:1         | WCAG AA normal  |
| `text-secondary` on `bg-base` | 4.5:1         | WCAG AA normal  |
| Score fg on score bg         | 3:1           | WCAG AA large/UI |
| `accent` on `bg-raised`       | 3:1           | WCAG AA UI      |

---

## 3. Component Architecture

### 3.1 Component Library: shadcn/ui + Radix

The project uses **shadcn/ui** as the foundation for primitive UI components.
shadcn/ui components are copy-pasted into the project (not installed as a dependency)
and are backed by **Radix UI** primitives for accessibility.

#### What we take from shadcn/ui

| Component   | Radix primitive    | Why                                      |
| ----------- | ------------------ | ---------------------------------------- |
| `Button`    | —                  | Unified variants, focus/disabled states  |
| `Dialog`    | `@radix-ui/dialog` | Focus trap, Escape close, ARIA           |
| `Tabs`      | `@radix-ui/tabs`   | Keyboard nav, ARIA roles                 |
| `Select`    | `@radix-ui/select` | Dropdown with keyboard nav               |
| `Table`     | —                  | Base table, styled for heatmap/leaderboard |
| `Tooltip`   | `@radix-ui/tooltip`| Hover hints for data-dense UI            |
| `Popover`   | `@radix-ui/popover`| Drill-down panels, breakdown popovers    |
| `Badge`     | —                  | Replaces current custom badge + variants |
| `Input`     | —                  | Settings/scenarios forms                 |
| `Checkbox`  | `@radix-ui/checkbox`| Selection in scenarios                  |
| `Skeleton`  | —                  | Loading states (static placeholder, use `animate-none` to disable pulse) |

#### What we build custom

| Component     | Why                                        |
| ------------- | ------------------------------------------ |
| `Heatmap`     | Unique data visualization, no shadcn analog |
| `ScoreBadge`  | 5-point score scale coloring               |
| `StatCard`    | Simpler than shadcn Card, already exists   |
| `NavBar`      | Unique pill navigation                     |

#### Theme Integration

shadcn/ui expects standard CSS variables (`--background`, `--foreground`, etc.).
We map them to Litmus tokens in `:root`. These names are part of the shadcn
contract — do NOT rename or prefix them.

**Collision avoidance:** Litmus defines `--accent` and `--border` as theme tokens.
shadcn uses the same names. Since shadcn resolves these through `@theme inline`
registration (section 6.4), we omit them from the `:root` bridge to avoid
circular references. All other shadcn variables have unique names that don't
collide with Litmus tokens.

```css
:root {
  /* shadcn bridge — standard shadcn variable names pointing to Litmus tokens */
  --background: var(--bg-base);
  --foreground: var(--text-primary);
  --primary: var(--accent);
  --primary-foreground: var(--bg-base);
  --secondary: var(--bg-overlay);
  --secondary-foreground: var(--text-primary);
  --muted: var(--bg-overlay);
  --muted-foreground: var(--text-secondary);
  --destructive: var(--score-fail);
  --input: var(--bg-overlay);
  --ring: var(--accent);
  --card: var(--bg-raised);
  --card-foreground: var(--text-primary);
  --popover: var(--bg-overlay);
  --popover-foreground: var(--text-primary);
  /* --accent and --border are NOT mapped here — they are registered
     directly via @theme inline (section 6.4), avoiding circular refs. */
}
```

### 3.2 File Structure

```
web/src/components/
  ui/                  — shadcn/ui primitives + custom primitives
    button.tsx
    badge.tsx
    card.tsx
    dialog.tsx
    tabs.tsx
    ...
  compare/             — Compare screen domain components
    heatmap.tsx
    heatmap-cell.tsx
    leaderboard.tsx
    ...
  progress/            — Run progress domain components
  scenarios/           — Scenarios domain components
  settings/            — Settings domain components
  nav-bar.tsx          — App-level components (shared)
  stat-card.tsx
  theme-toggle.tsx
```

**Rules:**
- One component per file
- `ui/` — primitives (no business logic, data via props only)
- `<domain>/` — composed components (may use hooks, context, API calls)
- App-level shared components live at `components/` root

### 3.3 Component Anatomy

Every component follows this pattern:

```typescript
// 1. Imports
import { type ComponentProps } from "react";

// 2. Props interface — TypeScript, semantic names
interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: "up" | "down" | "flat";
  className?: string;  // Allow composition via className override
}

// 3. Named export (never default export)
export function MetricCard({ label, value, trend = "flat", className }: MetricCardProps) {
  return (
    // 4. Tailwind v4 utilities with @theme tokens
    <div className={cn("rounded-lg border border-border bg-bg-raised p-4", className)}>
      {/* 5. Typography: font-mono for data, font-sans for UI */}
      <span className="font-mono text-xs uppercase tracking-wider text-text-secondary">
        {label}
      </span>
      <span className="font-mono text-2xl font-semibold text-text-primary">
        {value}
      </span>
    </div>
  );
}
```

### 3.4 States

Every interactive component must implement these states:

| State    | Implementation                                                            |
| -------- | ------------------------------------------------------------------------- |
| default  | Base styles                                                               |
| hover    | Surface one level up (see hover lookup table in section 1.1)              |
| focus    | `focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none` |
| active   | `active:scale-[0.98]` (subtle press feedback — exception to "no arbitrary values" rule) |
| disabled | `opacity-50 pointer-events-none`                                          |

**Important:** use `focus-visible`, not `focus`. This shows the ring only for keyboard
navigation, not mouse clicks.

### 3.5 Variants

Use union types in props, not boolean flags:

```typescript
// GOOD
variant?: "default" | "accent" | "success" | "warning" | "error";

// BAD
isAccent?: boolean;
isSuccess?: boolean;
```

### 3.6 Composition

- **Max 3 levels:** page → section → primitive
- Primitives accept `className` prop for one-off overrides
- Use `cn()` utility (from `clsx` + `tailwind-merge`) for class merging
- Compose via children or render props, not wrapper inheritance

---

## 4. Layout Patterns

### 4.1 Page Shell

```
┌─────────────────────────────────────────────┐
│  NavBar (pill navigation, full width)        │
├─────────────────────────────────────────────┤
│                                             │
│  Page Content (full width, padded)          │
│                                             │
└─────────────────────────────────────────────┘
```

- No **app-level** sidebar. Navigation is horizontal (pill tabs), giving full width to content.
- Individual pages may use a **page-level** sidebar as a grid column (e.g. Compare: `grid-cols-[280px_1fr]`).
  This is a content layout choice, not a persistent navigation element.
- NavBar: horizontal pill tabs with active indicator (`bg-accent-dim`, `text-accent`)
- Page padding: `px-6 py-4` (24px horizontal, 16px vertical)

### 4.2 Grid System

CSS Grid for all page layouts. Common patterns:

| Pattern          | Grid                                                    | Screen   |
| ---------------- | ------------------------------------------------------- | -------- |
| Stats row        | `grid grid-cols-4 gap-4`                                | Dashboard |
| Card grid        | `grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4` | Scenarios |
| Sidebar + main   | `grid grid-cols-[280px_1fr] gap-6`                      | Compare  |
| Full width       | `grid grid-cols-1 gap-4`                                | Detail   |

### 4.3 Responsive

**Target:** desktop 1280px+ (optimum), minimum 1024px. No mobile support.

| Breakpoint  | Behavior                                    |
| ----------- | ------------------------------------------- |
| `>= 1280px` | Full layout, all columns                   |
| `1024–1279px` | Reduce grid columns (4→3 for stats, sidebar narrows) |
| `< 1024px`  | Not supported (show "desktop required" message) |

**Rules:**
- No horizontal scroll at 1280px
- Grid columns reduce gracefully at 1024px
- No `@media` below 1024px except for the unsupported message
- Use `min-w-[1024px]` on layout root if needed

### 4.4 Spacing Rhythm

- **Page padding:** `px-6 py-4`
- **Section gap:** `gap-6` (24px) between major sections
- **Card internal:** `p-4` (16px)
- **Element gap:** `gap-2` (8px) between related elements
- **Tight gap:** `gap-1` (4px) between label and value

### 4.5 Grid Background

Subtle graph-paper texture on `body::before`:

```css
background-image:
  linear-gradient(var(--border) 1px, transparent 1px),
  linear-gradient(90deg, var(--border) 1px, transparent 1px);
background-size: 40px 40px;
opacity: 0.3;
```

Reinforces the "lab instrument" aesthetic. Fixed position, z-index: -1.

### 4.6 Z-Index Scale

| Token    | Value | Usage                              |
| -------- | ----- | ---------------------------------- |
| `z-base` | `0`   | Default content                    |
| `z-10`   | `10`  | Sticky headers, floating elements  |
| `z-20`   | `20`  | Dropdowns, popovers, tooltips      |
| `z-30`   | `30`  | NavBar (if sticky)                 |
| `z-40`   | `40`  | Modal backdrop                     |
| `z-50`   | `50`  | Modal content, dialogs             |

Grid background uses `z-[-1]` (allowed exception — no scale value for negative z-index).

### 4.7 Icons

**Library:** [Lucide React](https://lucide.dev/) — consistent stroke-based icons,
tree-shakeable, standard in shadcn/ui ecosystem.

```typescript
import { Settings, ChevronDown, X } from "lucide-react";
```

**Sizing convention:**

| Context         | Size class       | Pixels |
| --------------- | ---------------- | ------ |
| Inline (text)   | `size-4`         | 16px   |
| Button icon     | `size-4`         | 16px   |
| Standalone      | `size-5`         | 20px   |
| Large / hero    | `size-6`         | 24px   |

**Color:** icons inherit text color. Use `text-text-secondary` for decorative,
`text-text-primary` for actionable.

---

## 5. Accessibility Baseline

### 5.1 Focus Management

All interactive elements: `focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none`

**Never** use `outline-none` without a `focus-visible:ring` replacement.

### 5.2 ARIA Roles

| Component   | Required ARIA                                          |
| ----------- | ------------------------------------------------------ |
| Tab bar     | `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"` |
| Dialog      | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` |
| Icon button | `aria-label="<action>"` (mandatory, no exceptions)     |
| Score badge | `aria-label="Score: <value> (<level>)"`                |
| Heatmap cell| `aria-label="<model> on <scenario>: <score>"`          |

shadcn/ui + Radix handles most of these automatically. For custom components,
add ARIA manually.

### 5.3 Keyboard Navigation

| Key          | Action                           |
| ------------ | -------------------------------- |
| `Tab`        | Move to next focusable element   |
| `Shift+Tab`  | Move to previous                 |
| `Enter`/`Space` | Activate focused element      |
| `Escape`     | Close overlay / deselect         |
| `Arrow Left`/`Right` | Navigate within tab bar  |

Tab order follows visual order (no `tabindex` > 0).

### 5.4 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 6. Implementation Notes

### 6.1 @theme Token Definition

`globals.css` has three distinct blocks (see section 1 for the overview):

**Block 1: `@theme` — static tokens** (theme-independent, same in dark and light):

```css
@import 'tailwindcss';

@theme {
  /* Typography scale */
  --text-xs: 0.625rem;
  --text-sm: 0.6875rem;
  --text-base: 0.8125rem;
  --text-lg: 0.9375rem;
  --text-xl: 1.125rem;
  --text-2xl: 1.5rem;

  /* Spacing base */
  --spacing: 0.25rem;

  /* Motion */
  --duration-fast: 100ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);

  /* Shadows */
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.06);
}
```

**Block 2: Theme selectors** — color tokens (different per theme):

```css
html[data-theme='dark'], html:not([data-theme]) {
  --bg-base: #0C0E12;
  --bg-raised: #12151B;
  /* ... all color tokens */
}
html[data-theme='light'] {
  --bg-base: #FAF9F7;
  --bg-raised: #FFFFFF;
  /* ... all color tokens */
}
```

**Block 3: `@theme inline`** — registers color tokens as Tailwind utilities
(see section 6.4 for details).

Colors MUST NOT go into `@theme` because they change per theme.
`@theme` is strictly for static, theme-independent values.

### 6.2 Fonts

Fonts are loaded via `next/font` in `layout.tsx`:

```typescript
import { JetBrains_Mono, DM_Sans } from "next/font/google";

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const sans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });

// Applied to <html className={`${mono.variable} ${sans.variable}`}>
```

Do NOT redeclare `--font-mono` / `--font-sans` in CSS. Next.js handles this.

### 6.3 cn() Utility

Use `cn()` from `clsx` + `tailwind-merge` for merging Tailwind classes:

```typescript
// web/src/lib/utils.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

This is the standard shadcn/ui pattern and resolves Tailwind class conflicts.

### 6.4 Theme-aware Colors — How They Become Utility Classes

Color tokens are theme-dependent (different values in dark/light), so they
live in CSS theme selectors, NOT in the `@theme` block. There are two ways
to use them as Tailwind utilities:

**1. shadcn variable bridge (primary approach):**

The `:root` mapping (section 3.1) creates standard shadcn CSS variables
(`--background`, `--card`, `--muted`, etc.) that point to our Litmus tokens.
shadcn/ui components and general usage go through these:
`bg-background`, `bg-card`, `text-muted-foreground`, `border-border`, etc.

**2. `@theme inline` for Litmus-specific tokens:**

For tokens not covered by the shadcn bridge (score colors, lens colors,
surface hierarchy), register them with `@theme inline`:

```css
@theme inline {
  --color-bg-base: var(--bg-base);
  --color-bg-raised: var(--bg-raised);
  --color-bg-overlay: var(--bg-overlay);
  --color-bg-hover: var(--bg-hover);
  --color-text-primary: var(--text-primary);
  --color-text-secondary: var(--text-secondary);
  --color-text-muted: var(--text-muted);
  --color-accent: var(--accent);
  --color-accent-dim: var(--accent-dim);
  --color-score-excellent: var(--score-excellent);
  --color-score-excellent-bg: var(--score-excellent-bg);
  /* ... same pattern for all score, lens tokens */
}
```

`@theme inline` tells Tailwind "these are theme tokens, generate utilities"
but does NOT add them to the CSS output (since the actual values are already
in the theme selectors). This gives us utility classes like `bg-bg-raised`,
`text-score-excellent`, `bg-score-fail-bg` without duplicating values.

**Summary of class resolution:**

| Need                     | Use                          | Example                    |
| ------------------------ | ---------------------------- | -------------------------- |
| General surface/text     | shadcn bridge                | `bg-card`, `text-foreground` |
| Litmus-specific surface  | `@theme inline` token        | `bg-bg-raised`, `bg-bg-overlay` |
| Score/lens colors        | `@theme inline` token        | `text-score-excellent`, `bg-lens-ranking-bg` |
| Accent                   | Either                       | `bg-primary` or `bg-accent` |

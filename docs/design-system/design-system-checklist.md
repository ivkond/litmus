# Litmus Design System — Review Checklist

> **Audience:** AI review agents. Each rule is a pass/fail check.
> References point to sections in `design-system-spec.md`.
>
> **How to use:** Run through every category. A single FAIL blocks merge.
> Report all findings, not just the first failure.

---

## 1. Tokens

- [ ] **No hardcoded colors.** Every color value uses a semantic token class (`bg-bg-raised`, `text-accent`, `text-score-excellent`), never a raw hex/rgb/hsl value. → [spec: 1.1–1.6]
- [ ] **No hardcoded font sizes.** All font sizes from the `@theme` scale (`text-xs` through `text-2xl`), no arbitrary `text-[14px]`. → [spec: 1.7]
- [ ] **No arbitrary spacing.** All padding/margin/gap from the standard Tailwind 4px scale (`p-4`, `gap-2`), no arbitrary `p-[13px]`. → [spec: 1.8]
- [ ] **Border tokens.** Borders use `border-border` for color, `rounded-lg`/`rounded-md`/`rounded-full` for radius. No hardcoded border colors. → [spec: 1.9]
- [ ] **Motion tokens.** Transitions use `duration-fast`/`duration-normal`/`duration-slow`. No arbitrary `duration-[250ms]`. → [spec: 1.11]

## 2. Typography

- [ ] **Data in mono.** All numbers, scores, metrics, labels, table headers use `font-mono`. → [spec: 1.7]
- [ ] **UI text in sans.** Descriptions, paragraphs, help text use `font-sans`. → [spec: 1.7]
- [ ] **Label pattern.** Labels follow: `font-mono text-xs uppercase tracking-wider text-text-secondary`. → [spec: 1.7]
- [ ] **No font-bold on body.** Body text never uses `font-bold`. Only `font-semibold` on headings and stat values. → [spec: 1.7]
- [ ] **Font not redeclared.** `--font-mono` and `--font-sans` are NOT redeclared in CSS — Next.js `next/font` handles this. → [spec: 6.2]

## 3. Colors & Theme

- [ ] **Both themes work.** Component uses only theme-aware tokens (no hardcoded colors). Verify: toggle `data-theme` between `dark` and `light` — all text remains readable, no invisible elements, no unchanged colors. → [spec: 2.1]
- [ ] **Surface hierarchy.** Surfaces follow the 4-level depth: base → raised → overlay → hover. No skipped levels. → [spec: 2.2]
- [ ] **Hover surface rule.** Hover state shifts surface exactly one level up per lookup table: base→raised, raised→overlay, overlay→hover. → [spec: 1.1, 2.2]
- [ ] **Score colors semantic.** Score values use `score-excellent`/`good`/`mid`/`poor`/`fail` tokens, never arbitrary colors. → [spec: 2.3]
- [ ] **Contrast ratios.** Text on surfaces ≥ 4.5:1. Score fg on score bg ≥ 3:1. Accent on surfaces ≥ 3:1. → [spec: 2.4]

## 4. Component Structure

- [ ] **One file per component.** Each component lives in its own `.tsx` file. → [spec: 3.2]
- [ ] **Props interface.** Props defined as `interface <Name>Props`. → [spec: 3.3]
- [ ] **Named export.** Components use named exports, never `export default`. → [spec: 3.3]
- [ ] **Variants via union.** Variants are union types in props (`"default" | "accent"`), not boolean flags. → [spec: 3.5]
- [ ] **File location.** Primitives in `ui/`, domain components in `<domain>/`, shared at root. → [spec: 3.2]
- [ ] **className prop.** Components accept optional `className` for composition. Uses `cn()` for merging. → [spec: 3.3, 3.6]

## 5. States

- [ ] **All states present.** Interactive elements have: hover, focus-visible, active, disabled. → [spec: 3.4]
- [ ] **Focus ring.** Focus uses `focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none`. → [spec: 3.4]
- [ ] **No bare outline-none.** `outline-none` never appears without `focus-visible:ring`. → [spec: 5.1]
- [ ] **Disabled style.** Disabled state uses `opacity-50 pointer-events-none`. → [spec: 3.4]
- [ ] **Active feedback.** Clickable elements have `active:scale-[0.98]` (allowed exception to "no arbitrary values" rule). → [spec: 3.4]

## 6. Layout

- [ ] **CSS Grid.** Page layouts use CSS Grid, no absolute/fixed positioning for content layout (allowed for decorative layers like grid background and sticky/fixed UI chrome). → [spec: 4.2]
- [ ] **No horizontal scroll at 1280px.** Content fits without horizontal overflow at 1280px viewport width. → [spec: 4.3]
- [ ] **Graceful at 1024px.** Layout remains usable (reduced columns) at 1024px. → [spec: 4.3]
- [ ] **Page padding.** Page content uses `px-6 py-4`. → [spec: 4.1]
- [ ] **Spacing rhythm.** Section gap: `gap-6`. Card internal: `p-4`. Element gap: `gap-2`. Label-value: `gap-1`. → [spec: 4.4]
- [ ] **Z-index scale.** Overlays use the z-index scale (dropdowns z-20, modals z-50). No arbitrary z-index values except `z-[-1]` for grid background. → [spec: 4.6]

## 7. Accessibility

- [ ] **ARIA on tabs.** Tab bars have `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"`. → [spec: 5.2]
- [ ] **ARIA on dialogs.** Dialogs have `role="dialog"`, `aria-modal`, `aria-labelledby`. → [spec: 5.2]
- [ ] **Icon buttons labeled.** Every icon-only button has `aria-label`. → [spec: 5.2]
- [ ] **Keyboard works.** Tab/Enter/Space/Escape function as expected. → [spec: 5.3]
- [ ] **Tab order = visual order.** No `tabindex` greater than 0. → [spec: 5.3]

## 8. Motion

- [ ] **Only allowed animations.** Only hover transitions and overlay fade/scale. No decorative animations. → [spec: 1.11]
- [ ] **Reduced motion.** `prefers-reduced-motion` media query disables all transitions. → [spec: 5.4]
- [ ] **Correct easing.** Enter uses ease-out, exit uses ease-in. → [spec: 1.11]

## 9. Dependencies

- [ ] **shadcn/ui used where available.** Dialog, Tabs, Select, Popover, Tooltip, Checkbox use shadcn/ui + Radix, not custom implementations. → [spec: 3.1]
- [ ] **Custom only for domain-specific.** Custom components (Heatmap, ScoreBadge, StatCard, NavBar) exist only because no shadcn analog exists. → [spec: 3.1]
- [ ] **Theme bridge.** shadcn CSS variables (`--background`, `--foreground`, etc.) are mapped to Litmus tokens. No hardcoded values in shadcn components. → [spec: 3.1]
- [ ] **cn() utility.** Class merging uses `cn()` from `clsx` + `tailwind-merge`, not string concatenation. → [spec: 6.3]
- [ ] **Icons from Lucide.** Icons imported from `lucide-react`. Sized with `size-4`/`size-5`/`size-6`. → [spec: 4.7]
- [ ] **Skeleton without animation.** Loading skeletons use shadcn `Skeleton` without pulse animation (`animate-none`). → [spec: 3.1]

---

## Quick Reference: Common Violations

| Violation | What to look for | Fix |
| --------- | ---------------- | --- |
| Hardcoded color | `bg-[#1A1D25]`, `text-[#8B8FA3]` | Replace with token: `bg-bg-overlay`, `text-text-secondary` |
| Wrong font | Numbers in `font-sans` | Switch to `font-mono` |
| Missing focus | Interactive element without `focus-visible:ring` | Add full focus pattern |
| Bare outline-none | `outline-none` without ring | Add `focus-visible:ring-2 focus-visible:ring-accent` |
| Boolean variant | `isActive?: boolean` | Change to `variant?: "default" \| "active"` |
| Arbitrary spacing | `mt-[22px]` | Use nearest scale value: `mt-5` (20px) or `mt-6` (24px) |
| Default export | `export default function` | Use `export function` (named) |
| Custom Dialog | Hand-rolled modal | Use shadcn `Dialog` (Radix-backed) |

import { beforeAll, describe, it, expect, vi } from 'vitest';

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

  it('NAV_ITEMS routes are all unique', async () => {
    const mod = await import('../nav-bar');
    const hrefs = mod.NAV_ITEMS.map((item: { href: string }) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('NAV_ITEMS routes all start with /', async () => {
    const mod = await import('../nav-bar');
    for (const item of mod.NAV_ITEMS) {
      expect(item.href).toMatch(/^\//);
    }
  });

  it('NAV_ITEMS labels are non-empty strings', async () => {
    const mod = await import('../nav-bar');
    for (const item of mod.NAV_ITEMS) {
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

// Source-level contract tests: verify key behavioral patterns exist in the
// source code. These catch regressions (e.g. someone removes aria-label)
// without needing jsdom rendering.
describe('NavBar source contracts', () => {
  let source: string;

  beforeAll(async () => {
    const fs = await import('fs');
    const path = await import('path');
    source = fs.readFileSync(
      path.resolve(__dirname, '../nav-bar.tsx'),
      'utf-8',
    );
  });

  it('hamburger button has aria-label', () => {
    expect(source).toContain('aria-label=');
  });

  it('hamburger button has aria-expanded', () => {
    expect(source).toContain('aria-expanded=');
  });

  it('hamburger button has aria-controls pointing to mobile-menu', () => {
    expect(source).toContain('aria-controls="mobile-menu"');
  });

  it('mobile menu has id matching aria-controls', () => {
    expect(source).toContain('id="mobile-menu"');
  });

  it('registers Escape key handler', () => {
    expect(source).toContain("e.key === 'Escape'");
  });

  it('registers click-outside handler via mousedown', () => {
    expect(source).toContain("addEventListener('mousedown'");
  });

  it('mobile links have onClick close handler', () => {
    // The mobile Link items must have onClick={() => setIsOpen(false)}
    expect(source).toContain('onClick={() => setIsOpen(false)}');
  });

  it('mobile links have min touch target height', () => {
    expect(source).toContain('min-h-[44px]');
  });

  it('uses md: breakpoint for responsive split', () => {
    expect(source).toContain('md:hidden');
    expect(source).toContain('hidden md:flex');
  });
});

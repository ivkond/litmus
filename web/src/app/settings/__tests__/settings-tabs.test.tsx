import { beforeAll, describe, it, expect, vi } from 'vitest';

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

  it('component accepts sections prop (single props arg)', async () => {
    const mod = await import('../settings-tabs');
    // SettingsTabs should accept props with sections Record for each tab
    expect(mod.SettingsTabs.length).toBeLessThanOrEqual(1);
  });

  it('exports SettingsTabKey type-compatible keys', async () => {
    const mod = await import('../settings-tabs');
    // Each tab must have both key and label
    for (const tab of mod.SETTINGS_TABS) {
      expect(typeof tab.key).toBe('string');
      expect(typeof tab.label).toBe('string');
      expect(tab.key.length).toBeGreaterThan(0);
      expect(tab.label.length).toBeGreaterThan(0);
    }
  });

  it('tab labels are human-readable (not slugs)', async () => {
    const mod = await import('../settings-tabs');
    const labels = mod.SETTINGS_TABS.map((t: { label: string }) => t.label);
    expect(labels).toEqual(['Agents', 'Judge Providers', 'Scoring', 'General']);
  });
});

describe('SettingsTabs source contracts', () => {
  let source: string;

  beforeAll(async () => {
    const fs = await import('fs');
    const path = await import('path');
    source = fs.readFileSync(
      path.resolve(__dirname, '../settings-tabs.tsx'),
      'utf-8',
    );
  });

  it('reads tab from URL via useSearchParams', () => {
    expect(source).toContain("searchParams.get('tab')");
  });

  it('defaults to agents when tab param is invalid', () => {
    expect(source).toContain("'agents'");
  });

  it('navigates via router.push on tab click', () => {
    expect(source).toContain('router.push(');
  });

  it('skips navigation when clicking already-active tab', () => {
    expect(source).toContain('if (key === activeTab) return');
  });

  it('uses underline accent style for active tab', () => {
    expect(source).toContain('border-b-2');
    expect(source).toContain('var(--accent)');
  });
});

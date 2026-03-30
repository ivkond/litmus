import { describe, it, expect, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: vi.fn(({ children }) => children),
}));

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
    // Generate 200 valid-format UUIDs
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

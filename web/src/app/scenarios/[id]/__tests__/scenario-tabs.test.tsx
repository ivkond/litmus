import { describe, it, expect } from 'vitest';

describe('ScenarioTabs', () => {
  it('exports ScenarioTabs as a named function', async () => {
    const mod = await import('../scenario-tabs');
    expect(typeof mod.ScenarioTabs).toBe('function');
  });

  it('has the expected function signature (single props arg)', async () => {
    const { ScenarioTabs } = await import('../scenario-tabs');
    expect(ScenarioTabs.length).toBeLessThanOrEqual(1);
  });
});

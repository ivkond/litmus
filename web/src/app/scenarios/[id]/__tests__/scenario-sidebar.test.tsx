import { describe, it, expect } from 'vitest';

describe('ScenarioSidebar', () => {
  it('exports ScenarioSidebar as a named function', async () => {
    const mod = await import('../scenario-sidebar');
    expect(typeof mod.ScenarioSidebar).toBe('function');
  });

  it('accepts Props with data: ScenarioDetailResponse and returns JSX', async () => {
    const { ScenarioSidebar } = await import('../scenario-sidebar');
    const data = {
      id: 'sc-1', slug: 'test', name: 'Test',
      description: null, version: 'v1', language: 'python',
      tags: ['algo'], maxScore: 100,
      prompt: 'Do the thing', task: null, scoring: null,
      createdAt: '2026-03-29',
      files: [],
      usage: { totalRuns: 5, avgScore: 78, bestScore: 95, worstScore: 40 },
    };
    const result = ScenarioSidebar({ data });
    expect(result).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  sql: Object.assign(vi.fn().mockResolvedValue([]), {
    unsafe: vi.fn().mockReturnValue(vi.fn()),
  }),
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id', slug: 'slug' },
}));

vi.mock('@/lib/s3', () => ({
  listFiles: vi.fn().mockResolvedValue([]),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

describe('fetchScenarioList', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns empty array when no scenarios exist', async () => {
    const { fetchScenarioList } = await import('../queries');
    const result = await fetchScenarioList();
    expect(result).toEqual([]);
  });

  it('returns ScenarioListItem[] shape with usage stats', async () => {
    const { sql } = await import('@/db');
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: '123',
        slug: 'test-scenario',
        name: 'Test Scenario',
        description: 'A test',
        version: 'v1',
        language: 'python',
        tags: ['algo'],
        max_score: 100,
        created_at: '2026-03-29T00:00:00Z',
        total_runs: '5',
        avg_score: '78.5',
      },
    ]);

    const { fetchScenarioList } = await import('../queries');
    const result = await fetchScenarioList();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: '123',
      slug: 'test-scenario',
      name: 'Test Scenario',
      description: 'A test',
      version: 'v1',
      language: 'python',
      tags: ['algo'],
      maxScore: 100,
      createdAt: '2026-03-29T00:00:00Z',
      totalRuns: 5,
      avgScore: 78.5,
    });
  });
});

describe('fetchScenarioDetail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null when scenario not found', async () => {
    const { fetchScenarioDetail } = await import('../queries');
    const result = await fetchScenarioDetail('non-existent');
    expect(result).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

type SqlRows = Array<Record<string, unknown>>;

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: (() => {
    const tagged = vi.fn<(...args: unknown[]) => Promise<SqlRows>>(() => Promise.resolve([]));
    const unsafe = vi.fn<(query: string) => Promise<SqlRows>>(() => Promise.resolve([]));
    return Object.assign(tagged, { unsafe });
  })(),
}));

vi.mock('@/db', () => ({
  sql: sqlMock,
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue(Promise.resolve([])),
        }),
        orderBy: vi.fn().mockReturnValue(Promise.resolve([])),
      }),
    }),
  },
}));

import { fetchCompareData } from '../queries';

describe('fetchCompareData', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    sqlMock.mockResolvedValue([]);
    sqlMock.unsafe.mockResolvedValue([]);
  });

  it('returns empty leaderboard and heatmap for model-ranking when no data', async () => {
    const result = await fetchCompareData({ lens: 'model-ranking' });

    expect(result.lens).toBe('model-ranking');
    expect(result.leaderboard).toEqual([]);
    expect(result.heatmap.rows).toEqual([]);
    expect(result.heatmap.columns).toEqual([]);
    expect(result.heatmap.cells).toEqual({});
  });

  it('canonicalizes agent-x-models to the first available agent when agentId is missing', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]);
    sqlMock.unsafe.mockResolvedValueOnce([{ id: 'agent-1', name: 'Cursor' }]);

    const result = await fetchCompareData({ lens: 'agent-x-models' });

    expect(result.canonicalParams).toEqual({
      lens: 'agent-x-models',
      agentId: 'agent-1',
    });
  });

  it('surfaces error-only cells for detailed lenses instead of treating them as empty', async () => {
    sqlMock
      .mockResolvedValueOnce([{ cnt: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          entity_id: 'model-1',
          entity_name: 'GPT-4o',
          scenario_id: 'scenario-2',
          error_count: 2,
        },
      ])
      .mockResolvedValueOnce([
        { id: 'scenario-1', slug: 'todo-app', name: 'Todo App' },
        { id: 'scenario-2', slug: 'chat-app', name: 'Chat App' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    sqlMock.unsafe.mockResolvedValueOnce([{ id: 'agent-1', name: 'Cursor' }]);

    const result = await fetchCompareData({ lens: 'agent-x-models', agentId: 'agent-1' });

    expect(result.heatmap.rows).toEqual([
      expect.objectContaining({ id: 'model-1', name: 'GPT-4o' }),
    ]);
    expect(result.heatmap.cells['model-1']['scenario-2']).toEqual(expect.objectContaining({
      errorOnly: true,
      errorCount: 2,
    }));
  });

  it('returns empty participants arrays when no data (model-ranking)', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]);
    sqlMock.unsafe.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
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
});

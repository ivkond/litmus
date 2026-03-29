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
});

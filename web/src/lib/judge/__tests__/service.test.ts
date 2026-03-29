import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db');
vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(() => ({
    xadd: vi.fn().mockResolvedValue('1-0'),
    set: vi.fn().mockResolvedValue('OK'),
  })),
}));
vi.mock('@/lib/judge/context', () => ({
  assembleContext: vi.fn().mockResolvedValue({
    scenario: { prompt: 'test', scoringCriteria: [] },
    execution: { initLog: '', agentLog: 'log', testLog: '', testResults: { passed: 5, total: 10, details: [] } },
    artifacts: { files: [] },
    meta: { agent: 'a', model: 'm', attempt: 1, maxAttempts: 3, durationSeconds: 10 },
  }),
}));

describe('JudgeService', () => {
  it('exports enqueue function', async () => {
    const mod = await import('../service');
    expect(typeof mod.enqueueJudgeTasks).toBe('function');
  });

  it('skips evaluation when no providers are enabled', async () => {
    const { db } = await import('@/db');
    const orderByMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    (db as unknown as Record<string, unknown>).select = vi.fn().mockReturnValue({ from: fromMock });

    const updateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    (db as unknown as Record<string, unknown>).update = updateMock;

    const { enqueueJudgeTasks } = await import('../service');
    await enqueueJudgeTasks('test-run-result-id');

    // Should call update with judgeStatus='skipped'
    expect(updateMock).toHaveBeenCalled();
  });
});

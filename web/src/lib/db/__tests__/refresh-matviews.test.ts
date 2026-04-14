import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  db: { execute: vi.fn().mockResolvedValue(undefined) },
}));

const mockRedis = {
  set: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  get: vi.fn().mockResolvedValue(null),
};

vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(() => mockRedis),
}));

describe('tryRefreshMatviews', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips refresh when lock is held by another worker', async () => {
    mockRedis.set.mockResolvedValueOnce(null);
    const { tryRefreshMatviews } = await import('../refresh-matviews');
    const refreshed = await tryRefreshMatviews();
    expect(refreshed).toBe(false);
  });

  it('refreshes when lock is acquired', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    const { db } = await import('@/db');
    const { tryRefreshMatviews } = await import('../refresh-matviews');
    const refreshed = await tryRefreshMatviews();
    expect(refreshed).toBe(true);
    expect(db.execute).toHaveBeenCalled();
  });
});

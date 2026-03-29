import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(() => ({
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    xadd: vi.fn().mockResolvedValue('1-0'),
    xdel: vi.fn().mockResolvedValue(1),
    xack: vi.fn().mockResolvedValue(1),
    xpending: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn() }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn() }),
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
}));

describe('reclaimStaleTasks', () => {
  it('is exported as a function', async () => {
    const mod = await import('../reclaim');
    expect(typeof mod.reclaimStaleTasks).toBe('function');
  });
});

describe('cleanupStaleVerdicts', () => {
  it('is exported as a function', async () => {
    const mod = await import('../cleanup');
    expect(typeof mod.cleanupStaleVerdicts).toBe('function');
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/scenarios/queries', () => ({
  fetchScenarioDetail: vi.fn().mockResolvedValue(null),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
}));

describe('ScenarioDetailPage', () => {
  it('calls notFound() when scenario does not exist', async () => {
    const { default: ScenarioDetailPage } = await import('../page');
    await expect(
      ScenarioDetailPage({ params: Promise.resolve({ id: 'non-existent' }) }),
    ).rejects.toThrow('NOT_FOUND');
  });
});

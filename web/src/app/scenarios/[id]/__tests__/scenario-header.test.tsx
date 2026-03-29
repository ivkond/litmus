import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

describe('ScenarioHeader', () => {
  it('exports ScenarioHeader as a named function', async () => {
    const mod = await import('../scenario-header');
    expect(typeof mod.ScenarioHeader).toBe('function');
  });

  it('has the expected function signature (single props arg)', async () => {
    const { ScenarioHeader } = await import('../scenario-header');
    expect(ScenarioHeader.length).toBeLessThanOrEqual(1);
  });
});

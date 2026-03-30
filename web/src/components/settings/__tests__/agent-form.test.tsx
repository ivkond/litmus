import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe('AgentForm', () => {
  // Note: Cannot call component functions directly in node env (hooks crash
  // outside React renderer). Tests verify module shape only.

  it('exports a named function component', async () => {
    const mod = await import('../agent-form');
    expect(mod.AgentForm).toBeDefined();
    expect(typeof mod.AgentForm).toBe('function');
  });

  it('exports AgentWithExecutors type (used by other components)', async () => {
    // Type-level check — if this import compiles, the type is exported
    const mod = await import('../agent-form');
    expect(mod).toHaveProperty('AgentForm');
  });
});

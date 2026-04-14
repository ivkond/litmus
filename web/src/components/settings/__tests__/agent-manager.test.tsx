import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe('AgentManager', () => {
  it('exports a named function component', async () => {
    const mod = await import('../agent-manager');
    expect(mod.AgentManager).toBeDefined();
    expect(typeof mod.AgentManager).toBe('function');
  });
});

// Note: Component behavior (CRUD, health check, model discovery) is tested
// via the backend API contract tests in api/agents/__tests__/ and via
// manual visual verification. React components with hooks cannot be unit-tested
// in node environment without jsdom + testing-library.

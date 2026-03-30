import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const result = Promise.resolve([]);
          (result as unknown as Record<string, unknown>).limit = vi.fn().mockResolvedValue([]);
          return result;
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { agentId: 'agentExecutors.agentId', id: 'agentExecutors.id', name: 'agentExecutors' },
  runResults: { agentId: 'run_results.agentId', name: 'run_results' },
}));

describe('PUT /api/agents/[id] — not found', () => {
  it('returns 404 when agent does not exist', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'missing' }) });

    expect(response.status).toBe(404);
  });
});

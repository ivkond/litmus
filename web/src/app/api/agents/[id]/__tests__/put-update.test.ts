import { describe, it, expect, vi, beforeEach } from 'vitest';

const agentRow = { id: 'a1', name: 'Test', version: 'v1', availableModels: null, createdAt: new Date() };
const executorRow = { id: 'e1', agentId: 'a1', type: 'docker', agentSlug: 'test' };

const updatedSets: Array<{ table: string; data: Record<string, unknown> }> = [];

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: { name?: string }) => {
        const isExecutorTable = table?.name === 'agentExecutors';
        const rows = isExecutorTable ? [executorRow] : [agentRow];
        return {
          where: vi.fn().mockImplementation(() => {
            const result = Promise.resolve(rows);
            (result as unknown as Record<string, unknown>).limit = vi.fn().mockResolvedValue(rows);
            return result;
          }),
        };
      }),
    }),
    update: vi.fn().mockImplementation((table: { name?: string }) => ({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        updatedSets.push({ table: table?.name ?? 'unknown', data });
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { agentId: 'agentExecutors.agentId', id: 'agentExecutors.id', name: 'agentExecutors' },
  runResults: { agentId: 'run_results.agentId', name: 'run_results' },
  runTasks: { agentExecutorId: 'run_tasks.agentExecutorId', name: 'run_tasks' },
}));

describe('PUT /api/agents/[id] — update paths', () => {
  beforeEach(() => {
    updatedSets.length = 0;
    vi.clearAllMocks();
  });

  it('updates existing executor (not insert)', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { healthCheck: 'docker --version' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const executorUpdate = updatedSets.find((u) => u.table === 'agentExecutors');
    expect(executorUpdate).toBeDefined();
    expect(executorUpdate!.data.healthCheck).toBe('docker --version');
  });

  it('clears version when empty string sent', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '' }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const agentUpdate = updatedSets.find((u) => u.table === 'agents');
    expect(agentUpdate).toBeDefined();
    expect(agentUpdate!.data.version).toBeNull();
  });

  it('preserves version when not sent (undefined)', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const agentUpdate = updatedSets.find((u) => u.table === 'agents');
    expect(agentUpdate).toBeDefined();
    expect(agentUpdate!.data).not.toHaveProperty('version');
  });
});

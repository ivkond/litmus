import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { id: 'a1', name: 'Test Agent', version: null, availableModels: null, createdAt: new Date() };
const mockExecutor = { id: 'e1', agentId: 'a1', type: 'docker', agentSlug: 'test' };

const deletedIds: string[] = [];
const selectResults: Record<string, unknown[]> = {
  agents: [mockAgent],
  agentExecutors: [mockExecutor],
  run_results: [],
  run_tasks: [],
};

let txDeleteThrowsFK = false;

const makeTxProxy = () => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation((table: { name: string }) => ({
      where: vi.fn().mockImplementation(() => {
        return Promise.resolve(selectResults[table.name] ?? []);
      }),
    })),
  }),
  delete: vi.fn().mockImplementation((table: { name: string }) => ({
    where: vi.fn().mockImplementation(() => {
      if (txDeleteThrowsFK && table.name === 'agents') {
        return Promise.reject(Object.assign(new Error('FK violation'), { code: '23503' }));
      }
      deletedIds.push(table.name);
      return Promise.resolve();
    }),
  })),
});

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: { name: string }) => ({
        where: vi.fn().mockImplementation(() => {
          return Promise.resolve(selectResults[table.name] ?? []);
        }),
      })),
    }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: ReturnType<typeof makeTxProxy>) => Promise<unknown>) => {
      const tx = makeTxProxy();
      return fn(tx);
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual('drizzle-orm');
  return { ...actual };
});

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { agentId: 'agentExecutors.agentId', id: 'agentExecutors.id', name: 'agentExecutors' },
  runResults: { agentId: 'run_results.agentId', name: 'run_results' },
  runTasks: { agentExecutorId: 'run_tasks.agentExecutorId', name: 'run_tasks' },
}));

describe('DELETE /api/agents/[id]', () => {
  beforeEach(() => {
    deletedIds.length = 0;
    txDeleteThrowsFK = false;
    selectResults.agents = [mockAgent];
    selectResults.agentExecutors = [mockExecutor];
    selectResults.run_results = [];
    selectResults.run_tasks = [];
    vi.clearAllMocks();
  });

  it('deletes executor then agent in a transaction and returns 200', async () => {
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe('a1');
    expect(deletedIds[0]).toBe('agentExecutors');
    expect(deletedIds[1]).toBe('agents');
  });

  it('returns 404 when agent does not exist', async () => {
    selectResults.agents = [];
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/missing', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'missing' }) });

    expect(response.status).toBe(404);
  });

  it('returns 409 when agent has run_results referencing it', async () => {
    selectResults.run_results = [{ id: 'rr1', agentId: 'a1' }];
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('run results');
    expect(deletedIds.length).toBe(0);
  });

  it('returns 409 when executor has run_tasks referencing it', async () => {
    selectResults.run_tasks = [{ id: 'rt1', agentExecutorId: 'e1' }];
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('run tasks');
    expect(deletedIds.length).toBe(0);
  });

  it('returns 409 when DB throws FK constraint during delete (race condition)', async () => {
    txDeleteThrowsFK = true;
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('concurrent');
  });

  it('deletes successfully when agent has executor but no run_tasks', async () => {
    selectResults.agentExecutors = [mockExecutor];
    selectResults.run_tasks = [];
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    expect(deletedIds).toContain('agentExecutors');
    expect(deletedIds).toContain('agents');
  });
});

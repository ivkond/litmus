import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track what gets inserted
const insertedExecutors: Record<string, unknown>[] = [];

const agentRow = { id: 'a1', name: 'Test', version: null, availableModels: null, createdAt: new Date() };

// The handler has TWO distinct call patterns on db.select().from(table).where():
//   1. Executor lookup: .select().from(agentExecutors).where(...).limit(1)   → returns []
//   2. Final response:  .select().from(agents).where(...)                    → returns [agentRow]
//      and:             .select().from(agentExecutors).where(...)            → returns []
// The mock must handle BOTH: .where() returning a thenable with .limit(), where
// .limit() resolves to the rows AND the bare .where() also resolves to the rows.
vi.mock('@/db', () => {
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: { name?: string }) => {
          const isExecutorTable = table?.name === 'agentExecutors';
          const rows = isExecutorTable ? [] : [agentRow];
          return {
            where: vi.fn().mockImplementation(() => {
              // Return a thenable that ALSO has .limit() for the executor lookup chain
              const result = Promise.resolve(rows);
              (result as unknown as Record<string, unknown>).limit = vi.fn().mockResolvedValue(rows);
              return result;
            }),
          };
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
          insertedExecutors.push(val);
          return Promise.resolve();
        }),
      }),
    },
  };
});

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { agentId: 'agentExecutors.agentId', id: 'agentExecutors.id', name: 'agentExecutors' },
  runResults: { agentId: 'run_results.agentId', name: 'run_results' },
}));

describe('PUT /api/agents/[id] — executor upsert', () => {
  beforeEach(() => {
    insertedExecutors.length = 0;
    vi.clearAllMocks();
  });

  it('creates executor when agent has none', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { type: 'docker', agentSlug: 'new-agent' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    expect(insertedExecutors.length).toBe(1);
    expect(insertedExecutors[0].agentSlug).toBe('new-agent');
    expect(insertedExecutors[0].agentId).toBe('a1');
  });

  it('returns 400 when executor has type but no agentSlug', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { type: 'docker' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(400);
    expect(insertedExecutors.length).toBe(0);
  });

  it('rejects empty agentSlug via Zod validation', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { type: 'docker', agentSlug: '' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(400);
    expect(insertedExecutors.length).toBe(0);
  });
});

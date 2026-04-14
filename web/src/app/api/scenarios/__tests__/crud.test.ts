import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockReturning = vi.fn();
const mockDeleteFn = vi.fn();

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhere }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: mockReturning }) }) }),
    delete: () => ({ where: mockDeleteFn }),
  },
  sql: Object.assign(vi.fn().mockResolvedValue([{ total_runs: 0, avg_score: null, best_score: null, worst_score: null }]), {
    unsafe: vi.fn(),
  }),
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id', slug: 'slug' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@/lib/s3', () => ({
  listFiles: vi.fn().mockResolvedValue([]),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

const MOCK_SCENARIO = {
  id: 'sc-1',
  slug: 'test-scenario',
  name: 'Test',
  description: null,
  version: 'v1',
  language: 'python',
  tags: null,
  maxScore: 100,
  createdAt: new Date('2026-03-29'),
};

describe('GET /api/scenarios/[id]', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockReturning.mockReset();
    mockDeleteFn.mockReset();
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { GET } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/missing');
    const res = await GET(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with ScenarioDetailResponse shape when found', async () => {
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    const { GET } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1');
    const res = await GET(req, { params: Promise.resolve({ id: 'sc-1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'sc-1',
      slug: 'test-scenario',
      name: 'Test',
      files: [],
      usage: { totalRuns: 0, avgScore: null, bestScore: null, worstScore: null },
    });
  });
});

describe('PUT /api/scenarios/[id]', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockReturning.mockReset();
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { PUT } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with unchanged data when body has no recognized fields', async () => {
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    const { PUT } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
  });

  it('returns 200 with updated scenario when valid fields provided', async () => {
    const updated = { ...MOCK_SCENARIO, name: 'Updated Name' };
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    mockReturning.mockResolvedValueOnce([updated]);
    const { PUT } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated Name');
  });
});

describe('DELETE /api/scenarios/[id]', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockDeleteFn.mockReset();
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { DELETE: deleteFn } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/missing', { method: 'DELETE' });
    const res = await deleteFn(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with deleted:true on success', async () => {
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    mockDeleteFn.mockResolvedValueOnce(undefined);
    const { listFiles } = await import('@/lib/s3');
    (listFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['test-scenario/prompt.txt']);

    const { DELETE: deleteFn } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1', { method: 'DELETE' });
    const res = await deleteFn(req, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true });
  });
});

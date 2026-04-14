import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.fn();

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhere }) }),
  },
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

const mockDownload = vi.fn();
const mockUpload = vi.fn();

vi.mock('@/lib/s3', () => ({
  downloadFile: (...args: unknown[]) => mockDownload(...args),
  uploadFile: (...args: unknown[]) => mockUpload(...args),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

const SCENARIO = { id: 'sc-1', slug: 'test-scenario' };

describe('GET /api/scenarios/[id]/files', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockDownload.mockReset();
  });

  it('returns 400 when path query param is missing', async () => {
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 410 for prompt.txt (now in DB)', async () => {
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=prompt.txt');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(410);
  });

  it('returns 410 for task.txt (now in DB)', async () => {
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=task.txt');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(410);
  });

  it('returns 410 for scoring.csv (now in DB)', async () => {
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=scoring.csv');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(410);
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=project/main.py');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with file content for project files', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    mockDownload.mockResolvedValueOnce(Buffer.from('print("hello")'));
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=project/main.py');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ path: 'project/main.py', content: 'print("hello")' });
  });

  it('returns 404 when S3 key does not exist (NoSuchKey)', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    const s3Error = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockDownload.mockRejectedValueOnce(s3Error);
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=project/missing.py');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 502 when S3 has a service error', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    const s3Error = Object.assign(new Error('ServiceUnavailable'), { name: 'ServiceUnavailable', $metadata: {} });
    mockDownload.mockRejectedValueOnce(s3Error);
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=project/main.py');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(502);
  });
});

describe('PUT /api/scenarios/[id]/files', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockUpload.mockReset();
  });

  it('returns 400 when path or content missing', async () => {
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'project/main.py' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 410 for prompt.txt PUT', async () => {
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'prompt.txt', content: 'test' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(410);
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'project/main.py', content: 'test' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 on successful upload for project files', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    mockUpload.mockResolvedValueOnce(undefined);
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'project/main.py', content: 'print("hello")' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ path: 'project/main.py', updated: true });
  });
});

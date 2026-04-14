import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.fn();

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhere }) }),
  },
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id', slug: 'slug' },
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
}));

const mockListFiles = vi.fn();
const mockDownloadFile = vi.fn();

vi.mock('@/lib/s3', () => ({
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

describe('GET /api/scenarios/export', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockListFiles.mockReset();
    mockDownloadFile.mockReset();
  });

  it('returns 400 when no ids query param provided', async () => {
    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export');
    const res = await GET(req as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ids/i);
  });

  it('returns 404 when no matching scenarios found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export?ids=non-existent');
    const res = await GET(req as any);
    expect(res.status).toBe(404);
  });

  it('returns ZIP with correct content-type and disposition when scenarios found', async () => {
    mockWhere.mockResolvedValueOnce([
      { id: 'sc-1', slug: 'test', name: 'Test', version: 'v1', language: 'python', description: null, tags: null, maxScore: null },
    ]);
    mockListFiles.mockResolvedValueOnce(['test/prompt.txt']);
    mockDownloadFile.mockResolvedValueOnce(Buffer.from('test content'));

    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export?ids=sc-1');
    const res = await GET(req as any);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toMatch(/\.litmus-pack/);

    // Verify it's a valid ZIP by checking magic bytes
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    // ZIP magic bytes: PK (0x50, 0x4B)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4B);
  });

  it('exports multiple scenarios when multiple ids provided', async () => {
    mockWhere.mockResolvedValueOnce([
      { id: 'sc-1', slug: 'alpha', name: 'Alpha', version: 'v1', language: 'python', description: null, tags: null, maxScore: null },
      { id: 'sc-2', slug: 'beta', name: 'Beta', version: 'v2', language: 'go', description: null, tags: null, maxScore: null },
    ]);
    mockListFiles
      .mockResolvedValueOnce(['alpha/prompt.txt'])
      .mockResolvedValueOnce(['beta/prompt.txt']);
    mockDownloadFile
      .mockResolvedValueOnce(Buffer.from('alpha prompt'))
      .mockResolvedValueOnce(Buffer.from('beta prompt'));

    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export?ids=sc-1,sc-2');
    const res = await GET(req as any);
    expect(res.status).toBe(200);
  });
});

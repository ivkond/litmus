import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertReturning = vi.fn();
const mockUpload = vi.fn();

vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: () => ({ returning: mockInsertReturning }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  scenarios: { slug: 'slug' },
}));

vi.mock('@/lib/scenarios/queries', () => ({
  fetchScenarioList: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/s3', () => ({
  uploadFile: (...args: unknown[]) => mockUpload(...args),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

describe('POST /api/scenarios', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInsertReturning.mockReset();
    mockUpload.mockReset();
  });

  it('returns 400 when slug is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slug/i);
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'test' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it('returns 201 with created scenario on success', async () => {
    const created = { id: 'new-1', slug: 'test', name: 'Test', version: 'v1' };
    mockInsertReturning.mockResolvedValueOnce([created]);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'test', name: 'Test' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'new-1', slug: 'test', name: 'Test' });
  });

  it('uploads initial files to S3 when provided', async () => {
    const created = { id: 'new-1', slug: 'test', name: 'Test', version: 'v1' };
    mockInsertReturning.mockResolvedValueOnce([created]);
    mockUpload.mockResolvedValue(undefined);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'test',
        name: 'Test',
        prompt: 'Write a hello world',
        task: 'Complete the task',
        files: { 'project/main.py': 'print("hi")', 'prompt.txt': 'ignored — DB field' },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    // Only project/* files uploaded to S3; prompt.txt skipped (stored in DB)
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledWith('litmus-scenarios', 'test/project/main.py', 'print("hi")', 'text/plain');
  });

  it('returns 409 when slug already exists', async () => {
    mockInsertReturning.mockRejectedValueOnce(
      Object.assign(new Error('unique constraint'), { code: '23505' }),
    );
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'existing', name: 'Existing' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/slug.*exists|duplicate/i);
  });
});

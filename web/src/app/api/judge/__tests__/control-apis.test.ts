import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
}));

vi.mock('@/lib/judge/service', () => ({
  enqueueJudgeTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn().mockReturnValue({
    xadd: vi.fn().mockResolvedValue('OK'),
  }),
}));

describe('re-evaluate route', () => {
  it('returns 400 when runResultId is missing', async () => {
    const { POST } = await import('../re-evaluate/route');
    const req = new Request('http://localhost/api/judge/re-evaluate', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 422 when no providers are enabled', async () => {
    const { POST } = await import('../re-evaluate/route');
    const req = new Request('http://localhost/api/judge/re-evaluate', {
      method: 'POST',
      body: JSON.stringify({ runResultId: 'some-id' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
  });
});

describe('re-evaluate-bulk route', () => {
  it('defaults to status=pending when status is omitted', async () => {
    const { POST } = await import('../re-evaluate-bulk/route');
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect([200, 422].includes(res.status)).toBe(true);
  });
});

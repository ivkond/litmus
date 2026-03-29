import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: mockWhere }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: mockWhere }),
      }),
    },
  };
});

vi.mock('@/db/schema', () => ({
  runResults: { id: 'id', judgeStatus: 'judge_status', evaluationVersion: 'evaluation_version', scenarioId: 'scenario_id', compositeScore: 'composite_score', judgeMeta: 'judge_meta', judgeScores: 'judge_scores', blockingFlags: 'blocking_flags' },
  judgeProviders: { enabled: 'enabled', id: 'id' },
  judgeVerdicts: { runResultId: 'run_result_id', evaluationVersion: 'evaluation_version', judgeProviderId: 'judge_provider_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/judge/service', () => ({
  enqueueJudgeTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn().mockReturnValue({
    xadd: vi.fn().mockResolvedValue('OK'),
  }),
}));

import { POST } from '@/app/api/judge/re-evaluate-bulk/route';

describe('POST /api/judge/re-evaluate-bulk', () => {
  it('treats missing status field as status=pending (not 400)', async () => {
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });

  it('accepts explicit status=pending', async () => {
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });

  it('accepts explicit status=all', async () => {
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'all' }),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });
});

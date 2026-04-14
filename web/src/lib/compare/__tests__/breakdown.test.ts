import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
}));

vi.mock('@/db', () => ({ sql: sqlMock }));

import { GET as getBreakdown } from '@/app/api/compare/[scenarioId]/breakdown/route';
import { GET as getDrillDown } from '@/app/api/compare/[scenarioId]/drill-down/route';

describe('GET /api/compare/[scenarioId]/breakdown', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('returns 400 when neither modelId nor agentId is provided', async () => {
    const request = new NextRequest('http://localhost/api/compare/scenario-1/breakdown');
    const response = await getBreakdown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 when both modelId and agentId are provided', async () => {
    const request = new NextRequest('http://localhost/api/compare/scenario-1/breakdown?modelId=model-1&agentId=agent-1');
    const response = await getBreakdown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns scored counterparts plus error-only counterparts for a ranked cell', async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: 'scenario-1', slug: 'todo-app', name: 'Todo App' }])
      .mockResolvedValueOnce([{ id: 'model-1', name: 'GPT-4o' }])
      .mockResolvedValueOnce([
        {
          counterpart_id: 'agent-1',
          counterpart_name: 'Cursor',
          score: 95,
          tests_passed: 19,
          tests_total: 20,
          status: 'completed',
          stale: false,
          created_at: '2026-03-27T10:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          counterpart_id: 'agent-2',
          counterpart_name: 'Aider',
          error_count: 2,
          last_error_at: '2026-03-27T11:00:00Z',
          last_error_message: 'container bootstrap failed',
        },
      ]);

    const request = new NextRequest('http://localhost/api/compare/scenario-1/breakdown?modelId=model-1');
    const response = await getBreakdown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.avgScore).toBe(95);
    expect(body.breakdown).toHaveLength(1);
    expect(body.errorOnlyCounterparts).toHaveLength(1);
  });
});

describe('GET /api/compare/[scenarioId]/drill-down', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('returns 400 when agentId or modelId is missing', async () => {
    const request = new NextRequest('http://localhost/api/compare/scenario-1/drill-down?agentId=agent-1');
    const response = await getDrillDown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });

    expect(response.status).toBe(400);
  });

  it('marks only the latest non-error row as isLatest using run_results.id', async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: 'scenario-1', slug: 'todo-app', name: 'Todo App' }])
      .mockResolvedValueOnce([{ id: 'agent-1', name: 'Cursor' }])
      .mockResolvedValueOnce([{ id: 'model-1', name: 'GPT-4o' }])
      .mockResolvedValueOnce([
        {
          id: 'rr-2',
          run_id: 'run-2',
          total_score: 92,
          tests_passed: 18,
          tests_total: 20,
          duration_seconds: 45,
          attempt: 2,
          max_attempts: 3,
          status: 'completed',
          agent_version: 'v1',
          scenario_version: 'v2',
          judge_scores: null,
          judge_status: null,
          composite_score: null,
          blocking_flags: null,
          artifacts_s3_key: null,
          error_message: null,
          created_at: '2026-03-27T12:00:00Z',
        },
      ])
      // judge verdicts for the latest row (empty — no judge evaluation yet)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'rr-3',
          run_id: 'run-3',
          total_score: 0,
          tests_passed: 0,
          tests_total: 0,
          duration_seconds: 10,
          status: 'error',
          agent_version: 'v1',
          scenario_version: 'v2',
          artifacts_s3_key: null,
          error_message: 'timeout',
          created_at: '2026-03-27T12:30:00Z',
        },
        {
          id: 'rr-2',
          run_id: 'run-2',
          total_score: 92,
          tests_passed: 18,
          tests_total: 20,
          duration_seconds: 45,
          status: 'completed',
          agent_version: 'v1',
          scenario_version: 'v2',
          artifacts_s3_key: null,
          error_message: null,
          created_at: '2026-03-27T12:00:00Z',
        },
      ]);

    const request = new NextRequest('http://localhost/api/compare/scenario-1/drill-down?agentId=agent-1&modelId=model-1');
    const response = await getDrillDown(request, {
      params: Promise.resolve({ scenarioId: 'scenario-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.history.find((row: { runId: string; isLatest: boolean }) => row.runId === 'run-2')?.isLatest).toBe(true);
    expect(body.history.find((row: { runId: string; isLatest: boolean }) => row.runId === 'run-3')?.isLatest).toBe(false);
  });
});

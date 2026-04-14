import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/db';
import type { DrillDownResponse } from '@/lib/compare/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scenarioId: string }> },
) {
  const { scenarioId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const agentId = searchParams.get('agentId');
  const modelId = searchParams.get('modelId');

  if (!agentId || !modelId) {
    return NextResponse.json({ error: 'agentId and modelId required' }, { status: 400 });
  }

  const [scenario] = await sql`SELECT id, slug, name FROM scenarios WHERE id = ${scenarioId}`;
  const [agent] = await sql`SELECT id, name FROM agents WHERE id = ${agentId}`;
  const [model] = await sql`SELECT id, name FROM models WHERE id = ${modelId}`;

  if (!scenario || !agent || !model) {
    return NextResponse.json({ error: 'Scenario, agent, or model not found' }, { status: 404 });
  }

  const [latestRow] = await sql`
    SELECT id, run_id, total_score, tests_passed, tests_total,
           duration_seconds, attempt, max_attempts, status,
           agent_version, scenario_version, judge_scores,
           artifacts_s3_key, error_message, created_at,
           judge_status, composite_score, blocking_flags
    FROM run_results
    WHERE agent_id = ${agentId}
      AND model_id = ${modelId}
      AND scenario_id = ${scenarioId}
      AND status IN ('completed', 'failed')
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const judgeVerdictRows = latestRow
    ? await sql`
        SELECT jp.name AS provider_name, jv.scores, jv.blocking_flags AS blocking,
               jv.created_at, jv.error
        FROM judge_verdicts jv
        JOIN judge_providers jp ON jp.id = jv.judge_provider_id
        WHERE jv.run_result_id = ${(latestRow as Record<string, unknown>).id as string}
          AND jv.evaluation_version = (
            SELECT evaluation_version FROM run_results WHERE id = ${(latestRow as Record<string, unknown>).id as string}
          )
        ORDER BY jv.created_at ASC
      `
    : [];

  const historyRows = await sql`
    SELECT id, run_id, total_score, tests_passed, tests_total,
           duration_seconds, status,
           agent_version, scenario_version,
           artifacts_s3_key, error_message, created_at
    FROM run_results
    WHERE agent_id = ${agentId}
      AND model_id = ${modelId}
      AND scenario_id = ${scenarioId}
    ORDER BY created_at DESC
  `;

  const latest = latestRow
    ? {
        runResultId: String((latestRow as Record<string, unknown>).id),
        runId: String((latestRow as Record<string, unknown>).run_id),
        score: Number((latestRow as Record<string, unknown>).total_score),
        testsPassed: Number((latestRow as Record<string, unknown>).tests_passed),
        testsTotal: Number((latestRow as Record<string, unknown>).tests_total),
        durationSeconds: Number((latestRow as Record<string, unknown>).duration_seconds),
        attempt: Number((latestRow as Record<string, unknown>).attempt),
        maxAttempts: Number((latestRow as Record<string, unknown>).max_attempts),
        status: String((latestRow as Record<string, unknown>).status) as 'completed' | 'failed',
        agentVersion: ((latestRow as Record<string, unknown>).agent_version as string | null) ?? null,
        scenarioVersion: ((latestRow as Record<string, unknown>).scenario_version as string | null) ?? null,
        judgeScores: ((latestRow as Record<string, unknown>).judge_scores as Record<string, number> | null) ?? null,
        artifactsS3Key: ((latestRow as Record<string, unknown>).artifacts_s3_key as string | null) ?? null,
        errorMessage: ((latestRow as Record<string, unknown>).error_message as string | null) ?? null,
        createdAt: String((latestRow as Record<string, unknown>).created_at),
        judgeStatus: ((latestRow as Record<string, unknown>).judge_status as 'pending' | 'partial' | 'completed' | 'skipped' | null) ?? null,
        compositeScore: ((latestRow as Record<string, unknown>).composite_score as number | null) ?? null,
        blockingFlags: ((latestRow as Record<string, unknown>).blocking_flags as Record<string, boolean> | null) ?? null,
        judgeVerdicts: (judgeVerdictRows as Array<Record<string, unknown>>).map((row) => ({
          providerName: String(row.provider_name),
          scores: (row.scores as Record<string, { score: number; rationale: string }>) ?? {},
          blocking: (row.blocking as Record<string, { triggered: boolean; rationale: string }>) ?? {},
          createdAt: String(row.created_at),
          error: (row.error as string | null) ?? null,
        })),
      }
    : null;

  const history = ((historyRows ?? []) as Array<Record<string, unknown>>).map((row, index, rows) => {
    let trend: number | null = null;

    if (row.status !== 'error') {
      for (let next = index + 1; next < rows.length; next++) {
        if (rows[next].status !== 'error') {
          trend = Number(row.total_score) - Number(rows[next].total_score);
          break;
        }
      }
    }

    return {
      runId: String(row.run_id),
      score: Number(row.total_score),
      testsPassed: Number(row.tests_passed),
      testsTotal: Number(row.tests_total),
      durationSeconds: Number(row.duration_seconds),
      status: String(row.status) as 'completed' | 'failed' | 'error',
      agentVersion: (row.agent_version as string | null) ?? null,
      scenarioVersion: (row.scenario_version as string | null) ?? null,
      artifactsS3Key: (row.artifacts_s3_key as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      createdAt: String(row.created_at),
      trend,
      isLatest: latestRow ? row.id === (latestRow as Record<string, unknown>).id : false,
    };
  });

  const response: DrillDownResponse = {
    scenario: {
      id: String((scenario as Record<string, unknown>).id),
      slug: String((scenario as Record<string, unknown>).slug),
      name: String((scenario as Record<string, unknown>).name),
    },
    agent: {
      id: String((agent as Record<string, unknown>).id),
      name: String((agent as Record<string, unknown>).name),
    },
    model: {
      id: String((model as Record<string, unknown>).id),
      name: String((model as Record<string, unknown>).name),
    },
    latest,
    history,
  };

  return NextResponse.json(response);
}

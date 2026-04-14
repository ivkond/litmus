import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/db';
import type { BreakdownResponse } from '@/lib/compare/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scenarioId: string }> },
) {
  const { scenarioId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const modelId = searchParams.get('modelId');
  const agentId = searchParams.get('agentId');

  if (modelId && agentId) {
    return NextResponse.json({ error: 'Provide only one of modelId or agentId' }, { status: 400 });
  }

  if (!modelId && !agentId) {
    return NextResponse.json({ error: 'modelId or agentId required' }, { status: 400 });
  }

  const isModelRanking = Boolean(modelId);
  const entityId = modelId ?? agentId!;

  const [scenario] = await sql`SELECT id, slug, name FROM scenarios WHERE id = ${scenarioId}`;
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  const [entity] = isModelRanking
    ? await sql`SELECT id, name FROM models WHERE id = ${entityId}`
    : await sql`SELECT id, name FROM agents WHERE id = ${entityId}`;

  if (!entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  const scoredRows = isModelRanking
    ? await sql`
        SELECT lr.agent_id AS counterpart_id, a.name AS counterpart_name,
               COALESCE(lr.composite_score, lr.total_score) AS score, lr.tests_passed, lr.tests_total,
               lr.status, lr.created_at,
               EXISTS (
                 SELECT 1
                 FROM run_results rr
                 WHERE rr.model_id = lr.model_id
                   AND rr.agent_id = lr.agent_id
                   AND rr.scenario_id = lr.scenario_id
                   AND rr.status = 'error'
                   AND rr.created_at > lr.created_at
               ) AS stale
        FROM latest_results lr
        JOIN agents a ON a.id = lr.agent_id
        WHERE lr.model_id = ${entityId}
          AND lr.scenario_id = ${scenarioId}
        ORDER BY COALESCE(lr.composite_score, lr.total_score) DESC
      `
    : await sql`
        SELECT lr.model_id AS counterpart_id, m.name AS counterpart_name,
               COALESCE(lr.composite_score, lr.total_score) AS score, lr.tests_passed, lr.tests_total,
               lr.status, lr.created_at,
               EXISTS (
                 SELECT 1
                 FROM run_results rr
                 WHERE rr.agent_id = lr.agent_id
                   AND rr.model_id = lr.model_id
                   AND rr.scenario_id = lr.scenario_id
                   AND rr.status = 'error'
                   AND rr.created_at > lr.created_at
               ) AS stale
        FROM latest_results lr
        JOIN models m ON m.id = lr.model_id
        WHERE lr.agent_id = ${entityId}
          AND lr.scenario_id = ${scenarioId}
        ORDER BY COALESCE(lr.composite_score, lr.total_score) DESC
      `;

  const errorOnlyRows = isModelRanking
    ? await sql`
        SELECT rr.agent_id AS counterpart_id, a.name AS counterpart_name,
               COUNT(*) AS error_count,
               MAX(rr.created_at) AS last_error_at,
               (
                 SELECT rr2.error_message
                 FROM run_results rr2
                 WHERE rr2.model_id = rr.model_id
                   AND rr2.agent_id = rr.agent_id
                   AND rr2.scenario_id = rr.scenario_id
                   AND rr2.status = 'error'
                 ORDER BY rr2.created_at DESC
                 LIMIT 1
               ) AS last_error_message
        FROM run_results rr
        JOIN agents a ON a.id = rr.agent_id
        WHERE rr.status = 'error'
          AND rr.model_id = ${entityId}
          AND rr.scenario_id = ${scenarioId}
          AND NOT EXISTS (
            SELECT 1
            FROM latest_results lr
            WHERE lr.model_id = rr.model_id
              AND lr.agent_id = rr.agent_id
              AND lr.scenario_id = rr.scenario_id
          )
        GROUP BY rr.agent_id, a.name, rr.model_id, rr.scenario_id
      `
    : await sql`
        SELECT rr.model_id AS counterpart_id, m.name AS counterpart_name,
               COUNT(*) AS error_count,
               MAX(rr.created_at) AS last_error_at,
               (
                 SELECT rr2.error_message
                 FROM run_results rr2
                 WHERE rr2.agent_id = rr.agent_id
                   AND rr2.model_id = rr.model_id
                   AND rr2.scenario_id = rr.scenario_id
                   AND rr2.status = 'error'
                 ORDER BY rr2.created_at DESC
                 LIMIT 1
               ) AS last_error_message
        FROM run_results rr
        JOIN models m ON m.id = rr.model_id
        WHERE rr.status = 'error'
          AND rr.agent_id = ${entityId}
          AND rr.scenario_id = ${scenarioId}
          AND NOT EXISTS (
            SELECT 1
            FROM latest_results lr
            WHERE lr.agent_id = rr.agent_id
              AND lr.model_id = rr.model_id
              AND lr.scenario_id = rr.scenario_id
          )
        GROUP BY rr.model_id, m.name, rr.agent_id, rr.scenario_id
      `;

  const breakdown = (scoredRows as Array<Record<string, unknown>>).map((row) => ({
    counterpartId: String(row.counterpart_id),
    counterpartName: String(row.counterpart_name),
    score: Number(row.score),
    testsPassed: Number(row.tests_passed),
    testsTotal: Number(row.tests_total),
    status: String(row.status) as 'completed' | 'failed',
    stale: row.stale === true,
    createdAt: String(row.created_at),
  }));

  const errorOnlyCounterparts = (errorOnlyRows as Array<Record<string, unknown>>).map((row) => ({
    counterpartId: String(row.counterpart_id),
    counterpartName: String(row.counterpart_name),
    errorCount: Number(row.error_count),
    lastErrorAt: String(row.last_error_at),
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
  }));

  const avgScore = breakdown.length > 0
    ? breakdown.reduce((sum, row) => sum + row.score, 0) / breakdown.length
    : null;

  const response: BreakdownResponse = {
    scenario: {
      id: String((scenario as Record<string, unknown>).id),
      slug: String((scenario as Record<string, unknown>).slug),
      name: String((scenario as Record<string, unknown>).name),
    },
    entity: {
      id: String((entity as Record<string, unknown>).id),
      name: String((entity as Record<string, unknown>).name),
      type: isModelRanking ? 'model' : 'agent',
    },
    avgScore,
    breakdown,
    errorOnlyCounterparts,
  };

  return NextResponse.json(response);
}

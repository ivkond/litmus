import { db } from './index';
import { agents, models, runs, runResults } from './schema';
import { count, avg, eq, sql } from 'drizzle-orm';

export async function getDashboardStats() {
  const [agentCount] = await db.select({ count: count() }).from(agents);
  const [modelCount] = await db.select({ count: count() }).from(models);
  const [runCount] = await db.select({ count: count() }).from(runs);
  const [avgScore] = await db
    .select({ avg: avg(runResults.totalScore) })
    .from(runResults)
    .where(eq(runResults.status, 'completed'));

  return {
    agents: agentCount.count,
    models: modelCount.count,
    runs: runCount.count,
    avgScore: avgScore.avg ? Math.round(Number(avgScore.avg)) : 0,
  };
}

export interface RecentRunRow {
  id: string;
  status: string;
  startedAt: Date | null;
  agentModelPairs: string;   // "Claude Code×Sonnet 4, Aider×GPT-4o, ..."
  scenarioCount: number;
  passRate: string;          // "85%" or "—"
}

export async function getRecentRuns(limit = 10): Promise<RecentRunRow[]> {
  const rows = await db.execute(sql`
    SELECT
      r.id,
      r.status,
      r.started_at AS "startedAt",
      (
        SELECT string_agg(DISTINCT a.name || ' x ' || m.name, ', ' ORDER BY a.name || ' x ' || m.name)
        FROM run_results rr
        JOIN agents a ON a.id = rr.agent_id
        JOIN models m ON m.id = rr.model_id
        WHERE rr.run_id = r.id
      ) AS "agentModelPairs",
      (
        SELECT COUNT(DISTINCT rr.scenario_id)
        FROM run_results rr WHERE rr.run_id = r.id
      )::int AS "scenarioCount",
      (
        SELECT CASE
          WHEN COUNT(*) = 0 THEN NULL
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE rr.status = 'completed') / COUNT(*),
            0
          )
        END
        FROM run_results rr WHERE rr.run_id = r.id
      ) AS "passRate"
    FROM runs r
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `);

  interface RawRow {
    id: string;
    status: string;
    startedAt: string | null;
    agentModelPairs: string | null;
    scenarioCount: number | null;
    passRate: number | null;
  }

  return (rows as unknown as RawRow[]).map((row) => ({
    id: row.id,
    status: row.status,
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
    agentModelPairs: row.agentModelPairs || '—',
    scenarioCount: row.scenarioCount ?? 0,
    passRate: row.passRate != null ? `${row.passRate}%` : '—',
  }));
}

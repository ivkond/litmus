import { sql } from '@/db';
import { listFiles, BUCKETS } from '@/lib/s3';
import type { ScenarioListItem, ScenarioDetailResponse, ScenarioFile } from './types';

export async function fetchScenarioList(): Promise<ScenarioListItem[]> {
  const rows = await sql`
    SELECT s.id, s.slug, s.name, s.description, s.version, s.language, s.tags,
           s.max_score, s.created_at,
           COUNT(rr.id) AS total_runs,
           AVG(CASE WHEN rr.status IN ('completed', 'failed') THEN rr.total_score END) AS avg_score
    FROM scenarios s
    LEFT JOIN run_results rr ON rr.scenario_id = s.id
    GROUP BY s.id
    ORDER BY s.slug
  `;

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    version: (row.version as string | null) ?? null,
    language: (row.language as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? null,
    maxScore: row.max_score != null ? Number(row.max_score) : null,
    createdAt: String(row.created_at),
    totalRuns: Number(row.total_runs ?? 0),
    avgScore: row.avg_score != null ? Number(row.avg_score) : null,
  }));
}

export async function fetchScenarioDetail(id: string): Promise<ScenarioDetailResponse | null> {
  const scenarioRows = await sql`
    SELECT * FROM scenarios WHERE id = ${id}
  `;

  const rows = scenarioRows as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const scenario = rows[0];

  // Usage stats
  const statsRows = await sql`
    SELECT COUNT(*) AS total_runs,
           AVG(total_score) AS avg_score,
           MAX(total_score) AS best_score,
           MIN(total_score) AS worst_score
    FROM run_results
    WHERE scenario_id = ${id}
      AND status IN ('completed', 'failed')
  `;

  const stats = (statsRows as Array<Record<string, unknown>>)[0] ?? {};

  // Files from S3 — gracefully handle S3 unavailability
  const slug = String(scenario.slug);
  let files: ScenarioFile[] = [];
  try {
    const keys = await listFiles(BUCKETS.scenarios, `${slug}/`);
    files = keys
      .map((key) => key.replace(`${slug}/`, ''))
      .filter((rel) => rel.startsWith('project/'))
      .map((rel) => ({ key: rel, name: rel, size: 0 }));
  } catch (err) {
    console.error(`[fetchScenarioDetail] S3 listFiles failed for "${slug}/":`, err);
  }

  return {
    id: String(scenario.id),
    slug,
    name: String(scenario.name),
    description: (scenario.description as string | null) ?? null,
    version: (scenario.version as string | null) ?? null,
    language: (scenario.language as string | null) ?? null,
    tags: (scenario.tags as string[] | null) ?? null,
    maxScore: scenario.max_score != null ? Number(scenario.max_score) : null,
    prompt: (scenario.prompt as string | null) ?? null,
    task: (scenario.task as string | null) ?? null,
    scoring: (scenario.scoring as string | null) ?? null,
    createdAt: String(scenario.created_at),
    files,
    usage: {
      totalRuns: Number(stats.total_runs ?? 0),
      avgScore: stats.avg_score != null ? Number(stats.avg_score) : null,
      bestScore: stats.best_score != null ? Number(stats.best_score) : null,
      worstScore: stats.worst_score != null ? Number(stats.worst_score) : null,
    },
  };
}

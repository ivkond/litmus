import { sql } from '@/db';
import type { CompareResponse, HeatmapCell, LensType } from './types';

interface FetchParams {
  lens: LensType;
  agentId?: string;
  modelId?: string;
}

type SqlRow = Record<string, unknown>;

type RankingConfig = {
  entityTable: 'models' | 'agents';
  scoreView: 'score_by_model' | 'score_by_agent';
  entityCol: 'model_id' | 'agent_id';
  counterpartCol: 'agent_id' | 'model_id';
};

const RANKING_CONFIG: Record<'model-ranking' | 'agent-ranking', RankingConfig> = {
  'model-ranking': {
    entityTable: 'models',
    scoreView: 'score_by_model',
    entityCol: 'model_id',
    counterpartCol: 'agent_id',
  },
  'agent-ranking': {
    entityTable: 'agents',
    scoreView: 'score_by_agent',
    entityCol: 'agent_id',
    counterpartCol: 'model_id',
  },
};

export async function fetchCompareData(params: FetchParams): Promise<CompareResponse> {
  const totalScenariosRows = await sql`SELECT COUNT(*) AS cnt FROM scenarios`;
  const totalScenarios = Number((totalScenariosRows[0] as SqlRow | undefined)?.cnt ?? 0);

  if (params.lens === 'model-ranking' || params.lens === 'agent-ranking') {
    return fetchRankingData(params.lens, totalScenarios);
  }

  return fetchDetailedData(params, totalScenarios);
}

async function fetchRankingData(
  lens: 'model-ranking' | 'agent-ranking',
  totalScenarios: number,
): Promise<CompareResponse> {
  const config = RANKING_CONFIG[lens];

  const leaderboardRows = await sql.unsafe(`
    SELECT sv.${config.entityCol} AS entity_id, e.name AS entity_name,
           sv.avg_score, sv.scenario_count,
           COALESCE(sv.counterpart_count, 0) AS counterpart_count,
           (
             SELECT COUNT(*)
             FROM latest_results lr2
             WHERE lr2.${config.entityCol} = sv.${config.entityCol}
               AND lr2.judge_status = 'completed'
           ) AS judged_count,
           (
             SELECT COUNT(*)
             FROM latest_results lr3
             WHERE lr3.${config.entityCol} = sv.${config.entityCol}
           ) AS judged_total
    FROM ${config.scoreView} sv
    JOIN ${config.entityTable} e ON e.id = sv.${config.entityCol}
    ORDER BY sv.avg_score DESC
  `);

  const leaderboard = (leaderboardRows as SqlRow[]).map((row, index) => ({
    rank: index + 1,
    entityId: String(row.entity_id),
    entityName: String(row.entity_name),
    avgScore: Number(row.avg_score),
    scenarioCount: Number(row.scenario_count),
    totalScenarios,
    counterpartCount: Number(row.counterpart_count),
    lowCoverage: Number(row.counterpart_count) <= 1,
    judgedCount: Number(row.judged_count ?? 0),
    judgedTotal: Number(row.judged_total ?? 0),
  }));

  const scenarioRows = await sql`SELECT id, slug, name FROM scenarios ORDER BY slug`;
  const columns = (scenarioRows as SqlRow[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
  }));

  const cellRows = await sql.unsafe(`
    SELECT lr.${config.entityCol} AS entity_id, lr.scenario_id,
           AVG(COALESCE(lr.composite_score, lr.total_score)) AS avg_score,
           COUNT(DISTINCT lr.${config.counterpartCol}) AS counterpart_count
    FROM latest_results lr
    GROUP BY lr.${config.entityCol}, lr.scenario_id
  `);

  const staleRows = await sql.unsafe(`
    SELECT lr.${config.entityCol} AS entity_id, lr.scenario_id,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1
             FROM run_results rr
             WHERE rr.${config.entityCol} = lr.${config.entityCol}
               AND rr.${config.counterpartCol} = lr.${config.counterpartCol}
               AND rr.scenario_id = lr.scenario_id
               AND rr.status = 'error'
               AND rr.created_at > lr.created_at
           )) AS stale_count,
           COUNT(*) AS source_count
    FROM latest_results lr
    GROUP BY lr.${config.entityCol}, lr.scenario_id
  `);

  const errorOnlyRows = await sql.unsafe(`
    SELECT rr.${config.entityCol} AS entity_id, rr.scenario_id,
           COUNT(*) AS error_count
    FROM run_results rr
    WHERE rr.status = 'error'
      AND NOT EXISTS (
        SELECT 1
        FROM latest_results lr
        WHERE lr.${config.entityCol} = rr.${config.entityCol}
          AND lr.${config.counterpartCol} = rr.${config.counterpartCol}
          AND lr.scenario_id = rr.scenario_id
      )
    GROUP BY rr.${config.entityCol}, rr.scenario_id
  `);

  const cellMap = new Map<string, SqlRow>();
  for (const row of cellRows as SqlRow[]) {
    cellMap.set(`${row.entity_id}:${row.scenario_id}`, row);
  }

  const staleMap = new Map<string, SqlRow>();
  for (const row of staleRows as SqlRow[]) {
    staleMap.set(`${row.entity_id}:${row.scenario_id}`, row);
  }

  const errorOnlyMap = new Map<string, SqlRow>();
  for (const row of errorOnlyRows as SqlRow[]) {
    errorOnlyMap.set(`${row.entity_id}:${row.scenario_id}`, row);
  }

  const rows = leaderboard.map((entry) => ({
    id: entry.entityId,
    slug: slugify(entry.entityName),
    name: entry.entityName,
  }));

  const cells: CompareResponse['heatmap']['cells'] = {};
  const totals: CompareResponse['heatmap']['totals'] = {};

  for (const row of rows) {
    cells[row.id] = {};
    const scores: number[] = [];

    for (const column of columns) {
      const key = `${row.id}:${column.id}`;
      const cell = cellMap.get(key);
      const stale = staleMap.get(key);
      const errorOnly = errorOnlyMap.get(key);

      if (cell) {
        const score = Number(cell.avg_score);
        scores.push(score);
        cells[row.id][column.id] = {
          score,
          bestInRow: false,
          stale: Number(stale?.stale_count ?? 0) > 0,
          errorOnly: false,
          counterpartCount: Number(cell.counterpart_count),
          staleCount: Number(stale?.stale_count ?? 0),
          sourceCount: Number(stale?.source_count ?? 0),
        };
      } else if (errorOnly) {
        cells[row.id][column.id] = {
          score: 0,
          bestInRow: false,
          stale: false,
          errorOnly: true,
          errorCount: Number(errorOnly.error_count),
        };
      } else {
        cells[row.id][column.id] = null;
      }
    }

    const best = Math.max(...scores, 0);
    if (best > 0) {
      for (const column of columns) {
        const cell = cells[row.id][column.id];
        if (cell && !cell.errorOnly && cell.score === best) {
          cell.bestInRow = true;
        }
      }
    }

    totals[row.id] = scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  }

  // Fetch counterpart IDs for participants
  const counterpartRows = await sql.unsafe(`
    SELECT DISTINCT lr.${config.counterpartCol} AS id
    FROM latest_results lr
  `);
  const counterpartIds = (counterpartRows as SqlRow[]).map((row) => String(row.id));

  const entityIds = leaderboard.map((e) => e.entityId);
  const scenarioIds = columns.map((c) => c.id);

  const isModelRanking = lens === 'model-ranking';
  const participants = {
    agentIds: dedupSort(isModelRanking ? counterpartIds : entityIds),
    modelIds: dedupSort(isModelRanking ? entityIds : counterpartIds),
    scenarioIds: dedupSort(scenarioIds),
  };

  return {
    lens,
    canonicalParams: { lens },
    leaderboard,
    heatmap: {
      columns,
      rows,
      cells,
      totals,
    },
    participants,
  };
}

async function fetchDetailedData(
  params: FetchParams,
  totalScenarios: number,
): Promise<CompareResponse> {
  const isAgentFixed = params.lens === 'agent-x-models';
  const anchorParamId = isAgentFixed ? params.agentId : params.modelId;

  const anchors = isAgentFixed
    ? await sql.unsafe(`
        SELECT DISTINCT lr.agent_id AS id, a.name
        FROM latest_results lr
        JOIN agents a ON a.id = lr.agent_id
        ORDER BY a.name
      `)
    : await sql.unsafe(`
        SELECT DISTINCT lr.model_id AS id, m.name
        FROM latest_results lr
        JOIN models m ON m.id = lr.model_id
        ORDER BY m.name
      `);

  const availableAnchors = (anchors as SqlRow[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
  }));

  const anchorId = anchorParamId ?? availableAnchors[0]?.id;
  const canonicalParams =
    isAgentFixed
      ? { lens: params.lens, agentId: anchorId }
      : { lens: params.lens, modelId: anchorId };

  if (!anchorId) {
    return {
      lens: params.lens,
      availableAnchors,
      canonicalParams,
      leaderboard: [],
      heatmap: { columns: [], rows: [], cells: {}, totals: {} },
      participants: { agentIds: [], modelIds: [], scenarioIds: [] },
    };
  }

  const anchor = availableAnchors.find((candidate) => candidate.id === anchorId) ?? {
    id: anchorId,
    name: '',
  };

  const entityRows = isAgentFixed
    ? await sql`
        SELECT lr.model_id AS entity_id, m.name AS entity_name,
               AVG(COALESCE(lr.composite_score, lr.total_score)) AS avg_score,
               COUNT(DISTINCT lr.scenario_id) AS scenario_count,
               COUNT(*) FILTER (WHERE lr.judge_status = 'completed') AS judged_count,
               COUNT(*) AS judged_total
        FROM latest_results lr
        JOIN models m ON m.id = lr.model_id
        WHERE lr.agent_id = ${anchorId}
        GROUP BY lr.model_id, m.name
        ORDER BY avg_score DESC
      `
    : await sql`
        SELECT lr.agent_id AS entity_id, a.name AS entity_name,
               AVG(COALESCE(lr.composite_score, lr.total_score)) AS avg_score,
               COUNT(DISTINCT lr.scenario_id) AS scenario_count,
               COUNT(*) FILTER (WHERE lr.judge_status = 'completed') AS judged_count,
               COUNT(*) AS judged_total
        FROM latest_results lr
        JOIN agents a ON a.id = lr.agent_id
        WHERE lr.model_id = ${anchorId}
        GROUP BY lr.agent_id, a.name
        ORDER BY avg_score DESC
      `;

  const errorOnlyRows = isAgentFixed
    ? await sql`
        SELECT rr.model_id AS entity_id, m.name AS entity_name, rr.scenario_id,
               COUNT(*) AS error_count
        FROM run_results rr
        JOIN models m ON m.id = rr.model_id
        WHERE rr.agent_id = ${anchorId}
          AND rr.status = 'error'
          AND NOT EXISTS (
            SELECT 1
            FROM latest_results lr
            WHERE lr.agent_id = rr.agent_id
              AND lr.model_id = rr.model_id
              AND lr.scenario_id = rr.scenario_id
          )
        GROUP BY rr.model_id, m.name, rr.scenario_id
      `
    : await sql`
        SELECT rr.agent_id AS entity_id, a.name AS entity_name, rr.scenario_id,
               COUNT(*) AS error_count
        FROM run_results rr
        JOIN agents a ON a.id = rr.agent_id
        WHERE rr.model_id = ${anchorId}
          AND rr.status = 'error'
          AND NOT EXISTS (
            SELECT 1
            FROM latest_results lr
            WHERE lr.agent_id = rr.agent_id
              AND lr.model_id = rr.model_id
              AND lr.scenario_id = rr.scenario_id
          )
        GROUP BY rr.agent_id, a.name, rr.scenario_id
      `;

  const leaderboardMap = new Map<string, CompareResponse['leaderboard'][number]>();

  for (const row of entityRows as SqlRow[]) {
    leaderboardMap.set(String(row.entity_id), {
      rank: 0,
      entityId: String(row.entity_id),
      entityName: String(row.entity_name),
      avgScore: Number(row.avg_score),
      scenarioCount: Number(row.scenario_count),
      totalScenarios,
      counterpartCount: 1,
      lowCoverage: false,
      judgedCount: Number(row.judged_count ?? 0),
      judgedTotal: Number(row.judged_total ?? 0),
    });
  }

  for (const row of errorOnlyRows as SqlRow[]) {
    if (!leaderboardMap.has(String(row.entity_id))) {
      leaderboardMap.set(String(row.entity_id), {
        rank: 0,
        entityId: String(row.entity_id),
        entityName: String(row.entity_name),
        avgScore: 0,
        scenarioCount: 0,
        totalScenarios,
        counterpartCount: 1,
        lowCoverage: false,
      });
    }
  }

  const leaderboard = Array.from(leaderboardMap.values())
    .sort((left, right) => right.avgScore - left.avgScore || left.entityName.localeCompare(right.entityName))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  const scenarioRows = await sql`SELECT id, slug, name FROM scenarios ORDER BY slug`;
  const columns = (scenarioRows as SqlRow[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
  }));

  const cellRows = isAgentFixed
    ? await sql`
        SELECT lr.model_id AS entity_id, lr.scenario_id,
               COALESCE(lr.composite_score, lr.total_score) AS total_score, lr.tests_passed, lr.tests_total, lr.status, lr.judge_status, lr.created_at
        FROM latest_results lr
        WHERE lr.agent_id = ${anchorId}
      `
    : await sql`
        SELECT lr.agent_id AS entity_id, lr.scenario_id,
               COALESCE(lr.composite_score, lr.total_score) AS total_score, lr.tests_passed, lr.tests_total, lr.status, lr.judge_status, lr.created_at
        FROM latest_results lr
        WHERE lr.model_id = ${anchorId}
      `;

  const staleRows = isAgentFixed
    ? await sql`
        SELECT lr.model_id AS entity_id, lr.scenario_id,
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
        WHERE lr.agent_id = ${anchorId}
      `
    : await sql`
        SELECT lr.agent_id AS entity_id, lr.scenario_id,
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
        WHERE lr.model_id = ${anchorId}
      `;

  const cellMap = new Map<string, SqlRow>();
  for (const row of cellRows as SqlRow[]) {
    cellMap.set(`${row.entity_id}:${row.scenario_id}`, row);
  }

  const staleMap = new Map<string, SqlRow>();
  for (const row of staleRows as SqlRow[]) {
    staleMap.set(`${row.entity_id}:${row.scenario_id}`, row);
  }

  const errorOnlyMap = new Map<string, SqlRow>();
  for (const row of errorOnlyRows as SqlRow[]) {
    errorOnlyMap.set(`${row.entity_id}:${row.scenario_id}`, row);
  }

  const rows = leaderboard.map((entry) => ({
    id: entry.entityId,
    slug: slugify(entry.entityName),
    name: entry.entityName,
  }));

  const cells: CompareResponse['heatmap']['cells'] = {};
  const totals: CompareResponse['heatmap']['totals'] = {};

  for (const row of rows) {
    cells[row.id] = {};
    const scores: number[] = [];

    for (const column of columns) {
      const key = `${row.id}:${column.id}`;
      const cell = cellMap.get(key);
      const stale = staleMap.get(key);

      if (!cell) {
        const errorOnly = errorOnlyMap.get(key);
        cells[row.id][column.id] = errorOnly
          ? {
              score: 0,
              bestInRow: false,
              stale: false,
              errorOnly: true,
              errorCount: Number(errorOnly.error_count),
            }
          : null;
        continue;
      }

      const score = Number(cell.total_score);
      scores.push(score);
      cells[row.id][column.id] = {
        score,
        bestInRow: false,
        stale: stale?.stale === true,
        errorOnly: false,
        testsPassed: Number(cell.tests_passed),
        testsTotal: Number(cell.tests_total),
        status: String(cell.status) as 'completed' | 'failed',
        judgeStatus: (cell.judge_status as HeatmapCell['judgeStatus']) ?? undefined,
      };
    }

    const best = Math.max(...scores, 0);
    if (best > 0) {
      for (const column of columns) {
        const cell = cells[row.id][column.id];
        if (cell && !cell.errorOnly && cell.score === best) {
          cell.bestInRow = true;
        }
      }
    }

    totals[row.id] = scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  }

  const entityIds = leaderboard.map((e) => e.entityId);
  const scenarioIds = columns.map((c) => c.id);

  const participants = isAgentFixed
    ? {
        agentIds: dedupSort(anchorId ? [anchorId] : []),
        modelIds: dedupSort(entityIds),
        scenarioIds: dedupSort(scenarioIds),
      }
    : {
        agentIds: dedupSort(entityIds),
        modelIds: dedupSort(anchorId ? [anchorId] : []),
        scenarioIds: dedupSort(scenarioIds),
      };

  return {
    lens: params.lens,
    anchor,
    availableAnchors,
    canonicalParams,
    leaderboard,
    heatmap: {
      columns,
      rows,
      cells,
      totals,
    },
    participants,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-');
}

function dedupSort(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

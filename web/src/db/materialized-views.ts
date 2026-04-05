const VIEWS_SQL = `
SET client_min_messages TO WARNING;
-- Drop and recreate to handle schema changes
DROP MATERIALIZED VIEW IF EXISTS score_by_agent CASCADE;
DROP MATERIALIZED VIEW IF EXISTS score_by_model CASCADE;
DROP MATERIALIZED VIEW IF EXISTS latest_results CASCADE;

-- Latest result per (agent, model, scenario) combo
CREATE MATERIALIZED VIEW latest_results AS
SELECT DISTINCT ON (agent_id, model_id, scenario_id)
    id, run_id, agent_id, model_id, scenario_id,
    agent_version, scenario_version, status,
    tests_passed, tests_total, total_score,
    duration_seconds, judge_scores, composite_score, blocking_flags, judge_status,
    artifacts_s3_key, created_at
FROM run_results
WHERE status IN ('completed', 'failed')
ORDER BY agent_id, model_id, scenario_id, created_at DESC;

CREATE UNIQUE INDEX idx_latest_results_pk
    ON latest_results(agent_id, model_id, scenario_id);

-- Model leaderboard
CREATE MATERIALIZED VIEW score_by_model AS
WITH per_scenario AS (
    SELECT
        model_id,
        scenario_id,
        AVG(COALESCE(composite_score, total_score)) AS scenario_avg,
        COUNT(DISTINCT agent_id) AS agent_count
    FROM latest_results
    GROUP BY model_id, scenario_id
)
SELECT
    ps.model_id,
    AVG(ps.scenario_avg) AS avg_score,
    COUNT(DISTINCT ps.scenario_id) AS scenario_count,
    SUM(ps.agent_count) AS result_count,
    (
        SELECT COUNT(DISTINCT lr.agent_id)
        FROM latest_results lr
        WHERE lr.model_id = ps.model_id
    ) AS counterpart_count
FROM per_scenario ps
GROUP BY ps.model_id;

CREATE UNIQUE INDEX idx_score_by_model_pk ON score_by_model(model_id);

-- Agent leaderboard
CREATE MATERIALIZED VIEW score_by_agent AS
WITH per_scenario AS (
    SELECT
        agent_id,
        scenario_id,
        AVG(COALESCE(composite_score, total_score)) AS scenario_avg,
        COUNT(DISTINCT model_id) AS model_count
    FROM latest_results
    GROUP BY agent_id, scenario_id
)
SELECT
    ps.agent_id,
    AVG(ps.scenario_avg) AS avg_score,
    COUNT(DISTINCT ps.scenario_id) AS scenario_count,
    SUM(ps.model_count) AS result_count,
    (
        SELECT COUNT(DISTINCT lr.model_id)
        FROM latest_results lr
        WHERE lr.agent_id = ps.agent_id
    ) AS counterpart_count
FROM per_scenario ps
GROUP BY ps.agent_id;

CREATE UNIQUE INDEX idx_score_by_agent_pk ON score_by_agent(agent_id);
`;

/** postgres.js client (or compatible) with `.unsafe()` for multi-statement SQL */
export async function applyMaterializedViews(client: {
  unsafe: (query: string) => Promise<unknown>;
}): Promise<void> {
  await client.unsafe(VIEWS_SQL);
}

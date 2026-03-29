import 'dotenv/config';
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!);

const VIEWS_SQL = `
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
    duration_seconds, judge_scores, judge_model,
    artifacts_s3_key, created_at
FROM run_results
WHERE status IN ('completed', 'failed')
ORDER BY agent_id, model_id, scenario_id, created_at DESC;

CREATE UNIQUE INDEX idx_latest_results_pk
    ON latest_results(agent_id, model_id, scenario_id);

-- Model leaderboard
CREATE MATERIALIZED VIEW score_by_model AS
SELECT
    model_id,
    AVG(total_score) AS avg_score,
    COUNT(DISTINCT agent_id) AS agent_count,
    COUNT(DISTINCT scenario_id) AS scenario_count,
    COUNT(*) AS result_count
FROM latest_results
GROUP BY model_id;

CREATE UNIQUE INDEX idx_score_by_model_pk ON score_by_model(model_id);

-- Agent leaderboard
CREATE MATERIALIZED VIEW score_by_agent AS
SELECT
    agent_id,
    AVG(total_score) AS avg_score,
    COUNT(DISTINCT model_id) AS model_count,
    COUNT(DISTINCT scenario_id) AS scenario_count,
    COUNT(*) AS result_count
FROM latest_results
GROUP BY agent_id;

CREATE UNIQUE INDEX idx_score_by_agent_pk ON score_by_agent(agent_id);
`;

async function migrateViews() {
  console.log('Creating materialized views...');
  await client.unsafe(VIEWS_SQL);
  console.log('Materialized views created successfully.');
  await client.end();
}

migrateViews().catch((err) => {
  console.error('Failed to create materialized views:', err);
  process.exit(1);
});

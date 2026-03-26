use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::error::Result;
use crate::model::RunResult;

/// Insert a RunResult into the database.
pub fn insert_result(conn: &Connection, r: &RunResult) -> Result<()> {
    let judge_scores_json =
        serde_json::to_string(&r.judge_scores).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        "INSERT INTO run_results (
            id, run_id, agent, agent_version, model,
            scenario_id, scenario_version, timestamp,
            tests_passed, tests_total,
            judge_scores, judge_model,
            logs_path, code_path,
            total_score, duration_seconds
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8,
            ?9, ?10,
            ?11, ?12,
            ?13, ?14,
            ?15, ?16
        )",
        params![
            r.id.to_string(),
            r.run_id.to_string(),
            r.agent,
            r.agent_version,
            r.model,
            r.scenario_id,
            r.scenario_version,
            r.timestamp.to_rfc3339(),
            r.tests_passed,
            r.tests_total,
            judge_scores_json,
            r.judge_model,
            r.logs_path,
            r.code_path,
            r.total_score,
            r.duration_seconds,
        ],
    )?;
    Ok(())
}

/// Fetch a single result by its UUID.
pub fn get_result_by_id(conn: &Connection, id: &Uuid) -> Result<Option<RunResult>> {
    let mut stmt = conn.prepare("SELECT * FROM run_results WHERE id = ?1")?;
    let result = stmt
        .query_row(params![id.to_string()], row_to_run_result)
        .optional()?;
    Ok(result)
}

/// List all results belonging to a batch run.
pub fn list_by_run_id(conn: &Connection, run_id: &Uuid) -> Result<Vec<RunResult>> {
    let mut stmt =
        conn.prepare("SELECT * FROM run_results WHERE run_id = ?1 ORDER BY scenario_id")?;
    let rows = stmt.query_map(params![run_id.to_string()], row_to_run_result)?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get the latest result for a specific agent/model/scenario combination.
pub fn latest_result(
    conn: &Connection,
    agent: &str,
    model: &str,
    scenario_id: &str,
) -> Result<Option<RunResult>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM run_results
         WHERE agent = ?1 AND model = ?2 AND scenario_id = ?3
         ORDER BY timestamp DESC LIMIT 1",
    )?;
    let result = stmt
        .query_row(params![agent, model, scenario_id], row_to_run_result)
        .optional()?;
    Ok(result)
}

/// Summary statistics for the Dashboard screen.
pub struct SummaryStats {
    pub total_results: u64,
    pub unique_agents: u64,
    pub unique_models: u64,
    pub unique_scenarios: u64,
}

pub fn summary_stats(conn: &Connection) -> Result<SummaryStats> {
    let total_results: u64 =
        conn.query_row("SELECT COUNT(*) FROM run_results", [], |r| r.get(0))?;
    let unique_agents: u64 = conn.query_row(
        "SELECT COUNT(DISTINCT agent) FROM run_results",
        [],
        |r| r.get(0),
    )?;
    let unique_models: u64 = conn.query_row(
        "SELECT COUNT(DISTINCT model) FROM run_results",
        [],
        |r| r.get(0),
    )?;
    let unique_scenarios: u64 = conn.query_row(
        "SELECT COUNT(DISTINCT scenario_id) FROM run_results",
        [],
        |r| r.get(0),
    )?;
    Ok(SummaryStats {
        total_results,
        unique_agents,
        unique_models,
        unique_scenarios,
    })
}

/// Info about a recent batch run (for Dashboard recent activity).
/// One row per agent+model pair within a run_id.
pub struct RecentRun {
    pub run_id: Uuid,
    pub agent: String,
    pub model: String,
    pub scenarios_count: u64,
    pub tests_passed: u64,
    pub tests_total: u64,
    pub timestamp: String,
}

pub fn recent_runs(conn: &Connection, limit: u32) -> Result<Vec<RecentRun>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, agent, model,
                COUNT(*) as cnt,
                SUM(tests_passed) as passed,
                SUM(tests_total) as total,
                MAX(timestamp) as ts
         FROM run_results
         GROUP BY run_id, agent, model
         ORDER BY ts DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        let run_id_str: String = row.get(0)?;
        Ok(RecentRun {
            run_id: Uuid::parse_str(&run_id_str).unwrap_or_default(),
            agent: row.get(1)?,
            model: row.get(2)?,
            scenarios_count: row.get(3)?,
            tests_passed: row.get(4)?,
            tests_total: row.get(5)?,
            timestamp: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ---- internal helpers ----

fn row_to_run_result(row: &Row) -> rusqlite::Result<RunResult> {
    let id_str: String = row.get("id")?;
    let run_id_str: String = row.get("run_id")?;
    let judge_scores_str: String = row.get("judge_scores")?;
    let timestamp_str: String = row.get("timestamp")?;

    let judge_scores: HashMap<String, f64> =
        serde_json::from_str(&judge_scores_str).unwrap_or_default();
    let timestamp = chrono::DateTime::parse_from_rfc3339(&timestamp_str)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    Ok(RunResult {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        run_id: Uuid::parse_str(&run_id_str).unwrap_or_default(),
        agent: row.get("agent")?,
        agent_version: row.get("agent_version")?,
        model: row.get("model")?,
        scenario_id: row.get("scenario_id")?,
        scenario_version: row.get("scenario_version")?,
        timestamp,
        tests_passed: row.get("tests_passed")?,
        tests_total: row.get("tests_total")?,
        judge_scores,
        judge_model: row.get("judge_model")?,
        logs_path: row.get("logs_path")?,
        code_path: row.get("code_path")?,
        total_score: row.get("total_score")?,
        duration_seconds: row.get("duration_seconds")?,
    })
}

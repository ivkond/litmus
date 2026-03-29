use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::app::{CompareEntry, ScenarioResult};
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

// ---- Compare screen queries ----

/// Aggregate results per agent×model for the leaderboard view.
pub fn compare_entries(conn: &Connection) -> Result<Vec<CompareEntry>> {
    let mut stmt = conn.prepare(
        "SELECT agent, model,
                COUNT(*) AS scenarios_run,
                SUM(tests_passed) AS tests_passed,
                SUM(tests_total) AS tests_total,
                AVG(duration_seconds) AS avg_duration,
                AVG(total_score) AS avg_score
         FROM run_results
         GROUP BY agent, model
         ORDER BY agent, model",
    )?;
    let rows = stmt.query_map([], |row| {
        let tests_passed: i64 = row.get(3)?;
        let tests_total: i64 = row.get(4)?;
        let pass_rate = if tests_total > 0 {
            tests_passed as f64 / tests_total as f64
        } else {
            0.0
        };
        Ok(CompareEntry {
            agent: row.get(0)?,
            model: row.get(1)?,
            scenarios_run: row.get::<_, i64>(2)? as u32,
            tests_passed: tests_passed as u32,
            tests_total: tests_total as u32,
            pass_rate,
            avg_duration_secs: row.get(5)?,
            total_score: row.get(6)?,
        })
    })?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Per-scenario results for each agent×model pair, for matrix/detail views.
/// Returns `(matrix_rows, scenario_ids_sorted)`.
pub fn compare_matrix(
    conn: &Connection,
) -> Result<(Vec<(String, String, Vec<ScenarioResult>)>, Vec<String>)> {
    let mut stmt = conn.prepare(
        "SELECT agent, model, scenario_id, tests_passed, tests_total, duration_seconds, total_score
         FROM run_results
         ORDER BY agent, model, scenario_id",
    )?;

    let mut matrix: Vec<(String, String, Vec<ScenarioResult>)> = Vec::new();
    let mut scenario_set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    let rows = stmt.query_map([], |row| {
        let tests_passed: i64 = row.get(3)?;
        let tests_total: i64 = row.get(4)?;
        Ok((
            row.get::<_, String>(0)?,  // agent
            row.get::<_, String>(1)?,  // model
            row.get::<_, String>(2)?,  // scenario_id
            tests_passed,
            tests_total,
            row.get::<_, f64>(5)?,     // duration_seconds
            row.get::<_, f64>(6)?,     // total_score
        ))
    })?;

    for row in rows {
        let (agent, model, scenario_id, tests_passed, tests_total, duration, score) = row?;
        scenario_set.insert(scenario_id.clone());
        let passed = tests_total > 0 && tests_passed == tests_total;
        let sr = ScenarioResult {
            scenario_id: scenario_id.clone(),
            tests_passed: tests_passed as u32,
            tests_total: tests_total as u32,
            passed,
            duration_secs: duration,
            score,
        };
        // Find or create the entry for this (agent, model) pair
        if let Some(entry) = matrix.iter_mut().find(|(a, m, _)| a == &agent && m == &model) {
            entry.2.push(sr);
        } else {
            matrix.push((agent, model, vec![sr]));
        }
    }

    let scenario_ids: Vec<String> = scenario_set.into_iter().collect();
    Ok((matrix, scenario_ids))
}

// ---- internal helpers ----

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_db;
    use chrono::Utc;
    use std::collections::HashMap;
    use uuid::Uuid;

    fn make_result(
        agent: &str,
        model: &str,
        scenario_id: &str,
        tests_passed: u32,
        tests_total: u32,
        duration_seconds: u64,
        total_score: f64,
    ) -> RunResult {
        RunResult {
            id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            agent: agent.to_string(),
            agent_version: String::new(),
            model: model.to_string(),
            scenario_id: scenario_id.to_string(),
            scenario_version: "v1".to_string(),
            timestamp: Utc::now(),
            tests_passed,
            tests_total,
            judge_scores: HashMap::new(),
            judge_model: None,
            logs_path: String::new(),
            code_path: String::new(),
            total_score,
            duration_seconds,
        }
    }

    #[test]
    fn test_compare_entries_empty() {
        let conn = open_memory_db().unwrap();
        let entries = compare_entries(&conn).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_compare_entries_aggregates_by_agent_model() {
        let conn = open_memory_db().unwrap();
        // Insert two results for agent-a/model-x across two scenarios
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-1", 3, 3, 10, 1.0)).unwrap();
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-2", 2, 3, 20, 0.5)).unwrap();
        // Insert one result for agent-b/model-y
        insert_result(&conn, &make_result("agent-b", "model-y", "scenario-1", 1, 2, 15, 0.75)).unwrap();

        let entries = compare_entries(&conn).unwrap();
        assert_eq!(entries.len(), 2);

        let a = entries.iter().find(|e| e.agent == "agent-a").unwrap();
        assert_eq!(a.scenarios_run, 2);
        assert_eq!(a.tests_passed, 5);
        assert_eq!(a.tests_total, 6);
        assert!((a.pass_rate - 5.0 / 6.0).abs() < 1e-9);
        assert!((a.avg_duration_secs - 15.0).abs() < 1e-9);
        assert!((a.total_score - 0.75).abs() < 1e-9); // avg of 1.0 and 0.5

        let b = entries.iter().find(|e| e.agent == "agent-b").unwrap();
        assert_eq!(b.scenarios_run, 1);
        assert_eq!(b.tests_passed, 1);
        assert_eq!(b.tests_total, 2);
        assert!((b.pass_rate - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_compare_entries_zero_tests_total_pass_rate() {
        let conn = open_memory_db().unwrap();
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-1", 0, 0, 5, 0.0)).unwrap();

        let entries = compare_entries(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        assert!((entries[0].pass_rate - 0.0).abs() < 1e-9);
    }

    #[test]
    fn test_compare_matrix_empty() {
        let conn = open_memory_db().unwrap();
        let (matrix, scenario_ids) = compare_matrix(&conn).unwrap();
        assert!(matrix.is_empty());
        assert!(scenario_ids.is_empty());
    }

    #[test]
    fn test_compare_matrix_groups_and_collects_scenario_ids() {
        let conn = open_memory_db().unwrap();
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-2", 2, 2, 10, 1.0)).unwrap();
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-1", 1, 2, 5, 0.5)).unwrap();
        insert_result(&conn, &make_result("agent-b", "model-y", "scenario-1", 2, 2, 8, 1.0)).unwrap();

        let (matrix, scenario_ids) = compare_matrix(&conn).unwrap();

        // Scenario IDs should be sorted
        assert_eq!(scenario_ids, vec!["scenario-1", "scenario-2"]);

        // Two (agent, model) groups
        assert_eq!(matrix.len(), 2);

        let ax = matrix.iter().find(|(a, m, _)| a == "agent-a" && m == "model-x").unwrap();
        assert_eq!(ax.2.len(), 2);
        // Results are ordered by scenario_id within the group
        assert_eq!(ax.2[0].scenario_id, "scenario-1");
        assert_eq!(ax.2[1].scenario_id, "scenario-2");
        assert!(ax.2[1].passed); // 2/2 passed

        let by = matrix.iter().find(|(a, m, _)| a == "agent-b" && m == "model-y").unwrap();
        assert_eq!(by.2.len(), 1);
        assert!(by.2[0].passed);
    }

    #[test]
    fn test_compare_matrix_passed_flag() {
        let conn = open_memory_db().unwrap();
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-1", 2, 3, 10, 0.5)).unwrap();
        insert_result(&conn, &make_result("agent-a", "model-x", "scenario-2", 3, 3, 10, 1.0)).unwrap();

        let (matrix, _) = compare_matrix(&conn).unwrap();
        let ax = matrix.iter().find(|(a, m, _)| a == "agent-a" && m == "model-x").unwrap();
        let s1 = ax.2.iter().find(|s| s.scenario_id == "scenario-1").unwrap();
        let s2 = ax.2.iter().find(|s| s.scenario_id == "scenario-2").unwrap();
        assert!(!s1.passed); // 2/3 — not all passed
        assert!(s2.passed);  // 3/3 — all passed
    }
}

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

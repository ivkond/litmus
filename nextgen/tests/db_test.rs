use chrono::Utc;
use litmus_nextgen::db::queries;
use litmus_nextgen::db::open_memory_db;
use litmus_nextgen::model::RunResult;
use std::collections::HashMap;
use uuid::Uuid;

fn make_result(agent: &str, model: &str, scenario: &str, score: f64) -> RunResult {
    RunResult {
        id: Uuid::new_v4(),
        run_id: Uuid::new_v4(),
        agent: agent.into(),
        agent_version: "v1".into(),
        model: model.into(),
        scenario_id: scenario.into(),
        scenario_version: "v1".into(),
        timestamp: Utc::now(),
        tests_passed: 8,
        tests_total: 10,
        judge_scores: HashMap::new(),
        judge_model: None,
        logs_path: "logs/test.log".into(),
        code_path: "code/main.py".into(),
        total_score: score,
        duration_seconds: 45,
    }
}

#[test]
fn test_insert_and_get_by_id() {
    let conn = open_memory_db().unwrap();
    let r = make_result("KiloCode", "sonnet-4", "1-data-structure", 85.0);
    queries::insert_result(&conn, &r).unwrap();

    let fetched = queries::get_result_by_id(&conn, &r.id).unwrap().unwrap();
    assert_eq!(fetched.agent, "KiloCode");
    assert_eq!(fetched.model, "sonnet-4");
    assert_eq!(fetched.total_score, 85.0);
}

#[test]
fn test_list_results_by_run_id() {
    let conn = open_memory_db().unwrap();
    let run_id = Uuid::new_v4();

    let mut r1 = make_result("KiloCode", "sonnet-4", "1-data-structure", 85.0);
    r1.run_id = run_id;
    let mut r2 = make_result("KiloCode", "sonnet-4", "2-simple-arch", 90.0);
    r2.run_id = run_id;

    queries::insert_result(&conn, &r1).unwrap();
    queries::insert_result(&conn, &r2).unwrap();

    let results = queries::list_by_run_id(&conn, &run_id).unwrap();
    assert_eq!(results.len(), 2);
}

#[test]
fn test_latest_result_for_combo() {
    let conn = open_memory_db().unwrap();

    use chrono::Duration;
    let mut r1 = make_result("KiloCode", "sonnet-4", "1-data-structure", 80.0);
    r1.timestamp = Utc::now() - Duration::seconds(60);
    queries::insert_result(&conn, &r1).unwrap();

    let mut r2 = make_result("KiloCode", "sonnet-4", "1-data-structure", 92.0);
    r2.timestamp = Utc::now();
    queries::insert_result(&conn, &r2).unwrap();

    let latest = queries::latest_result(&conn, "KiloCode", "sonnet-4", "1-data-structure")
        .unwrap()
        .unwrap();
    assert_eq!(latest.total_score, 92.0);
}

#[test]
fn test_summary_stats() {
    let conn = open_memory_db().unwrap();
    queries::insert_result(&conn, &make_result("KiloCode", "sonnet-4", "s1", 85.0)).unwrap();
    queries::insert_result(&conn, &make_result("Aider", "gpt-4o", "s1", 90.0)).unwrap();
    queries::insert_result(&conn, &make_result("Aider", "gpt-4o", "s2", 75.0)).unwrap();

    let stats = queries::summary_stats(&conn).unwrap();
    assert_eq!(stats.total_results, 3);
    assert_eq!(stats.unique_agents, 2);
    assert_eq!(stats.unique_models, 2);
    assert_eq!(stats.unique_scenarios, 2);
}

#[test]
fn test_recent_runs() {
    let conn = open_memory_db().unwrap();
    let run_id = Uuid::new_v4();
    let mut r = make_result("KiloCode", "sonnet-4", "s1", 85.0);
    r.run_id = run_id;
    queries::insert_result(&conn, &r).unwrap();

    let recent = queries::recent_runs(&conn, 5).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].run_id, run_id);
}

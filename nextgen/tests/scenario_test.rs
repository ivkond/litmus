use litmus_nextgen::scenario::load_scenarios;
use std::path::Path;

#[test]
fn test_load_scenarios_finds_directories() {
    let scenarios = load_scenarios(Path::new("tests/fixtures/template")).unwrap();
    assert_eq!(scenarios.len(), 1);
    assert_eq!(scenarios[0].id, "1-data-structure");
}

#[test]
fn test_load_scenario_reads_prompt() {
    let scenarios = load_scenarios(Path::new("tests/fixtures/template")).unwrap();
    assert!(scenarios[0].prompt.contains("TimeBasedKeyValueStore"));
}

#[test]
fn test_load_scenario_reads_task() {
    let scenarios = load_scenarios(Path::new("tests/fixtures/template")).unwrap();
    assert!(scenarios[0].task.contains("set(key, value, timestamp)"));
}

#[test]
fn test_load_scenario_parses_scoring() {
    let scenarios = load_scenarios(Path::new("tests/fixtures/template")).unwrap();
    let s = &scenarios[0];
    assert_eq!(s.scoring.len(), 5);
    assert_eq!(s.scoring[0].criterion, "Type hints");
    assert_eq!(s.scoring[0].score, 1);
    assert_eq!(s.scoring[1].criterion, "Correct get logic");
    assert_eq!(s.scoring[1].score, 6);
    assert_eq!(s.max_score, 10);
}

#[test]
fn test_load_scenarios_sorted_by_id() {
    let scenarios = load_scenarios(Path::new("tests/fixtures/template")).unwrap();
    assert!(!scenarios.is_empty());
}

#[test]
fn test_load_scenarios_empty_dir() {
    let dir = tempfile::tempdir().unwrap();
    let scenarios = load_scenarios(dir.path()).unwrap();
    assert!(scenarios.is_empty());
}

#[test]
fn test_load_scenarios_missing_dir() {
    let result = load_scenarios(Path::new("nonexistent/template"));
    assert!(result.is_err());
}

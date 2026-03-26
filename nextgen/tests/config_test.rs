use litmus_nextgen::config::load_config;
use std::path::Path;

#[test]
fn test_load_config_parses_agents() {
    let cfg = load_config(Path::new("tests/fixtures/config.yaml")).unwrap();
    assert_eq!(cfg.agents.len(), 2);
    assert_eq!(cfg.agents[0].name, "TestAgent");
    assert_eq!(cfg.agents[0].models, vec!["model-a", "model-b"]);
    assert_eq!(cfg.agents[1].name, "EmptyAgent");
    assert!(cfg.agents[1].models.is_empty());
}

#[test]
fn test_load_config_parses_analysis() {
    let cfg = load_config(Path::new("tests/fixtures/config.yaml")).unwrap();
    let analysis = cfg.analysis.unwrap();
    assert_eq!(analysis.model, "openai/gpt-4o");
    assert_eq!(analysis.base_url, "https://api.example.com/v1/");
}

#[test]
fn test_load_config_missing_file() {
    let result = load_config(Path::new("nonexistent.yaml"));
    assert!(result.is_err());
}

#[test]
fn test_load_config_no_analysis() {
    let yaml = "agents:\n- name: A\n  binary: /bin/a\n  cmd_template: a {model} {message}\n";
    let cfg: litmus_nextgen::model::Config = serde_yml::from_str(yaml).unwrap();
    assert!(cfg.analysis.is_none());
}

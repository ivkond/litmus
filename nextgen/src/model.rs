use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Agent configuration from config.yaml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    pub binary: String,
    pub cmd_template: String,
    #[serde(default)]
    pub models: Vec<String>,
}

/// LLM judge configuration from config.yaml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisConfig {
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

/// Top-level config.yaml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub analysis: Option<AnalysisConfig>,
}

/// A scoring criterion from scoring.csv
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoringCriterion {
    pub criterion: String,
    pub score: u32,
}

/// A loaded scenario from template/<id>/
#[derive(Debug, Clone)]
pub struct Scenario {
    pub id: String,
    pub prompt: String,
    pub task: String,
    pub scoring: Vec<ScoringCriterion>,
    pub max_score: u32,
    pub has_project: bool,
}

/// Manifest entry for a scenario inside a .litmus-pack file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackManifestEntry {
    pub stem: String,
    pub files: Vec<String>,
}

/// Top-level manifest for a .litmus-pack file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackManifest {
    pub format_version: u32,
    pub kind: String,
    pub exported_at: String,
    pub scenarios: Vec<PackManifestEntry>,
}

/// A single benchmark run result (the atomic "brick")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub id: Uuid,
    pub run_id: Uuid,
    pub agent: String,
    pub agent_version: String,
    pub model: String,
    pub scenario_id: String,
    pub scenario_version: String,
    pub timestamp: DateTime<Utc>,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub judge_scores: HashMap<String, f64>,
    pub judge_model: Option<String>,
    pub logs_path: String,
    pub code_path: String,
    pub total_score: f64,
    pub duration_seconds: u64,
}

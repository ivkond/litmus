# Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `nextgen/` Rust project with config parsing, scenario loading, and SQLite storage — the data foundation for all future phases.

**Architecture:** New Rust project in `nextgen/` subdirectory. Parses the existing `config.yaml` format (backward-compatible). Reads scenario templates from `../template/`. Stores run results in SQLite via `rusqlite` with schema migrations. No TUI yet — this phase is pure data layer with a CLI smoke-test binary.

**Tech Stack:** Rust 2024 edition, `serde` + `serde_yml` (YAML), `rusqlite` + `rusqlite_migration` (SQLite), `chrono` (timestamps), `uuid` (run IDs), `csv` (scoring.csv parsing), `thiserror` (error types)

**Spec:** `docs/superpowers/specs/2026-03-26-ux-redesign-ratatui-design.md`

**Compatibility:** Must read existing `config.yaml` and `template/` without changes. The Python litmus continues working alongside.

---

## File Structure

```
nextgen/
├── Cargo.toml
├── src/
│   ├── main.rs                # CLI smoke-test binary
│   ├── lib.rs                 # Re-exports all modules
│   ├── error.rs               # Error types (thiserror)
│   ├── model.rs               # Core data types: RunResult, AgentInfo, Scenario, etc.
│   ├── config.rs              # config.yaml parsing (serde_yml)
│   ├── scenario.rs            # Scenario loading from template/ directories
│   └── db/
│       ├── mod.rs             # Re-exports
│       ├── schema.rs          # SQLite schema + migrations
│       └── queries.rs         # Insert/query RunResult, aggregation queries
├── tests/
│   ├── fixtures/
│   │   ├── config.yaml        # Test config (no real API keys)
│   │   └── template/
│   │       └── 1-data-structure/
│   │           ├── prompt.txt
│   │           ├── task.txt
│   │           └── scoring.csv
│   ├── config_test.rs
│   ├── scenario_test.rs
│   └── db_test.rs
```

---

### Task 1: Cargo Project Scaffolding

**Files:**
- Create: `nextgen/Cargo.toml`
- Create: `nextgen/src/main.rs`
- Create: `nextgen/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "litmus-nextgen"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_yml = "0.0.12"
rusqlite = { version = "0.32", features = ["bundled"] }
rusqlite_migration = "2"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4", "serde"] }
csv = "1"
serde_json = "1"
thiserror = "2"
```

- [ ] **Step 2: Create src/main.rs**

```rust
fn main() {
    println!("litmus-nextgen: foundation OK");
}
```

- [ ] **Step 3: Create src/lib.rs**

```rust
pub mod config;
pub mod db;
pub mod error;
pub mod model;
pub mod scenario;
```

Note: This won't compile yet (modules don't exist). That's fine — we'll create them in order.

- [ ] **Step 4: Verify project compiles after all modules are stubbed**

We'll verify this at the end of Task 2.

---

### Task 2: Error Types and Core Data Model

**Files:**
- Create: `nextgen/src/error.rs`
- Create: `nextgen/src/model.rs`

- [ ] **Step 1: Create error.rs**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LitmusError {
    #[error("config error: {0}")]
    Config(String),

    #[error("scenario error: {0}")]
    Scenario(String),

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yml::Error),

    #[error("CSV parse error: {0}")]
    Csv(#[from] csv::Error),
}

pub type Result<T> = std::result::Result<T, LitmusError>;
```

- [ ] **Step 2: Create model.rs with core types**

```rust
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
#[derive(Debug, Clone)]
pub struct ScoringCriterion {
    pub criterion: String,
    pub score: u32,
}

/// A loaded scenario from template/<id>/
#[derive(Debug, Clone)]
pub struct Scenario {
    pub id: String,           // directory name, e.g. "1-data-structure"
    pub prompt: String,       // contents of prompt.txt
    pub task: String,         // contents of task.txt
    pub scoring: Vec<ScoringCriterion>,
    pub max_score: u32,       // sum of scoring criterion scores
    pub has_project: bool,    // whether project/ subdirectory exists
}

/// A single benchmark run result (the atomic "brick")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub id: Uuid,
    pub run_id: Uuid,              // groups results from same batch execution
    pub agent: String,
    pub agent_version: String,
    pub model: String,
    pub scenario_id: String,
    pub scenario_version: String,
    pub timestamp: DateTime<Utc>,

    // Automated test results
    pub tests_passed: u32,
    pub tests_total: u32,

    // LLM Judge scores (optional, filled after analysis)
    pub judge_scores: HashMap<String, f64>,
    pub judge_model: Option<String>,

    // Artifact paths (relative to results/ dir)
    pub logs_path: String,
    pub code_path: String,

    // Computed
    pub total_score: f64,
    pub duration_seconds: u64,
}
```

- [ ] **Step 3: Create stub modules so project compiles**

Create `nextgen/src/config.rs`:
```rust
// Config parsing — implemented in Task 3
```

Create `nextgen/src/scenario.rs`:
```rust
// Scenario loading — implemented in Task 4
```

Create `nextgen/src/db/mod.rs`:
```rust
pub mod queries;
pub mod schema;
```

Create `nextgen/src/db/schema.rs`:
```rust
// SQLite schema — implemented in Task 5
```

Create `nextgen/src/db/queries.rs`:
```rust
// Queries — implemented in Task 6
```

- [ ] **Step 4: Verify it compiles**

Run: `cd nextgen && cargo check`
Expected: compiles with no errors (maybe warnings for unused imports — that's OK)

- [ ] **Step 5: Commit**

```bash
git add nextgen/
git commit -m "feat(nextgen): scaffold Rust project with data model types"
```

---

### Task 3: Config Parsing

**Files:**
- Modify: `nextgen/src/config.rs`
- Create: `nextgen/tests/fixtures/config.yaml`
- Create: `nextgen/tests/config_test.rs`

- [ ] **Step 1: Create test fixture**

Create `nextgen/tests/fixtures/config.yaml`:
```yaml
agents:
- name: TestAgent
  binary: /usr/bin/test-agent
  cmd_template: test-agent --model {model} {message}
  models:
  - model-a
  - model-b
- name: EmptyAgent
  binary: /usr/bin/empty
  cmd_template: empty {model} {message}
analysis:
  model: openai/gpt-4o
  api_key: sk-test-key-123
  base_url: https://api.example.com/v1/
```

- [ ] **Step 2: Write the failing test**

Create `nextgen/tests/config_test.rs`:
```rust
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
    // YAML with agents only, no analysis section
    let yaml = "agents:\n- name: A\n  binary: /bin/a\n  cmd_template: a {model} {message}\n";
    let cfg: litmus_nextgen::model::Config = serde_yml::from_str(yaml).unwrap();
    assert!(cfg.analysis.is_none());
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd nextgen && cargo test --test config_test`
Expected: FAIL — `load_config` doesn't exist

- [ ] **Step 4: Implement config.rs**

```rust
use std::path::Path;

use crate::error::{LitmusError, Result};
use crate::model::Config;

/// Load and parse config.yaml from the given path.
pub fn load_config(path: &Path) -> Result<Config> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| LitmusError::Config(format!("{}: {}", path.display(), e)))?;
    let config: Config = serde_yml::from_str(&contents)?;
    if config.agents.is_empty() {
        return Err(LitmusError::Config("no agents defined in config".into()));
    }
    Ok(config)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd nextgen && cargo test --test config_test`
Expected: all 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add nextgen/src/config.rs nextgen/tests/
git commit -m "feat(nextgen): config.yaml parsing with serde_yml"
```

---

### Task 4: Scenario Loading

**Files:**
- Modify: `nextgen/src/scenario.rs`
- Create: `nextgen/tests/fixtures/template/1-data-structure/prompt.txt`
- Create: `nextgen/tests/fixtures/template/1-data-structure/task.txt`
- Create: `nextgen/tests/fixtures/template/1-data-structure/scoring.csv`
- Create: `nextgen/tests/scenario_test.rs`

- [ ] **Step 1: Create test fixtures**

Create the template fixture directory and files:

`nextgen/tests/fixtures/template/1-data-structure/prompt.txt`:
```
Implement a TimeBasedKeyValueStore class in main.py.
```

`nextgen/tests/fixtures/template/1-data-structure/task.txt`:
```
TimeBasedKeyValueStore: set(key, value, timestamp), get(key, timestamp).
```

`nextgen/tests/fixtures/template/1-data-structure/scoring.csv`:
```csv
criterion,score
Type hints,1
Correct get logic,6
Empty string on missing key,1
Efficient data structure,1
All tests pass,1
```

- [ ] **Step 2: Write the failing tests**

Create `nextgen/tests/scenario_test.rs`:
```rust
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
    // Even with one scenario, verify sorting works
    let scenarios = load_scenarios(Path::new("tests/fixtures/template")).unwrap();
    // With one item, just check it doesn't panic
    assert!(!scenarios.is_empty());
}

#[test]
fn test_load_scenarios_empty_dir() {
    // Temp dir with no scenario subdirectories
    let dir = tempfile::tempdir().unwrap();
    let scenarios = load_scenarios(dir.path()).unwrap();
    assert!(scenarios.is_empty());
}

#[test]
fn test_load_scenarios_missing_dir() {
    let result = load_scenarios(Path::new("nonexistent/template"));
    assert!(result.is_err());
}
```

Note: Add `tempfile = "3"` to `[dev-dependencies]` in Cargo.toml.

- [ ] **Step 3: Add dev-dependency**

Add to `nextgen/Cargo.toml`:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd nextgen && cargo test --test scenario_test`
Expected: FAIL — `load_scenarios` doesn't exist

- [ ] **Step 5: Implement scenario.rs**

```rust
use std::path::Path;

use crate::error::{LitmusError, Result};
use crate::model::{Scenario, ScoringCriterion};

/// Load all scenarios from a template directory.
/// Each subdirectory containing prompt.txt is treated as a scenario.
pub fn load_scenarios(template_dir: &Path) -> Result<Vec<Scenario>> {
    if !template_dir.exists() {
        return Err(LitmusError::Scenario(format!(
            "template directory not found: {}",
            template_dir.display()
        )));
    }

    let mut scenarios = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(template_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let dir = entry.path();
        let prompt_path = dir.join("prompt.txt");
        if !prompt_path.exists() {
            continue; // Not a scenario directory
        }

        let id = entry.file_name().to_string_lossy().to_string();
        let prompt = std::fs::read_to_string(&prompt_path)?;
        let task = read_optional_file(&dir.join("task.txt"))?;
        let scoring = load_scoring(&dir.join("scoring.csv"))?;
        let max_score = scoring.iter().map(|c| c.score).sum();
        let has_project = dir.join("project").is_dir();

        scenarios.push(Scenario {
            id,
            prompt,
            task,
            scoring,
            max_score,
            has_project,
        });
    }

    Ok(scenarios)
}

fn read_optional_file(path: &Path) -> Result<String> {
    if path.exists() {
        Ok(std::fs::read_to_string(path)?)
    } else {
        Ok(String::new())
    }
}

fn load_scoring(path: &Path) -> Result<Vec<ScoringCriterion>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let mut reader = csv::Reader::from_path(path)?;
    let mut criteria = Vec::new();
    for record in reader.records() {
        let record = record?;
        let criterion = record.get(0).unwrap_or("").to_string();
        let score: u32 = record
            .get(1)
            .unwrap_or("0")
            .trim()
            .parse()
            .unwrap_or(0);
        criteria.push(ScoringCriterion { criterion, score });
    }
    Ok(criteria)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd nextgen && cargo test --test scenario_test`
Expected: all 7 tests PASS

- [ ] **Step 7: Commit**

```bash
git add nextgen/
git commit -m "feat(nextgen): scenario loading from template directories"
```

---

### Task 5: SQLite Schema and Migrations

**Files:**
- Modify: `nextgen/src/db/schema.rs`
- Modify: `nextgen/src/db/mod.rs`

- [ ] **Step 1: Write the failing test (inline in schema.rs)**

Add to `nextgen/src/db/schema.rs`:
```rust
use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

use crate::error::Result;

/// All database migrations, applied in order.
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(
            "CREATE TABLE run_results (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                agent TEXT NOT NULL,
                agent_version TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL,
                scenario_id TEXT NOT NULL,
                scenario_version TEXT NOT NULL DEFAULT 'v1',
                timestamp TEXT NOT NULL,
                tests_passed INTEGER NOT NULL DEFAULT 0,
                tests_total INTEGER NOT NULL DEFAULT 0,
                judge_scores TEXT NOT NULL DEFAULT '{}',
                judge_model TEXT,
                logs_path TEXT NOT NULL DEFAULT '',
                code_path TEXT NOT NULL DEFAULT '',
                total_score REAL NOT NULL DEFAULT 0.0,
                duration_seconds INTEGER NOT NULL DEFAULT 0
            )",
        ),
        M::up(
            "CREATE INDEX idx_run_results_agent_model
             ON run_results(agent, model)",
        ),
        M::up(
            "CREATE INDEX idx_run_results_scenario
             ON run_results(scenario_id)",
        ),
        M::up(
            "CREATE INDEX idx_run_results_run_id
             ON run_results(run_id)",
        ),
    ])
}

/// Open (or create) the database and apply all pending migrations.
pub fn open_db(path: &std::path::Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

/// Open an in-memory database (for tests).
pub fn open_memory_db() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_memory_db_creates_tables() {
        let conn = open_memory_db().unwrap();
        // Verify run_results table exists by querying it
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_results", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_migrations_are_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations().to_latest(&mut conn).unwrap();
        // Running again should be a no-op
        migrations().to_latest(&mut conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_results", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
```

- [ ] **Step 2: Update db/mod.rs**

```rust
pub mod queries;
pub mod schema;

pub use schema::{open_db, open_memory_db};
```

- [ ] **Step 3: Run tests**

Run: `cd nextgen && cargo test db::schema`
Expected: 2 tests PASS

- [ ] **Step 4: Commit**

```bash
git add nextgen/src/db/
git commit -m "feat(nextgen): SQLite schema with migrations"
```

---

### Task 6: Database Queries (Insert + Read + Aggregation)

**Files:**
- Modify: `nextgen/src/db/queries.rs`
- Create: `nextgen/tests/db_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `nextgen/tests/db_test.rs`:
```rust
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

    // Insert two results for same agent/model/scenario with explicit timestamps
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
    // Should be the most recent (r2, score 92.0)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd nextgen && cargo test --test db_test`
Expected: FAIL — `queries::insert_result` doesn't exist

- [ ] **Step 3: Implement queries.rs**

```rust
use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::error::Result;
use crate::model::RunResult;

/// Insert a RunResult into the database.
pub fn insert_result(conn: &Connection, r: &RunResult) -> Result<()> {
    let judge_scores_json = serde_json::to_string(&r.judge_scores)
        .unwrap_or_else(|_| "{}".to_string());

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
    let mut stmt = conn.prepare(
        "SELECT * FROM run_results WHERE id = ?1"
    )?;
    let result = stmt
        .query_row(params![id.to_string()], row_to_run_result)
        .optional()?;
    Ok(result)
}

/// List all results belonging to a batch run.
pub fn list_by_run_id(conn: &Connection, run_id: &Uuid) -> Result<Vec<RunResult>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM run_results WHERE run_id = ?1 ORDER BY scenario_id"
    )?;
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
         ORDER BY timestamp DESC LIMIT 1"
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
    let total_results: u64 = conn.query_row(
        "SELECT COUNT(*) FROM run_results", [], |r| r.get(0)
    )?;
    let unique_agents: u64 = conn.query_row(
        "SELECT COUNT(DISTINCT agent) FROM run_results", [], |r| r.get(0)
    )?;
    let unique_models: u64 = conn.query_row(
        "SELECT COUNT(DISTINCT model) FROM run_results", [], |r| r.get(0)
    )?;
    let unique_scenarios: u64 = conn.query_row(
        "SELECT COUNT(DISTINCT scenario_id) FROM run_results", [], |r| r.get(0)
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
         LIMIT ?1"
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd nextgen && cargo test --test db_test`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add nextgen/
git commit -m "feat(nextgen): SQLite queries for RunResult CRUD and aggregation"
```

---

### Task 7: CLI Smoke Test — Full Pipeline

**Files:**
- Modify: `nextgen/src/main.rs`

- [ ] **Step 1: Update main.rs to exercise the full pipeline**

```rust
use std::path::Path;

fn main() {
    println!("litmus-nextgen: Phase 1 smoke test\n");

    // 1. Load config
    let config_path = Path::new("../config.yaml");
    match litmus_nextgen::config::load_config(config_path) {
        Ok(cfg) => {
            println!("Config: {} agent(s)", cfg.agents.len());
            for a in &cfg.agents {
                println!("  - {} ({} models)", a.name, a.models.len());
            }
            if let Some(ref analysis) = cfg.analysis {
                println!("  Judge: {}", analysis.model);
            }
        }
        Err(e) => println!("Config error (expected if no config.yaml): {e}"),
    }

    // 2. Load scenarios
    let template_path = Path::new("../template");
    match litmus_nextgen::scenario::load_scenarios(template_path) {
        Ok(scenarios) => {
            println!("\nScenarios: {} found", scenarios.len());
            for s in &scenarios {
                println!(
                    "  - {} (max_score={}, has_project={})",
                    s.id, s.max_score, s.has_project
                );
            }
        }
        Err(e) => println!("Scenario error (expected if no template/): {e}"),
    }

    // 3. Open DB
    let db_path = Path::new("litmus.db");
    match litmus_nextgen::db::open_db(db_path) {
        Ok(conn) => {
            let stats = litmus_nextgen::db::queries::summary_stats(&conn).unwrap();
            println!(
                "\nDatabase: {} results, {} agents, {} models, {} scenarios",
                stats.total_results,
                stats.unique_agents,
                stats.unique_models,
                stats.unique_scenarios
            );
        }
        Err(e) => println!("DB error: {e}"),
    }

    // Clean up test db
    let _ = std::fs::remove_file(db_path);

    println!("\nPhase 1 foundation: OK");
}
```

- [ ] **Step 2: Run the smoke test**

Run: `cd nextgen && cargo run`
Expected output (approximate):
```
litmus-nextgen: Phase 1 smoke test

Config: 1 agent(s)
  - OpenCode (2 models)
  Judge: openai/gpt-oss-120b

Scenarios: 8 found
  - 1-data-structure (max_score=10, has_project=true)
  - 2-simple-architecture (max_score=..., has_project=...)
  ...

Database: 0 results, 0 agents, 0 models, 0 scenarios

Phase 1 foundation: OK
```

- [ ] **Step 3: Run all tests together**

Run: `cd nextgen && cargo test`
Expected: all tests PASS (config_test + scenario_test + db_test + inline db::schema tests)

- [ ] **Step 4: Commit**

```bash
git add nextgen/src/main.rs
git commit -m "feat(nextgen): CLI smoke test exercising full Phase 1 pipeline"
```

---

## Summary

After Phase 1, we have:

| Component | Status |
|-----------|--------|
| Cargo project in `nextgen/` | Working |
| `Config` parsing from `config.yaml` | Working + tested |
| `Scenario` loading from `template/` | Working + tested |
| SQLite schema with migrations | Working + tested |
| CRUD queries for `RunResult` | Working + tested |
| Aggregation queries (stats, recent runs) | Working + tested |
| CLI smoke test | Working |

**Next phase:** Phase 2 — TUI Shell (ratatui app, event loop, tab navigation, Dashboard screen)

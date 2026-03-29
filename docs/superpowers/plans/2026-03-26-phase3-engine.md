# Phase 3: Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the non-UI engine that detects agents, lists models, runs benchmarks (as subprocesses), and stores results — everything the Run screen (Phase 4) will need.

**Architecture:** New `engine` module with 7 focused files. Agent registry defines 6 hardcoded agents. Scanner detects binaries via `which` crate and fetches model lists. Runner orchestrates single-scenario execution (copy project → git init → uv sync → agent call → pytest → retry). Batch runner executes parallel lanes (one per agent×model pair) with progress reporting via `std::sync::mpsc`.

**Tech Stack:** Rust std (`Command`, `thread`, `mpsc`), `which` crate (binary lookup), existing `rusqlite` + `serde_yml`. No async runtime needed — subprocess I/O is inherently blocking; threads are simpler and sufficient.

---

## File Structure

```
nextgen/src/engine/
├── mod.rs          # Module declarations + re-exports
├── registry.rs     # Agent definitions (6 agents, cmd_templates, model parsers)
├── encoding.rs     # Model name ↔ filesystem-safe tilde encoding
├── scanner.rs      # Binary detection (which) + model listing (subprocess)
├── session.rs      # Session/run directory creation, run_config.yaml
├── steplog.rs      # Progressive steps.json writer
├── runner.rs       # Single scenario execution (the core loop)
└── batch.rs        # Parallel lane runner + progress channel
```

**Existing files to modify:**
- `src/lib.rs` — add `pub mod engine;`
- `src/error.rs` — add `Engine` variant
- `Cargo.toml` — add `which = "7"` and `shell-words = "1"` dependencies

---

## Dependency: `which` crate

Add to `Cargo.toml`:
```toml
which = "7"
```

This provides `which::which("binary_name")` → `Result<PathBuf>`, equivalent to Python's `shutil.which()`. Cross-platform.

---

### Task 1: Agent Registry

**Files:**
- Create: `src/engine/mod.rs`
- Create: `src/engine/registry.rs`
- Modify: `src/lib.rs` (add `pub mod engine;`)
- Test: inline `#[cfg(test)]` in `registry.rs`

The registry defines the 6 hardcoded agent specifications. Each agent has: name, binary names to search, command template, model command (or None + hardcoded list), and a stdout parser type.

- [ ] **Step 1: Create engine module**

`src/engine/mod.rs`:
```rust
pub mod registry;
```

Add to `src/lib.rs`:
```rust
pub mod engine;
```

- [ ] **Step 2: Write failing test for agent registry**

`src/engine/registry.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_has_six_agents() {
        assert_eq!(AGENTS.len(), 6);
    }

    #[test]
    fn test_claude_code_has_known_models() {
        let claude = AGENTS.iter().find(|a| a.name == "Claude Code").unwrap();
        assert!(claude.model_cmd.is_none());
        assert!(!claude.known_models.is_empty());
        assert!(claude.known_models.contains(&"claude-sonnet-4-6"));
    }

    #[test]
    fn test_kilocode_has_model_cmd() {
        let kilo = AGENTS.iter().find(|a| a.name == "KiloCode").unwrap();
        assert!(kilo.model_cmd.is_some());
        assert!(kilo.known_models.is_empty());
    }

    #[test]
    fn test_all_agents_have_cmd_template_with_placeholders() {
        for agent in AGENTS {
            assert!(agent.cmd_template.contains("{model}"),
                "{} missing {{model}} placeholder", agent.name);
            assert!(agent.cmd_template.contains("{message}"),
                "{} missing {{message}} placeholder", agent.name);
        }
    }

    #[test]
    fn test_parse_lines_strips_ansi_and_headers() {
        let raw = "\x1b[32mAvailable models:\x1b[0m\nmodel-a\nmodel-b\n\n";
        let models = parse_lines(raw);
        assert_eq!(models, vec!["model-a", "model-b"]);
    }

    #[test]
    fn test_parse_aider_extracts_dashed_lines() {
        let raw = "Aider models:\n- gpt-4o\n- claude-3\nSome footer";
        let models = parse_aider(raw);
        assert!(models.contains(&"gpt-4o".to_string()));
        assert!(models.contains(&"claude-3".to_string()));
    }
}
```

Run: `cargo test --lib engine::registry -- -v`
Expected: FAIL (module doesn't exist yet)

- [ ] **Step 3: Implement agent registry**

`src/engine/registry.rs`:
```rust
/// Hardcoded agent definitions — the source of truth for known agents.

/// How to parse the stdout of a model-listing command.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ModelParser {
    /// Default: one model per line, skip headers/blanks/ANSI.
    Lines,
    /// Aider: lines starting with "- " prefix.
    Aider,
    /// Cursor: strip "(current)"/"(default)" annotations.
    Cursor,
}

/// A known agent specification (not a detected instance).
#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub name: &'static str,
    pub binaries: &'static [&'static str],
    pub cmd_template: &'static str,
    /// Command to list models. None = use known_models instead.
    pub model_cmd: Option<&'static [&'static str]>,
    /// Hardcoded model list (used when model_cmd is None).
    pub known_models: &'static [&'static str],
    pub parser: ModelParser,
}

pub static AGENTS: &[AgentSpec] = &[
    AgentSpec {
        name: "Claude Code",
        binaries: &["claude"],
        cmd_template: "claude -p --dangerously-skip-permissions --model {model} {message}",
        model_cmd: None,
        known_models: &[
            "claude-sonnet-4-5",
            "claude-opus-4",
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-haiku-4-5",
        ],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "Codex",
        binaries: &["codex"],
        cmd_template: "codex exec --json --full-auto -m {model} {message}",
        model_cmd: None,
        known_models: &["o4-mini", "o3", "gpt-4.1", "codex-mini"],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "OpenCode",
        binaries: &["opencode"],
        cmd_template: "opencode run --thinking --model {model} {message}",
        model_cmd: Some(&["opencode", "models"]),
        known_models: &[],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "KiloCode",
        binaries: &["kilocode", "kilo"],
        cmd_template: "kilocode run --auto --thinking --model {model} {message}",
        model_cmd: Some(&["kilocode", "models"]),
        known_models: &[],
        parser: ModelParser::Lines,
    },
    AgentSpec {
        name: "Aider",
        binaries: &["aider"],
        cmd_template: "aider --yes-always --model {model} --message {message}",
        model_cmd: Some(&["aider", "--list-models", "*"]),
        known_models: &[],
        parser: ModelParser::Aider,
    },
    AgentSpec {
        name: "Cursor Agent",
        binaries: &["agent"],
        cmd_template: "agent --print --force --trust --model {model} {message}",
        model_cmd: Some(&["agent", "models"]),
        known_models: &[],
        parser: ModelParser::Cursor,
    },
];

// ── Stdout parsers ─────────────────────────────────────────────

/// Strip ANSI escape codes from a string.
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_escape = false;
    for ch in s.chars() {
        if in_escape {
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
        } else if ch == '\x1b' {
            in_escape = true;
        } else {
            result.push(ch);
        }
    }
    result
}

const SKIP_PREFIXES: &[&str] = &[
    "available", "models", "loading", "fetching", "tip:",
];

/// Default parser: one model per non-blank, non-header line.
pub fn parse_lines(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| strip_ansi(l).trim().to_string())
        .filter(|l| {
            if l.is_empty() || l.starts_with("---") || l.starts_with("===") {
                return false;
            }
            let lower = l.to_lowercase();
            !SKIP_PREFIXES.iter().any(|p| lower.starts_with(p))
        })
        .collect()
}

/// Aider parser: lines starting with "- " prefix.
pub fn parse_aider(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| strip_ansi(l).trim().to_string())
        .filter_map(|l| l.strip_prefix("- ").map(|s| s.to_string()))
        .filter(|l| !l.is_empty())
        .collect()
}

/// Cursor parser: strip "(current)"/"(default)" annotations.
pub fn parse_cursor(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| strip_ansi(l).trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|l| {
            let l = l.replace("(current)", "").replace("(default)", "");
            match l.split_once(" - ") {
                Some((model, _)) => model.trim().to_string(),
                None => l.trim().to_string(),
            }
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// Parse stdout using the specified parser type.
pub fn parse_models(parser: ModelParser, stdout: &str) -> Vec<String> {
    match parser {
        ModelParser::Lines => parse_lines(stdout),
        ModelParser::Aider => parse_aider(stdout),
        ModelParser::Cursor => parse_cursor(stdout),
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test --lib engine::registry -- -v`
Expected: all 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/engine/ src/lib.rs
git commit -m "feat(engine): agent registry with 6 agents and stdout parsers"
```

---

### Task 2: Model Name Encoding

**Files:**
- Create: `src/engine/encoding.rs`
- Modify: `src/engine/mod.rs` (add `pub mod encoding;`)
- Test: inline `#[cfg(test)]` in `encoding.rs`

Tilde-encoding converts model names like `kilo/arcee-ai/model:free` to filesystem-safe `kilo~farcee-ai~fmodel~cfree`. This is needed for result directory naming.

Rules: `~` → `~~`, `/` → `~f`, `:` → `~c`. Decoding reverses these.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_simple_name() {
        assert_eq!(encode_model_name("gpt-4o"), "gpt-4o");
    }

    #[test]
    fn test_encode_slashes() {
        assert_eq!(
            encode_model_name("kilo/arcee-ai/trinity:free"),
            "kilo~farcee-ai~ftrinity~cfree"
        );
    }

    #[test]
    fn test_encode_tilde_escaped() {
        assert_eq!(encode_model_name("model~name"), "model~~name");
    }

    #[test]
    fn test_roundtrip() {
        let original = "kilo/arcee-ai/trinity~large:free";
        assert_eq!(decode_model_name(&encode_model_name(original)), original);
    }

    #[test]
    fn test_decode_plain() {
        assert_eq!(decode_model_name("gpt-4o"), "gpt-4o");
    }

    #[test]
    fn test_run_dir_name() {
        assert_eq!(
            run_dir_name("KiloCode", "kilo/model:free"),
            "KiloCode_kilo~fmodel~cfree"
        );
    }
}
```

- [ ] **Step 2: Implement encoding**

```rust
/// Encode a model name for use in filesystem paths.
/// Rules: ~ → ~~, / → ~f, : → ~c
pub fn encode_model_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '~' => out.push_str("~~"),
            '/' => out.push_str("~f"),
            ':' => out.push_str("~c"),
            _ => out.push(ch),
        }
    }
    out
}

/// Decode a tilde-encoded model name back to the original.
pub fn decode_model_name(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len());
    let mut chars = encoded.chars();
    while let Some(ch) = chars.next() {
        if ch == '~' {
            match chars.next() {
                Some('~') => out.push('~'),
                Some('f') => out.push('/'),
                Some('c') => out.push(':'),
                Some(other) => { out.push('~'); out.push(other); }
                None => out.push('~'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Build the run directory name: `{agent_name}_{encoded_model}`.
pub fn run_dir_name(agent: &str, model: &str) -> String {
    format!("{}_{}", agent, encode_model_name(model))
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cargo test --lib engine::encoding -- -v`

- [ ] **Step 4: Commit**

```bash
git add src/engine/encoding.rs src/engine/mod.rs
git commit -m "feat(engine): tilde encoding for model names in filesystem paths"
```

---

### Task 3: Agent Scanner

**Files:**
- Create: `src/engine/scanner.rs`
- Modify: `src/engine/mod.rs` (add `pub mod scanner;`)
- Modify: `Cargo.toml` (add `which = "7"`)
- Test: inline `#[cfg(test)]` in `scanner.rs`

Scanner detects installed agents via `which` (binary lookup in PATH), then fetches model lists via subprocess. Results are cached to `.agents_cache.yaml`.

- [ ] **Step 1: Add `which` dependency**

In `Cargo.toml`, add:
```toml
which = "7"
```

- [ ] **Step 2: Write failing tests**

Tests for scanner use the agent registry but mock-free testing by checking the structure. The actual binary detection tests are `#[ignore]` (require real agents installed).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::registry::AGENTS;

    #[test]
    fn test_detected_agent_from_spec_with_known_models() {
        let claude = AGENTS.iter().find(|a| a.name == "Claude Code").unwrap();
        let detected = DetectedAgent {
            name: claude.name.to_string(),
            path: "/usr/bin/claude".into(),
            models: claude.known_models.iter().map(|s| s.to_string()).collect(),
            cmd_template: claude.cmd_template.to_string(),
            error: None,
        };
        assert_eq!(detected.models.len(), 5);
        assert!(detected.error.is_none());
    }

    #[test]
    fn test_scan_result_separates_found_and_not_found() {
        let result = ScanResult {
            detected: vec![DetectedAgent {
                name: "TestAgent".into(),
                path: "/bin/test".into(),
                models: vec!["m1".into()],
                cmd_template: "test {model} {message}".into(),
                error: None,
            }],
            not_found: vec!["MissingAgent".into()],
        };
        assert_eq!(result.detected.len(), 1);
        assert_eq!(result.not_found.len(), 1);
    }

    #[test]
    fn test_cache_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join(".agents_cache.yaml");

        let result = ScanResult {
            detected: vec![DetectedAgent {
                name: "TestAgent".into(),
                path: "/bin/test".into(),
                models: vec!["model-a".into(), "model-b".into()],
                cmd_template: "test --model {model} {message}".into(),
                error: None,
            }],
            not_found: vec!["MissingAgent".into()],
        };

        save_cache(&cache_path, &result).unwrap();
        let loaded = load_cache(&cache_path).unwrap();
        assert_eq!(loaded.detected.len(), 1);
        assert_eq!(loaded.detected[0].models.len(), 2);
        assert_eq!(loaded.not_found, vec!["MissingAgent"]);
    }
}
```

- [ ] **Step 3: Implement scanner**

```rust
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::engine::registry::{self, AgentSpec, AGENTS};
use crate::error::{LitmusError, Result};

/// A detected agent instance (binary found in PATH).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedAgent {
    pub name: String,
    pub path: String,
    pub version: String,
    pub models: Vec<String>,
    pub cmd_template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Full scan result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub detected: Vec<DetectedAgent>,
    pub not_found: Vec<String>,
}

/// Detect which agents are installed and fetch their model lists.
pub fn scan_agents() -> ScanResult {
    let mut detected = Vec::new();
    let mut not_found = Vec::new();

    for spec in AGENTS {
        match detect_binary(spec) {
            Some(path) => {
                let (models, error) = fetch_models(spec, &path);
                detected.push(DetectedAgent {
                    name: spec.name.to_string(),
                    path: path.to_string_lossy().to_string(),
                    models,
                    cmd_template: spec.cmd_template.to_string(),
                    error,
                });
            }
            None => {
                not_found.push(spec.name.to_string());
            }
        }
    }

    ScanResult { detected, not_found }
}

/// Check if any of the agent's binary names exist in PATH.
fn detect_binary(spec: &AgentSpec) -> Option<PathBuf> {
    for bin in spec.binaries {
        if let Ok(path) = which::which(bin) {
            return Some(path);
        }
    }
    None
}

/// Fetch models for a detected agent. Returns (models, optional error message).
fn fetch_models(spec: &AgentSpec, binary_path: &Path) -> (Vec<String>, Option<String>) {
    match spec.model_cmd {
        None => {
            // Use hardcoded known_models
            let models = spec.known_models.iter().map(|s| s.to_string()).collect();
            (models, None)
        }
        Some(cmd_parts) => {
            // Run subprocess: replace first token with resolved binary path
            let mut cmd = Command::new(binary_path);
            for arg in &cmd_parts[1..] {
                cmd.arg(arg);
            }

            match cmd.output() {
                Ok(output) => {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let models = registry::parse_models(spec.parser, &stdout);
                        if models.is_empty() {
                            (Vec::new(), Some("command succeeded but no models parsed".into()))
                        } else {
                            (models, None)
                        }
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        (Vec::new(), Some(format!("exit code {}: {}", output.status, stderr.trim())))
                    }
                }
                Err(e) => (Vec::new(), Some(format!("failed to run: {}", e))),
            }
        }
    }
}

/// Save scan result to cache file.
pub fn save_cache(path: &Path, result: &ScanResult) -> Result<()> {
    let yaml = serde_yml::to_string(result)
        .map_err(|e| LitmusError::Config(format!("serialize cache: {}", e)))?;
    std::fs::write(path, yaml)?;
    Ok(())
}

/// Load scan result from cache file.
pub fn load_cache(path: &Path) -> Result<ScanResult> {
    let contents = std::fs::read_to_string(path)?;
    let result: ScanResult = serde_yml::from_str(&contents)?;
    Ok(result)
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test --lib engine::scanner -- -v`

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/engine/scanner.rs src/engine/mod.rs
git commit -m "feat(engine): agent scanner with binary detection and model listing"
```

---

### Task 4: Session Directory Management

**Files:**
- Create: `src/engine/session.rs`
- Modify: `src/engine/mod.rs` (add `pub mod session;`)
- Test: inline `#[cfg(test)]` in `session.rs`

Manages the `results/<session>/<run_name>/<scenario_id>/` directory tree and writes `run_config.yaml`.

Session name format: `YYYYmmdd_HHMMSS` (e.g. `20260326_143012`).
Run name format: `{agent_name}_{encoded_model}` (uses encoding from Task 2).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_name_format() {
        let name = new_session_name();
        // Format: 8 digits _ 6 digits
        assert_eq!(name.len(), 15);
        assert_eq!(&name[8..9], "_");
    }

    #[test]
    fn test_create_session_dir() {
        let dir = tempfile::tempdir().unwrap();
        let results_dir = dir.path().join("results");
        let session = create_session(&results_dir).unwrap();
        assert!(session.path.exists());
    }

    #[test]
    fn test_create_run_dir() {
        let dir = tempfile::tempdir().unwrap();
        let session = create_session(&dir.path().join("results")).unwrap();
        let run_dir = create_run_dir(&session.path, "KiloCode", "kilo/model:free").unwrap();
        assert!(run_dir.exists());
        assert!(run_dir.file_name().unwrap().to_string_lossy().contains("KiloCode_kilo~fmodel~cfree"));
    }

    #[test]
    fn test_create_scenario_work_dir() {
        let dir = tempfile::tempdir().unwrap();
        let session = create_session(&dir.path().join("results")).unwrap();
        let run_dir = create_run_dir(&session.path, "TestAgent", "model").unwrap();
        let work_dir = create_scenario_dir(&run_dir, "1-data-structure").unwrap();
        assert!(work_dir.exists());
        assert!(work_dir.join("workdir").exists());
    }

    #[test]
    fn test_save_run_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = RunConfig {
            agents: vec![RunAgentConfig {
                name: "TestAgent".into(),
                cmd_template: "test {model} {message}".into(),
                models: vec!["model-a".into()],
            }],
            scenarios: vec!["1-data-structure".into()],
        };
        save_run_config(&dir.path(), &config).unwrap();
        assert!(dir.path().join("run_config.yaml").exists());
    }
}
```

- [ ] **Step 2: Implement session management**

```rust
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::engine::encoding;
use crate::error::Result;

/// A created session directory.
pub struct Session {
    pub name: String,
    pub path: PathBuf,
}

/// Run configuration saved at session start for reproducibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunConfig {
    pub agents: Vec<RunAgentConfig>,
    pub scenarios: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunAgentConfig {
    pub name: String,
    pub cmd_template: String,
    pub models: Vec<String>,
}

/// Generate a session name from current local time.
pub fn new_session_name() -> String {
    Local::now().format("%Y%m%d_%H%M%S").to_string()
}

/// Create a new session directory under `results_dir/`.
pub fn create_session(results_dir: &Path) -> Result<Session> {
    let name = new_session_name();
    let path = results_dir.join(&name);
    std::fs::create_dir_all(&path)?;
    Ok(Session { name, path })
}

/// Create a run directory: `session_dir/{agent}_{encoded_model}/`.
pub fn create_run_dir(session_dir: &Path, agent: &str, model: &str) -> Result<PathBuf> {
    let dir_name = encoding::run_dir_name(agent, model);
    let path = session_dir.join(dir_name);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// Create a scenario work directory with inner `workdir/` for the agent.
pub fn create_scenario_dir(run_dir: &Path, scenario_id: &str) -> Result<PathBuf> {
    let work_dir = run_dir.join(scenario_id);
    let agent_dir = work_dir.join("workdir");
    std::fs::create_dir_all(&agent_dir)?;
    Ok(work_dir)
}

/// Save run configuration to `session_dir/run_config.yaml`.
pub fn save_run_config(session_dir: &Path, config: &RunConfig) -> Result<()> {
    let yaml = serde_yml::to_string(config)
        .map_err(|e| crate::error::LitmusError::Config(format!("serialize run config: {}", e)))?;
    std::fs::write(session_dir.join("run_config.yaml"), yaml)?;
    Ok(())
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cargo test --lib engine::session -- -v`

- [ ] **Step 4: Commit**

```bash
git add src/engine/session.rs src/engine/mod.rs
git commit -m "feat(engine): session and run directory management"
```

---

### Task 5: Step Log

**Files:**
- Create: `src/engine/steplog.rs`
- Modify: `src/engine/mod.rs` (add `pub mod steplog;`)
- Test: inline `#[cfg(test)]` in `steplog.rs`

Progressive `steps.json` writer. Each step has a name, log file reference, status, timing. The file is rewritten after every status change so partial results survive crashes.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_steplog_begin_and_finish() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = StepLog::new(dir.path().to_path_buf());

        let idx = log.begin("Project init", "01_sync.log");
        assert_eq!(log.steps[idx].status, StepStatus::Running);

        log.finish(idx, StepStatus::Done);
        assert_eq!(log.steps[idx].status, StepStatus::Done);
        assert!(log.steps[idx].elapsed_secs > 0.0 || log.steps[idx].elapsed_secs == 0.0);

        // File should exist
        assert!(dir.path().join("steps.json").exists());
    }

    #[test]
    fn test_steplog_serialization() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = StepLog::new(dir.path().to_path_buf());

        log.begin("Step 1", "01.log");
        log.finish(0, StepStatus::Done);
        log.begin("Step 2", "02.log");
        log.finish(1, StepStatus::Failed);

        let contents = std::fs::read_to_string(dir.path().join("steps.json")).unwrap();
        let steps: Vec<serde_json::Value> = serde_json::from_str(&contents).unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["status"], "done");
        assert_eq!(steps[1]["status"], "failed");
    }

    #[test]
    fn test_log_file_name_generation() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = StepLog::new(dir.path().to_path_buf());

        let name = log.next_log_name("sync");
        assert_eq!(name, "01_sync.log");

        log.begin("Step", &name);
        let name2 = log.next_log_name("agent");
        assert_eq!(name2, "02_agent.log");
    }
}
```

- [ ] **Step 2: Implement step log**

```rust
use std::path::PathBuf;
use std::time::Instant;

use chrono::Local;
use serde::{Deserialize, Serialize};

/// Status of a single execution step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// A single step entry in steps.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepEntry {
    pub name: String,
    pub log_file: String,
    pub status: StepStatus,
    pub start_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
    pub elapsed_secs: f64,

    #[serde(skip)]
    start_instant: Option<Instant>,
}

/// Progressive steps.json writer.
pub struct StepLog {
    dir: PathBuf,
    pub steps: Vec<StepEntry>,
    counter: usize,
}

impl StepLog {
    pub fn new(dir: PathBuf) -> Self {
        StepLog {
            dir,
            steps: Vec::new(),
            counter: 0,
        }
    }

    /// Generate the next numbered log file name: `01_tag.log`, `02_tag.log`, etc.
    pub fn next_log_name(&self, tag: &str) -> String {
        format!("{:02}_{}.log", self.counter + 1, tag)
    }

    /// Begin a new step. Returns the step index.
    pub fn begin(&mut self, name: &str, log_file: &str) -> usize {
        let idx = self.steps.len();
        self.counter = idx + 1;
        self.steps.push(StepEntry {
            name: name.to_string(),
            log_file: log_file.to_string(),
            status: StepStatus::Running,
            start_time: Local::now().format("%H:%M:%S").to_string(),
            end_time: None,
            elapsed_secs: 0.0,
            start_instant: Some(Instant::now()),
        });
        self.flush();
        idx
    }

    /// Finish a step with the given status.
    pub fn finish(&mut self, idx: usize, status: StepStatus) {
        if let Some(step) = self.steps.get_mut(idx) {
            step.status = status;
            step.end_time = Some(Local::now().format("%H:%M:%S").to_string());
            if let Some(start) = step.start_instant.take() {
                step.elapsed_secs = start.elapsed().as_secs_f64();
            }
        }
        self.flush();
    }

    /// Write steps.json to disk (overwrites on every call).
    fn flush(&self) {
        let path = self.dir.join("steps.json");
        if let Ok(json) = serde_json::to_string_pretty(&self.steps) {
            let _ = std::fs::write(path, json);
        }
    }
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cargo test --lib engine::steplog -- -v`

- [ ] **Step 4: Commit**

```bash
git add src/engine/steplog.rs src/engine/mod.rs
git commit -m "feat(engine): progressive steps.json writer"
```

---

### Task 6: Scenario Runner

**Files:**
- Create: `src/engine/runner.rs`
- Modify: `src/engine/mod.rs` (add `pub mod runner;`)
- Modify: `src/error.rs` (add `Engine` variant)
- Test: inline `#[cfg(test)]` in `runner.rs`

The core execution flow for a single scenario:
1. Copy project files from template (excluding `test.py`, `__pycache__`)
2. Git init in workdir
3. `uv sync` (if pyproject.toml exists)
4. Agent call (build argv from template, substitute `{model}` and `{message}`)
5. Copy `test.py` from template, run `uv run pytest test.py -v`
6. On failure: retry up to 2 times (send test output back to agent)

**Important implementation details from Python version:**
- `{message}` is the raw prompt text passed as a **single argument** (no shell splitting)
- `test.py` is injected fresh before each pytest run and removed after
- All subprocess stdout+stderr merge into log files (not captured to memory for display)
- The cmd_template is tokenized with shell-style splitting, but `{model}` and `{message}` are substituted **after** splitting (so the message stays as one argument)

- [ ] **Step 1: Add `shell-words` dependency and Engine error variant**

In `Cargo.toml`, add:
```toml
shell-words = "1"
```

In `src/error.rs`, add a new variant:
```rust
#[error("engine error: {0}")]
Engine(String),
```

- [ ] **Step 2: Write failing tests**

Tests here need actual filesystem setup but not real agents. We test the helper functions: `build_argv`, `copy_project_files`, `tokenize_template`.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_template() {
        let tokens = tokenize_template(
            "claude -p --model {model} {message}",
        );
        assert_eq!(tokens, vec!["claude", "-p", "--model", "{model}", "{message}"]);
    }

    #[test]
    fn test_build_argv_substitutes_placeholders() {
        let argv = build_argv(
            "claude -p --model {model} {message}",
            "/usr/bin/claude",
            "sonnet-4",
            "Write hello world",
        );
        assert_eq!(argv[0], "/usr/bin/claude");
        assert_eq!(argv[3], "sonnet-4");
        assert_eq!(argv[4], "Write hello world");
    }

    #[test]
    fn test_build_argv_message_stays_single_arg() {
        let argv = build_argv(
            "agent --model {model} {message}",
            "/bin/agent",
            "gpt-4o",
            "Fix the bug.\nLine 2 with 'quotes'",
        );
        // Message with newlines and quotes should be ONE argument
        assert_eq!(argv.len(), 4);
        assert!(argv[3].contains('\n'));
    }

    #[test]
    fn test_parse_pytest_summary_passed_and_failed() {
        let output = "===== 5 passed, 3 failed in 1.23s =====";
        assert_eq!(parse_pytest_summary(output), (5, 8));
    }

    #[test]
    fn test_parse_pytest_summary_all_passed() {
        let output = "===== 8 passed in 0.5s =====";
        assert_eq!(parse_pytest_summary(output), (8, 8));
    }

    #[test]
    fn test_parse_pytest_summary_no_match() {
        assert_eq!(parse_pytest_summary("no pytest output here"), (0, 0));
    }

    #[test]
    fn test_copy_project_files_excludes_test_and_pycache() {
        let dir = tempfile::tempdir().unwrap();

        // Create source project
        let src = dir.path().join("project");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("main.py"), "print('hi')").unwrap();
        std::fs::write(src.join("test.py"), "def test(): pass").unwrap();
        std::fs::create_dir_all(src.join("__pycache__")).unwrap();
        std::fs::write(src.join("__pycache__/cache.pyc"), "bytes").unwrap();

        // Copy to dest
        let dest = dir.path().join("workdir");
        std::fs::create_dir_all(&dest).unwrap();
        copy_project_files(&src, &dest).unwrap();

        assert!(dest.join("main.py").exists());
        assert!(!dest.join("test.py").exists());
        assert!(!dest.join("__pycache__").exists());
    }

    #[test]
    fn test_git_init_creates_repo() {
        let dir = tempfile::tempdir().unwrap();
        let workdir = dir.path().join("workdir");
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(workdir.join("main.py"), "pass").unwrap();

        let result = git_init(&workdir);
        assert!(result.is_ok(), "git_init failed: {:?}", result);
        assert!(workdir.join(".git").exists());
    }
}
```

- [ ] **Step 3: Implement runner**

```rust
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::engine::steplog::{StepLog, StepStatus};
use crate::error::{LitmusError, Result};

/// Maximum retry count for failed tests.
const MAX_RETRIES: usize = 2;

/// Result of running a single scenario.
#[derive(Debug)]
pub struct ScenarioResult {
    pub scenario_id: String,
    pub passed: bool,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub duration_secs: f64,
}

/// Tokenize a command template into shell-like tokens.
/// Handles simple quoting but does NOT split {model} or {message} values.
pub fn tokenize_template(template: &str) -> Vec<String> {
    shell_words::split(template).unwrap_or_else(|_| {
        template.split_whitespace().map(String::from).collect()
    })
}

/// Build the full argv for an agent call.
/// First token is replaced with the resolved binary path.
/// {model} and {message} are substituted as whole arguments (no re-splitting).
pub fn build_argv(template: &str, binary_path: &str, model: &str, message: &str) -> Vec<String> {
    let tokens = tokenize_template(template);
    let mut argv = Vec::with_capacity(tokens.len());
    for (i, token) in tokens.into_iter().enumerate() {
        if i == 0 {
            argv.push(binary_path.to_string());
        } else {
            let substituted = token
                .replace("{model}", model)
                .replace("{message}", message);
            argv.push(substituted);
        }
    }
    argv
}

/// Copy project files, excluding test.py and __pycache__/.
pub fn copy_project_files(src: &Path, dest: &Path) -> Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str == "test.py" || name_str == "__pycache__" {
            continue;
        }

        let src_path = entry.path();
        let dest_path = dest.join(&name);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Initialize a git repo in the workdir (required by most agents).
pub fn git_init(workdir: &Path) -> Result<()> {
    run_cmd(workdir, "git", &["init"])?;
    run_cmd(workdir, "git", &["add", "."])?;
    run_cmd(
        workdir,
        "git",
        &[
            "-c", "user.name=litmus",
            "-c", "user.email=litmus@test",
            "commit", "-m", "init", "--allow-empty",
        ],
    )?;
    Ok(())
}

/// Run a single scenario end-to-end. Returns a ScenarioResult.
///
/// `template_dir` — path to `template/<scenario_id>/`
/// `work_dir` — path to `results/<session>/<run>/<scenario_id>/`
/// `agent_dir` — `work_dir/workdir/`
pub fn run_scenario(
    cmd_template: &str,
    binary_path: &str,
    model: &str,
    scenario_id: &str,
    prompt: &str,
    template_dir: &Path,
    work_dir: &Path,
) -> Result<ScenarioResult> {
    let start = std::time::Instant::now();
    let agent_dir = work_dir.join("workdir");
    let project_dir = template_dir.join("project");
    let mut steplog = StepLog::new(work_dir.to_path_buf());

    // 1. Copy project files
    if project_dir.exists() {
        copy_project_files(&project_dir, &agent_dir)?;
    }

    // 2. Git init
    git_init(&agent_dir)?;

    // 3. uv sync (if pyproject.toml exists)
    if agent_dir.join("pyproject.toml").exists() {
        let log_name = steplog.next_log_name("sync");
        let idx = steplog.begin("Project init (uv sync)", &log_name);
        let log_path = work_dir.join(&log_name);

        let ok = run_cmd_to_file(&agent_dir, "uv", &["sync"], &log_path);
        steplog.finish(idx, if ok { StepStatus::Done } else { StepStatus::Failed });

        if !ok {
            return Ok(ScenarioResult {
                scenario_id: scenario_id.to_string(),
                passed: false,
                tests_passed: 0,
                tests_total: 0,
                duration_secs: start.elapsed().as_secs_f64(),
            });
        }
    }

    // 4. Agent call
    let log_name = steplog.next_log_name("agent");
    let idx = steplog.begin(&format!("Agent call ({})", model), &log_name);
    let log_path = work_dir.join(&log_name);

    let argv = build_argv(cmd_template, binary_path, model, prompt);
    let ok = run_argv_to_file(&agent_dir, &argv, &log_path);
    steplog.finish(idx, if ok { StepStatus::Done } else { StepStatus::Failed });

    // 5. Test + retry loop
    let test_src = template_dir.join("project").join("test.py");
    let mut tests_passed = 0u32;
    let mut tests_total = 0u32;
    let mut passed = false;

    if test_src.exists() {
        for attempt in 0..=MAX_RETRIES {
            // Inject test.py
            let test_dest = agent_dir.join("test.py");
            let _ = fs::copy(&test_src, &test_dest);

            let tag = if attempt == 0 { "test".to_string() } else { format!("test_retry{}", attempt) };
            let log_name = steplog.next_log_name(&tag);
            let idx = steplog.begin("Run tests (pytest)", &log_name);
            let log_path = work_dir.join(&log_name);

            let test_ok = run_cmd_to_file(
                &agent_dir,
                "uv",
                &["run", "pytest", "test.py", "-v"],
                &log_path,
            );

            // Parse pytest output for pass/total counts
            let log_output = fs::read_to_string(&log_path).unwrap_or_default();
            let (p, t) = parse_pytest_summary(&log_output);
            tests_passed = p;
            tests_total = t;

            // Remove test.py after running
            let _ = fs::remove_file(&test_dest);

            if test_ok {
                steplog.finish(idx, StepStatus::Done);
                passed = true;
                break;
            }

            steplog.finish(idx, StepStatus::Failed);

            // Retry: send test output back to agent
            if attempt < MAX_RETRIES {
                let retry_prompt = format!(
                    "The tests failed. Here is the test output:\n\n```\n{}\n```\n\nPlease fix the code so that all tests pass.",
                    log_output
                );
                let log_name = steplog.next_log_name("agent_retry");
                let idx = steplog.begin(&format!("Agent retry #{}", attempt + 1), &log_name);
                let log_path = work_dir.join(&log_name);

                let argv = build_argv(cmd_template, binary_path, model, &retry_prompt);
                let ok = run_argv_to_file(&agent_dir, &argv, &log_path);
                steplog.finish(idx, if ok { StepStatus::Done } else { StepStatus::Failed });
            }
        }
    } else {
        // No tests — scenario passes if agent succeeded
        passed = ok;
    }

    Ok(ScenarioResult {
        scenario_id: scenario_id.to_string(),
        passed,
        tests_passed,
        tests_total,
        duration_secs: start.elapsed().as_secs_f64(),
    })
}

// ── Subprocess helpers ──────────────────────────────────────────

fn run_cmd(cwd: &Path, program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()?;

    if output.status.success() {
        Ok(())
    } else {
        Err(LitmusError::Engine(format!(
            "{} {} failed with {}",
            program,
            args.join(" "),
            output.status
        )))
    }
}

fn run_cmd_to_file(cwd: &Path, program: &str, args: &[&str], log_path: &Path) -> bool {
    let log_file = fs::File::create(log_path).ok();
    let (stdout, stderr) = match &log_file {
        Some(f) => (Stdio::from(f.try_clone().unwrap()), Stdio::from(f.try_clone().unwrap())),
        None => (Stdio::null(), Stdio::null()),
    };

    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(stdout)
        .stderr(stderr)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn run_argv_to_file(cwd: &Path, argv: &[String], log_path: &Path) -> bool {
    if argv.is_empty() {
        return false;
    }
    let log_file = fs::File::create(log_path).ok();
    let (stdout, stderr) = match &log_file {
        Some(f) => (Stdio::from(f.try_clone().unwrap()), Stdio::from(f.try_clone().unwrap())),
        None => (Stdio::null(), Stdio::null()),
    };

    Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .stdout(stdout)
        .stderr(stderr)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Parse pytest -v output for pass/total counts.
/// Looks for the summary line like "5 passed, 3 failed" or "8 passed".
fn parse_pytest_summary(output: &str) -> (u32, u32) {
    // Look for lines like "= 5 passed, 3 failed in 1.23s ="
    for line in output.lines().rev() {
        let line = line.trim();
        if !line.contains("passed") && !line.contains("failed") {
            continue;
        }
        let mut passed = 0u32;
        let mut failed = 0u32;

        for part in line.split(|c: char| c == ',' || c == '=') {
            let part = part.trim();
            if let Some(rest) = part.strip_suffix("passed") {
                passed = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = part.strip_suffix("failed") {
                failed = rest.trim().parse().unwrap_or(0);
            }
        }
        if passed > 0 || failed > 0 {
            return (passed, passed + failed);
        }
    }
    (0, 0)
}
```

**Note:** This task also requires adding `shell-words = "1"` to `Cargo.toml` for POSIX shell tokenization of command templates.

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test --lib engine::runner -- -v`

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/error.rs src/engine/runner.rs src/engine/mod.rs
git commit -m "feat(engine): single scenario runner with retry loop"
```

---

### Task 7: Batch Runner with Progress Channel

**Files:**
- Create: `src/engine/batch.rs`
- Modify: `src/engine/mod.rs` (add `pub mod batch;`)
- Test: inline `#[cfg(test)]` in `batch.rs`

Orchestrates parallel execution of multiple scenarios across agent×model lanes. Each lane (one unique agent+model pair) runs scenarios sequentially. Different lanes run in parallel on separate threads.

Progress updates are sent via `std::sync::mpsc::Sender<ProgressEvent>` for the UI to consume.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lanes_grouping() {
        let tasks = vec![
            BatchTask {
                agent_name: "A".into(),
                binary_path: "/bin/a".into(),
                cmd_template: "a {model} {message}".into(),
                model: "m1".into(),
                scenario_id: "s1".into(),
                prompt: "do it".into(),
                template_dir: "/t/s1".into(),
            },
            BatchTask {
                agent_name: "A".into(),
                binary_path: "/bin/a".into(),
                cmd_template: "a {model} {message}".into(),
                model: "m1".into(),
                scenario_id: "s2".into(),
                prompt: "do it".into(),
                template_dir: "/t/s2".into(),
            },
            BatchTask {
                agent_name: "B".into(),
                binary_path: "/bin/b".into(),
                cmd_template: "b {model} {message}".into(),
                model: "m2".into(),
                scenario_id: "s1".into(),
                prompt: "do it".into(),
                template_dir: "/t/s1".into(),
            },
        ];
        let lanes = group_into_lanes(&tasks);
        assert_eq!(lanes.len(), 2); // A_m1, B_m2
        assert_eq!(lanes[&("A".to_string(), "m1".to_string())].len(), 2);
        assert_eq!(lanes[&("B".to_string(), "m2".to_string())].len(), 1);
    }

    #[test]
    fn test_progress_event_variants() {
        let event = ProgressEvent::ScenarioStarted {
            agent: "A".into(),
            model: "m1".into(),
            scenario_id: "s1".into(),
        };
        match event {
            ProgressEvent::ScenarioStarted { agent, .. } => assert_eq!(agent, "A"),
            _ => panic!("wrong variant"),
        }
    }
}
```

- [ ] **Step 2: Implement batch runner**

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::thread;

use uuid::Uuid;

use crate::engine::runner::{self, ScenarioResult};
use crate::engine::session;

/// A single task in the batch (one agent × model × scenario).
#[derive(Debug, Clone)]
pub struct BatchTask {
    pub agent_name: String,
    pub binary_path: String,
    pub cmd_template: String,
    pub model: String,
    pub scenario_id: String,
    pub prompt: String,
    pub template_dir: PathBuf,
}

/// Progress events sent from worker threads to the UI.
#[derive(Debug, Clone)]
pub enum ProgressEvent {
    ScenarioStarted {
        agent: String,
        model: String,
        scenario_id: String,
    },
    ScenarioFinished {
        agent: String,
        model: String,
        scenario_id: String,
        result: ScenarioOutcome,
    },
    LaneFinished {
        agent: String,
        model: String,
    },
    AllDone {
        run_id: Uuid,
    },
}

/// Outcome summary for a finished scenario (carries enough data for DB writes).
#[derive(Debug, Clone)]
pub struct ScenarioOutcome {
    pub passed: bool,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub duration_secs: f64,
    pub work_dir: PathBuf,
    pub logs_dir: PathBuf,
}

/// Group tasks into lanes by (agent, model) pair.
pub fn group_into_lanes(tasks: &[BatchTask]) -> HashMap<(String, String), Vec<&BatchTask>> {
    let mut lanes: HashMap<(String, String), Vec<&BatchTask>> = HashMap::new();
    for task in tasks {
        lanes
            .entry((task.agent_name.clone(), task.model.clone()))
            .or_default()
            .push(task);
    }
    lanes
}

/// Execute a batch of tasks with parallel lanes.
/// Returns the run_id (UUID) used for this batch.
pub fn run_batch(
    tasks: Vec<BatchTask>,
    session_dir: &Path,
    progress_tx: Sender<ProgressEvent>,
) -> Uuid {
    let run_id = Uuid::new_v4();
    let lanes = group_into_lanes(&tasks);

    let mut handles = Vec::new();

    for ((agent, model), lane_tasks) in lanes {
        let session_dir = session_dir.to_path_buf();
        let tx = progress_tx.clone();
        let run_id = run_id;

        // Collect owned copies for the thread
        let lane_tasks: Vec<BatchTask> = lane_tasks.into_iter().cloned().collect();

        let handle = thread::spawn(move || {
            run_lane(&lane_tasks, &agent, &model, &session_dir, &tx);
        });
        handles.push(handle);
    }

    // Drop our copy so the channel closes when all threads finish
    let final_tx = progress_tx;

    // Wait for all lanes in a separate thread, then send AllDone
    thread::spawn(move || {
        for handle in handles {
            let _ = handle.join();
        }
        let _ = final_tx.send(ProgressEvent::AllDone { run_id });
    });

    run_id
}

/// Execute a single lane (sequential scenarios for one agent+model pair).
fn run_lane(
    tasks: &[BatchTask],
    agent: &str,
    model: &str,
    session_dir: &Path,
    tx: &Sender<ProgressEvent>,
) {
    let run_dir = match session::create_run_dir(session_dir, agent, model) {
        Ok(d) => d,
        Err(_) => return,
    };

    for task in tasks {
        let _ = tx.send(ProgressEvent::ScenarioStarted {
            agent: agent.to_string(),
            model: model.to_string(),
            scenario_id: task.scenario_id.clone(),
        });

        let work_dir = match session::create_scenario_dir(&run_dir, &task.scenario_id) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let result = runner::run_scenario(
            &task.cmd_template,
            &task.binary_path,
            &task.model,
            &task.scenario_id,
            &task.prompt,
            &task.template_dir,
            &work_dir,
        );

        let outcome = match result {
            Ok(r) => ScenarioOutcome {
                passed: r.passed,
                tests_passed: r.tests_passed,
                tests_total: r.tests_total,
                duration_secs: r.duration_secs,
            },
            Err(_) => ScenarioOutcome {
                passed: false,
                tests_passed: 0,
                tests_total: 0,
                duration_secs: 0.0,
            },
        };

        let _ = tx.send(ProgressEvent::ScenarioFinished {
            agent: agent.to_string(),
            model: model.to_string(),
            scenario_id: task.scenario_id.clone(),
            result: outcome,
        });
    }

    let _ = tx.send(ProgressEvent::LaneFinished {
        agent: agent.to_string(),
        model: model.to_string(),
    });
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cargo test --lib engine::batch -- -v`

- [ ] **Step 4: Commit**

```bash
git add src/engine/batch.rs src/engine/mod.rs
git commit -m "feat(engine): parallel batch runner with progress channel"
```

---

## Final engine/mod.rs

After all tasks, `src/engine/mod.rs` should contain:

```rust
pub mod batch;
pub mod encoding;
pub mod registry;
pub mod runner;
pub mod scanner;
pub mod session;
pub mod steplog;
```

## Dependencies to Add

```toml
# In Cargo.toml [dependencies]
which = "7"
shell-words = "1"
```

## Deferred to Later Phases

- **LLM Judge** (`engine/analysis.rs`) — Phase 5. Requires `reqwest` for OpenAI-compatible API calls. Will add `judge_scores` to `RunResult` after benchmark execution.
- **Windows .cmd wrapper bypass** — Phase 6 polish. Needed for Node.js agents (Claude Code, KiloCode) on Windows where `.cmd` wrappers mangle arguments.
- **Agent ↔ Config mapping** — Phase 4. `DetectedAgent` (runtime) maps to/from `AgentConfig` (config.yaml) in the Settings screen.

## Integration Notes for Phase 4 (Run Screen)

The batch runner's `ProgressEvent` channel is the interface between engine and UI:
1. UI builds `Vec<BatchTask>` from the Matrix Builder selections
2. UI calls `run_batch(tasks, session_dir, tx)` — returns immediately with `run_id`
3. UI polls `rx.try_recv()` in the event loop (every 100ms tick) to update the Progress view
4. On `ProgressEvent::AllDone`, UI stores results to DB and switches to results view

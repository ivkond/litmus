use crate::engine::encoding;
use crate::error::Result;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Session {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RunConfig {
    pub agents: Vec<RunAgentConfig>,
    pub scenarios: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RunAgentConfig {
    pub name: String,
    pub cmd_template: String,
    pub models: Vec<String>,
}

/// Returns a session name based on the current local time.
pub fn new_session_name() -> String {
    Local::now().format("%Y%m%d_%H%M%S").to_string()
}

/// Creates `results_dir/<session_name>/` and returns a `Session`.
pub fn create_session(results_dir: &Path) -> Result<Session> {
    let name = new_session_name();
    let path = results_dir.join(&name);
    fs::create_dir_all(&path)?;
    Ok(Session { name, path })
}

/// Creates `session_dir/{agent}_{encoded_model}/` using `encoding::run_dir_name`.
pub fn create_run_dir(session_dir: &Path, agent: &str, model: &str) -> Result<PathBuf> {
    let dir_name = encoding::run_dir_name(agent, model);
    let run_dir = session_dir.join(dir_name);
    fs::create_dir_all(&run_dir)?;
    Ok(run_dir)
}

/// Creates `run_dir/<scenario_id>/` and inner `workdir/`, returns the scenario dir path.
pub fn create_scenario_dir(run_dir: &Path, scenario_id: &str) -> Result<PathBuf> {
    let scenario_dir = run_dir.join(scenario_id);
    let work_dir = scenario_dir.join("workdir");
    fs::create_dir_all(&work_dir)?;
    Ok(scenario_dir)
}

/// Writes `run_config.yaml` inside `session_dir`.
pub fn save_run_config(session_dir: &Path, config: &RunConfig) -> Result<()> {
    let config_path = session_dir.join("run_config.yaml");
    let yaml = serde_yml::to_string(config)?;
    fs::write(config_path, yaml)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_name_format() {
        let name = new_session_name();
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
        let name = run_dir.file_name().unwrap().to_string_lossy();
        assert!(name.contains("KiloCode_kilo~fmodel~cfree"));
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
        save_run_config(dir.path(), &config).unwrap();
        assert!(dir.path().join("run_config.yaml").exists());
    }
}

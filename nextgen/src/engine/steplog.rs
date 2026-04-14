use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Done,
    Failed,
    Cancelled,
}

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
    pub start_instant: Option<Instant>,
}

pub struct StepLog {
    dir: PathBuf,
    pub steps: Vec<StepEntry>,
    counter: usize,
}

impl StepLog {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            steps: Vec::new(),
            counter: 0,
        }
    }

    pub fn next_log_name(&self, tag: &str) -> String {
        format!("{:02}_{}.log", self.counter + 1, tag)
    }

    pub fn begin(&mut self, name: &str, log_file: &str) -> usize {
        self.counter += 1;
        let entry = StepEntry {
            name: name.to_string(),
            log_file: log_file.to_string(),
            status: StepStatus::Running,
            start_time: Local::now().to_rfc3339(),
            end_time: None,
            elapsed_secs: 0.0,
            start_instant: Some(Instant::now()),
        };
        self.steps.push(entry);
        let idx = self.steps.len() - 1;
        self.flush();
        idx
    }

    pub fn finish(&mut self, idx: usize, status: StepStatus) {
        let entry = &mut self.steps[idx];
        let elapsed = entry
            .start_instant
            .map(|inst| inst.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        entry.status = status;
        entry.end_time = Some(Local::now().to_rfc3339());
        entry.elapsed_secs = elapsed;
        self.flush();
    }

    pub fn flush(&self) {
        let path = self.dir.join("steps.json");
        let json = serde_json::to_string_pretty(&self.steps).unwrap_or_default();
        let _ = std::fs::write(path, json);
    }
}

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

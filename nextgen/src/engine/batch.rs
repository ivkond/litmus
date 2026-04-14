use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::thread;
use uuid::Uuid;
use crate::engine::runner;
use crate::engine::session;

/// A single task in the batch.
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

/// Progress events sent from worker threads to UI.
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

/// Outcome of a finished scenario (carries enough data for DB writes).
#[derive(Debug, Clone)]
pub struct ScenarioOutcome {
    pub passed: bool,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub duration_secs: f64,
    pub work_dir: PathBuf,
}

/// Groups tasks by (agent_name, model) key.
pub fn group_into_lanes<'a>(
    tasks: &'a [BatchTask],
) -> HashMap<(String, String), Vec<&'a BatchTask>> {
    let mut lanes: HashMap<(String, String), Vec<&'a BatchTask>> = HashMap::new();
    for task in tasks {
        lanes
            .entry((task.agent_name.clone(), task.model.clone()))
            .or_default()
            .push(task);
    }
    lanes
}

/// Runs all tasks in a single lane (agent+model pair) sequentially.
fn run_lane(
    tasks: Vec<BatchTask>,
    agent: String,
    model: String,
    session_dir: PathBuf,
    tx: Sender<ProgressEvent>,
) {
    let run_dir = match session::create_run_dir(&session_dir, &agent, &model) {
        Ok(d) => d,
        Err(_) => return,
    };

    for task in &tasks {
        let _ = tx.send(ProgressEvent::ScenarioStarted {
            agent: agent.clone(),
            model: model.clone(),
            scenario_id: task.scenario_id.clone(),
        });

        let scenario_dir = match session::create_scenario_dir(&run_dir, &task.scenario_id) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let work_dir = scenario_dir.join("workdir");

        let outcome = match runner::run_scenario(
            &task.cmd_template,
            &task.binary_path,
            &task.model,
            &task.scenario_id,
            &task.prompt,
            &task.template_dir,
            &scenario_dir,
        ) {
            Ok(result) => ScenarioOutcome {
                passed: result.passed,
                tests_passed: result.tests_passed,
                tests_total: result.tests_total,
                duration_secs: result.duration_secs,
                work_dir,
            },
            Err(_) => ScenarioOutcome {
                passed: false,
                tests_passed: 0,
                tests_total: 0,
                duration_secs: 0.0,
                work_dir,
            },
        };

        let _ = tx.send(ProgressEvent::ScenarioFinished {
            agent: agent.clone(),
            model: model.clone(),
            scenario_id: task.scenario_id.clone(),
            result: outcome,
        });
    }

    let _ = tx.send(ProgressEvent::LaneFinished {
        agent,
        model,
    });
}

/// Orchestrates parallel execution of all tasks. Returns the run_id immediately (non-blocking).
///
/// Each (agent, model) pair is a "lane" running sequentially on its own thread.
/// Different lanes run in parallel. Progress updates are sent via `progress_tx`.
/// The channel closes when all lanes finish (after `AllDone` is sent).
pub fn run_batch(
    tasks: Vec<BatchTask>,
    session_dir: &Path,
    progress_tx: Sender<ProgressEvent>,
) -> Uuid {
    let run_id = Uuid::new_v4();
    let lanes = group_into_lanes(&tasks);
    let session_dir = session_dir.to_path_buf();

    let mut lane_handles = Vec::new();

    // Clone a sender for the joiner thread before consuming progress_tx in the loop
    let joiner_tx = progress_tx.clone();

    for ((agent, model), lane_tasks) in lanes {
        let owned_tasks: Vec<BatchTask> = lane_tasks.into_iter().cloned().collect();
        let tx = progress_tx.clone();
        let dir = session_dir.clone();

        let handle = thread::spawn(move || {
            run_lane(owned_tasks, agent, model, dir, tx);
        });
        lane_handles.push(handle);
    }

    // Drop the original sender so it doesn't keep the channel alive
    drop(progress_tx);

    // Joiner thread: waits for all lane threads, then sends AllDone
    thread::spawn(move || {
        for handle in lane_handles {
            let _ = handle.join();
        }
        let _ = joiner_tx.send(ProgressEvent::AllDone { run_id });
    });

    run_id
}

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
        assert_eq!(lanes.len(), 2);
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

    #[test]
    fn test_scenario_outcome_fields() {
        let outcome = ScenarioOutcome {
            passed: true,
            tests_passed: 5,
            tests_total: 5,
            duration_secs: 12.3,
            work_dir: PathBuf::from("/tmp/work"),
        };
        assert!(outcome.passed);
        assert_eq!(outcome.tests_passed, 5);
    }
}

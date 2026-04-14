use std::path::{Path, PathBuf};

use crate::error::{LitmusError, Result};
use crate::model::{Scenario, ScoringCriterion};

// ── Read ──

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
            continue;
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

// ── Create ──

/// Create a new empty scenario with a default prompt.
pub fn create_scenario(template_dir: &Path, id: &str) -> Result<PathBuf> {
    let dir = template_dir.join(id);
    if dir.exists() {
        return Err(LitmusError::Scenario(format!(
            "scenario '{}' already exists",
            id
        )));
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("prompt.txt"), "# Write the prompt here\n")?;
    Ok(dir)
}

// ── Delete ──

/// Remove a scenario directory entirely.
pub fn delete_scenario(template_dir: &Path, id: &str) -> Result<()> {
    let dir = template_dir.join(id);
    if !dir.exists() {
        return Err(LitmusError::Scenario(format!(
            "scenario '{}' not found",
            id
        )));
    }
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

// ── Duplicate ──

/// Duplicate a scenario under a new ID by copying the entire directory.
pub fn duplicate_scenario(template_dir: &Path, source_id: &str, new_id: &str) -> Result<PathBuf> {
    let src = template_dir.join(source_id);
    let dst = template_dir.join(new_id);
    if !src.exists() {
        return Err(LitmusError::Scenario(format!(
            "scenario '{}' not found",
            source_id
        )));
    }
    if dst.exists() {
        return Err(LitmusError::Scenario(format!(
            "scenario '{}' already exists",
            new_id
        )));
    }
    copy_dir_recursive(&src, &dst)?;
    Ok(dst)
}

// ── Internal helpers ──

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

/// Recursively copy a directory, skipping caches.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip(&name) {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Files/dirs to skip during copy and pack operations.
pub fn should_skip(name: &str) -> bool {
    name == "__pycache__"
        || name == ".pytest_cache"
        || name == ".venv"
        || name == "node_modules"
        || name.ends_with(".pyc")
        || name.ends_with(".pyo")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_template() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let s1 = tmp.path().join("1-basic");
        std::fs::create_dir_all(s1.join("project")).unwrap();
        std::fs::write(s1.join("prompt.txt"), "Do the thing").unwrap();
        std::fs::write(s1.join("task.txt"), "Task description").unwrap();
        std::fs::write(
            s1.join("scoring.csv"),
            "criterion,score\nCorrectness,5\nStyle,2\n",
        )
        .unwrap();
        std::fs::write(s1.join("project").join("main.py"), "# code").unwrap();
        std::fs::write(s1.join("project").join("test.py"), "# tests").unwrap();
        tmp
    }

    #[test]
    fn test_load_scenarios() {
        let tmp = setup_template();
        let scenarios = load_scenarios(tmp.path()).unwrap();
        assert_eq!(scenarios.len(), 1);
        assert_eq!(scenarios[0].id, "1-basic");
        assert_eq!(scenarios[0].prompt, "Do the thing");
        assert_eq!(scenarios[0].scoring.len(), 2);
        assert_eq!(scenarios[0].max_score, 7);
        assert!(scenarios[0].has_project);
    }

    #[test]
    fn test_create_delete() {
        let tmp = TempDir::new().unwrap();
        create_scenario(tmp.path(), "test-scenario").unwrap();
        let scenarios = load_scenarios(tmp.path()).unwrap();
        assert_eq!(scenarios.len(), 1);
        assert_eq!(scenarios[0].id, "test-scenario");

        delete_scenario(tmp.path(), "test-scenario").unwrap();
        let scenarios = load_scenarios(tmp.path()).unwrap();
        assert_eq!(scenarios.len(), 0);
    }

    #[test]
    fn test_duplicate() {
        let tmp = setup_template();
        duplicate_scenario(tmp.path(), "1-basic", "1-basic-copy").unwrap();

        let scenarios = load_scenarios(tmp.path()).unwrap();
        assert_eq!(scenarios.len(), 2);
        assert_eq!(scenarios[1].prompt, "Do the thing");
        assert!(scenarios[1].has_project);
    }

    #[test]
    fn test_create_duplicate_id_fails() {
        let tmp = setup_template();
        assert!(create_scenario(tmp.path(), "1-basic").is_err());
    }
}

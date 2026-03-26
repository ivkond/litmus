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

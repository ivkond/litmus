use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::engine::registry::{self, AgentSpec, AGENTS};
use crate::error::Result;

/// How long the cache stays valid before a background refresh is warranted.
const CACHE_MAX_AGE_SECS: u64 = 24 * 60 * 60; // 24 hours

#[derive(Debug, Serialize, Deserialize)]
pub struct DetectedAgent {
    pub name: String,
    pub path: String,
    pub version: String,
    pub models: Vec<String>,
    pub cmd_template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub detected: Vec<DetectedAgent>,
    pub not_found: Vec<String>,
}

/// Return the platform-appropriate cache file path:
///   Linux/macOS: ~/.config/litmus/agents_cache.yaml
///   Windows:     %APPDATA%\litmus\agents_cache.yaml
pub fn cache_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("litmus").join("agents_cache.yaml"))
}

/// Try to load from cache. If the cache is missing or older than 24h, return None.
pub fn load_cached() -> Option<ScanResult> {
    let path = cache_path()?;
    if !path.exists() {
        return None;
    }
    // Check age
    if let Ok(meta) = std::fs::metadata(&path) {
        if let Ok(modified) = meta.modified() {
            let age = SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default();
            if age.as_secs() > CACHE_MAX_AGE_SECS {
                return None;
            }
        }
    }
    load_cache(&path).ok()
}

/// Full scan: detect binaries, fetch models, write result to cache.
pub fn scan_agents_fresh() -> ScanResult {
    let result = scan_agents();
    // Best-effort cache write
    if let Some(path) = cache_path() {
        let _ = save_cache(&path, &result);
    }
    result
}

/// Core scan logic (no caching).
pub fn scan_agents() -> ScanResult {
    let mut detected = Vec::new();
    let mut not_found = Vec::new();

    for spec in AGENTS {
        match detect_binary(spec) {
            Some(binary_path) => {
                let (models, error) = fetch_models(spec, &binary_path);
                detected.push(DetectedAgent {
                    name: spec.name.to_string(),
                    path: binary_path.to_string_lossy().to_string(),
                    version: String::new(),
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

pub fn detect_binary(spec: &AgentSpec) -> Option<PathBuf> {
    for binary in spec.binaries {
        if let Ok(path) = which::which(binary) {
            return Some(path);
        }
    }
    None
}

pub fn fetch_models(spec: &AgentSpec, binary_path: &Path) -> (Vec<String>, Option<String>) {
    let model_cmd = match spec.model_cmd {
        None => {
            return (
                spec.known_models.iter().map(|s| s.to_string()).collect(),
                None,
            );
        }
        Some(cmd) => cmd,
    };

    if model_cmd.is_empty() {
        return (
            spec.known_models.iter().map(|s| s.to_string()).collect(),
            None,
        );
    }

    // First element is the binary, rest are arguments
    let (_, args) = model_cmd.split_first().unwrap();

    let output = Command::new(binary_path)
        .args(args)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let models = registry::parse_models(spec.parser, &stdout);
            if models.is_empty() && !out.stderr.is_empty() {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                (vec![], Some(stderr))
            } else {
                (models, None)
            }
        }
        Err(e) => (vec![], Some(e.to_string())),
    }
}

pub fn save_cache(path: &Path, result: &ScanResult) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let yaml = serde_yml::to_string(result)?;
    std::fs::write(path, yaml)?;
    Ok(())
}

pub fn load_cache(path: &Path) -> Result<ScanResult> {
    let content = std::fs::read_to_string(path)?;
    let result = serde_yml::from_str(&content)?;
    Ok(result)
}

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
            version: String::new(),
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
                version: "1.0".into(),
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
                version: "2.0".into(),
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
        assert_eq!(loaded.detected[0].version, "2.0");
        assert_eq!(loaded.not_found, vec!["MissingAgent"]);
    }

    #[test]
    fn test_cache_path_returns_some() {
        // On any platform with a home dir, cache_path should return Some
        let path = cache_path();
        assert!(path.is_some());
        let p = path.unwrap();
        assert!(p.ends_with("agents_cache.yaml"));
        assert!(p.to_string_lossy().contains("litmus"));
    }
}

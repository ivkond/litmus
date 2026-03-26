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

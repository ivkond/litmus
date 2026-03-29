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

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("engine error: {0}")]
    Engine(String),
}

pub type Result<T> = std::result::Result<T, LitmusError>;

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
    migrations()
        .to_latest(&mut conn)
        .map_err(|e| crate::error::LitmusError::Config(format!("migration error: {e}")))?;
    Ok(conn)
}

/// Open an in-memory database (for tests).
pub fn open_memory_db() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    migrations()
        .to_latest(&mut conn)
        .map_err(|e| crate::error::LitmusError::Config(format!("migration error: {e}")))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_memory_db_creates_tables() {
        let conn = open_memory_db().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_results", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_migrations_are_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations()
            .to_latest(&mut conn)
            .unwrap();
        migrations()
            .to_latest(&mut conn)
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_results", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

use std::path::Path;

fn main() {
    println!("litmus-nextgen: Phase 1 smoke test\n");

    // 1. Load config
    let config_path = Path::new("../config.yaml");
    match litmus_nextgen::config::load_config(config_path) {
        Ok(cfg) => {
            println!("Config: {} agent(s)", cfg.agents.len());
            for a in &cfg.agents {
                println!("  - {} ({} models)", a.name, a.models.len());
            }
            if let Some(ref analysis) = cfg.analysis {
                println!("  Judge: {}", analysis.model);
            }
        }
        Err(e) => println!("Config error (expected if no config.yaml): {e}"),
    }

    // 2. Load scenarios
    let template_path = Path::new("../template");
    match litmus_nextgen::scenario::load_scenarios(template_path) {
        Ok(scenarios) => {
            println!("\nScenarios: {} found", scenarios.len());
            for s in &scenarios {
                println!(
                    "  - {} (max_score={}, has_project={})",
                    s.id, s.max_score, s.has_project
                );
            }
        }
        Err(e) => println!("Scenario error (expected if no template/): {e}"),
    }

    // 3. Open DB
    let db_path = Path::new("litmus.db");
    match litmus_nextgen::db::open_db(db_path) {
        Ok(conn) => {
            let stats = litmus_nextgen::db::queries::summary_stats(&conn).unwrap();
            println!(
                "\nDatabase: {} results, {} agents, {} models, {} scenarios",
                stats.total_results,
                stats.unique_agents,
                stats.unique_models,
                stats.unique_scenarios
            );
        }
        Err(e) => println!("DB error: {e}"),
    }

    // Clean up test db
    let _ = std::fs::remove_file(db_path);

    println!("\nPhase 1 foundation: OK");
}

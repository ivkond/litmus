//! `.litmus-pack` format — ZIP archive with manifest.json and scenario directories.
//!
//! Pack structure:
//! ```text
//! scenarios.litmus-pack
//! ├── manifest.json
//! ├── 1-data-structure/
//! │   ├── prompt.txt
//! │   ├── task.txt
//! │   ├── scoring.csv
//! │   └── project/
//! │       ├── main.py
//! │       └── test.py
//! └── 2-simple-architecture/
//!     └── ...
//! ```

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use crate::error::{LitmusError, Result};
use crate::model::{PackManifest, PackManifestEntry};
use crate::scenario;

/// Export selected scenarios to a `.litmus-pack` ZIP file.
pub fn export_pack(template_dir: &Path, ids: &[String], out_path: &Path) -> Result<usize> {
    let file = std::fs::File::create(out_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut manifest_entries = Vec::new();

    for id in ids {
        let scenario_dir = template_dir.join(id);
        if !scenario_dir.exists() {
            return Err(LitmusError::Scenario(format!(
                "scenario '{}' not found",
                id
            )));
        }

        let mut files = Vec::new();
        collect_files_for_pack(&scenario_dir, &scenario_dir, id, &mut zip, &options, &mut files)?;

        manifest_entries.push(PackManifestEntry {
            stem: id.clone(),
            files,
        });
    }

    // Write manifest.json
    let manifest = PackManifest {
        format_version: 1,
        kind: "scenarios".into(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        scenarios: manifest_entries,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    zip.start_file("manifest.json", options)?;
    zip.write_all(manifest_json.as_bytes())?;

    zip.finish()?;
    Ok(ids.len())
}

/// Export all scenarios in template_dir to a `.litmus-pack` file.
pub fn export_all(template_dir: &Path, out_path: &Path) -> Result<usize> {
    let scenarios = scenario::load_scenarios(template_dir)?;
    let ids: Vec<String> = scenarios.iter().map(|s| s.id.clone()).collect();
    export_pack(template_dir, &ids, out_path)
}

/// Import scenarios from a `.litmus-pack` file into template_dir.
/// Returns the list of imported scenario IDs.
pub fn import_pack(template_dir: &Path, pack_path: &Path) -> Result<Vec<String>> {
    let file = std::fs::File::open(pack_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| LitmusError::Scenario(format!("invalid .litmus-pack: {}", e)))?;

    // Read and validate manifest
    let manifest: PackManifest = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| LitmusError::Scenario("missing manifest.json in pack".into()))?;
        let mut buf = String::new();
        manifest_file.read_to_string(&mut buf)?;
        serde_json::from_str(&buf)?
    };

    if manifest.kind != "scenarios" {
        return Err(LitmusError::Scenario(format!(
            "unexpected pack kind: '{}'",
            manifest.kind
        )));
    }

    let mut imported = Vec::new();

    for entry in &manifest.scenarios {
        let dest = template_dir.join(&entry.stem);
        if dest.exists() {
            // Skip existing — don't overwrite without explicit intent
            continue;
        }
        std::fs::create_dir_all(&dest)?;

        // Extract all files for this scenario
        for file_rel in &entry.files {
            let zip_path = format!("{}/{}", entry.stem, file_rel);
            let mut zf = archive.by_name(&zip_path).map_err(|_| {
                LitmusError::Scenario(format!(
                    "file '{}' declared in manifest but missing in pack",
                    zip_path
                ))
            })?;

            let out_file = dest.join(file_rel);
            if let Some(parent) = out_file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&out_file)?;
            std::io::copy(&mut zf, &mut out)?;
        }

        imported.push(entry.stem.clone());
    }

    Ok(imported)
}

/// Default output path for a pack export.
pub fn default_pack_path(template_dir: &Path) -> PathBuf {
    template_dir.join("scenarios.litmus-pack")
}

// ── Internal helpers ──

fn collect_files_for_pack(
    dir: &Path,
    scenario_root: &Path,
    prefix: &str,
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: &zip::write::SimpleFileOptions,
    manifest_files: &mut Vec<String>,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if scenario::should_skip(&name) {
            continue;
        }

        let path = entry.path();

        if path.is_dir() {
            collect_files_for_pack(&path, scenario_root, prefix, zip, options, manifest_files)?;
        } else {
            // Relative to scenario root (e.g. "project/main.py")
            let manifest_rel = path
                .strip_prefix(scenario_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            let zip_path = format!("{}/{}", prefix, manifest_rel);
            zip.start_file(&zip_path, *options)?;
            let content = std::fs::read(&path)?;
            zip.write_all(&content)?;
            manifest_files.push(manifest_rel);
        }
    }
    Ok(())
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
    fn test_export_import_roundtrip() {
        let tmp = setup_template();
        let pack_path = tmp.path().join("test.litmus-pack");

        // Export
        let count = export_pack(
            tmp.path(),
            &["1-basic".to_string()],
            &pack_path,
        )
        .unwrap();
        assert_eq!(count, 1);
        assert!(pack_path.exists());

        // Import into a fresh directory
        let tmp2 = TempDir::new().unwrap();
        let imported = import_pack(tmp2.path(), &pack_path).unwrap();
        assert_eq!(imported, vec!["1-basic"]);

        // Verify contents
        let scenarios = scenario::load_scenarios(tmp2.path()).unwrap();
        assert_eq!(scenarios.len(), 1);
        assert_eq!(scenarios[0].id, "1-basic");
        assert_eq!(scenarios[0].prompt, "Do the thing");
        assert_eq!(scenarios[0].task, "Task description");
        assert_eq!(scenarios[0].scoring.len(), 2);
        assert!(scenarios[0].has_project);
    }

    #[test]
    fn test_export_all() {
        let tmp = setup_template();
        // Add a second scenario
        scenario::create_scenario(tmp.path(), "2-advanced").unwrap();

        let pack_path = tmp.path().join("all.litmus-pack");
        let count = export_all(tmp.path(), &pack_path).unwrap();
        assert_eq!(count, 2);

        // Verify manifest
        let file = std::fs::File::open(&pack_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut manifest_file = archive.by_name("manifest.json").unwrap();
        let mut buf = String::new();
        manifest_file.read_to_string(&mut buf).unwrap();
        let manifest: PackManifest = serde_json::from_str(&buf).unwrap();
        assert_eq!(manifest.scenarios.len(), 2);
        assert_eq!(manifest.kind, "scenarios");
    }

    #[test]
    fn test_import_skips_existing() {
        let tmp = setup_template();
        let pack_path = tmp.path().join("test.litmus-pack");
        export_pack(tmp.path(), &["1-basic".to_string()], &pack_path).unwrap();

        // Import into same dir — should skip since 1-basic already exists
        let imported = import_pack(tmp.path(), &pack_path).unwrap();
        assert!(imported.is_empty());
    }
}

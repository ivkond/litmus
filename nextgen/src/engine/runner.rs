use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::engine::steplog::{StepLog, StepStatus};
use crate::error::{LitmusError, Result};

pub const MAX_RETRIES: usize = 2;

#[derive(Debug)]
pub struct ScenarioResult {
    pub scenario_id: String,
    pub passed: bool,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub duration_secs: f64,
}

pub fn tokenize_template(template: &str) -> Vec<String> {
    match shell_words::split(template) {
        Ok(tokens) => tokens,
        Err(_) => template
            .split_whitespace()
            .map(|s| s.to_string())
            .collect(),
    }
}

pub fn build_argv(
    template: &str,
    binary_path: &str,
    model: &str,
    message: &str,
) -> Vec<String> {
    let mut tokens = tokenize_template(template);
    if tokens.is_empty() {
        return vec![binary_path.to_string()];
    }
    // Replace first token with the actual binary path
    tokens[0] = binary_path.to_string();
    // Substitute placeholders in remaining tokens, but never re-split message
    for token in tokens.iter_mut().skip(1) {
        if *token == "{model}" {
            *token = model.to_string();
        } else if *token == "{message}" {
            *token = message.to_string();
        } else {
            *token = token.replace("{model}", model).replace("{message}", message);
        }
    }
    tokens
}

pub fn copy_project_files(src: &Path, dest: &Path) -> Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        // Skip test.py and __pycache__
        if name == "test.py" || name == "__pycache__" {
            continue;
        }
        let src_path = entry.path();
        let dest_path = dest.join(&file_name);
        if src_path.is_dir() {
            fs::create_dir_all(&dest_path)?;
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

pub fn git_init(workdir: &Path) -> Result<()> {
    run_cmd(workdir, "git", &["init"])?;
    run_cmd(workdir, "git", &["add", "."])?;
    run_cmd(
        workdir,
        "git",
        &[
            "-c",
            "user.name=litmus",
            "-c",
            "user.email=litmus@test",
            "commit",
            "-m",
            "init",
            "--allow-empty",
        ],
    )?;
    Ok(())
}

pub fn run_scenario(
    cmd_template: &str,
    binary_path: &str,
    model: &str,
    scenario_id: &str,
    prompt: &str,
    template_dir: &Path,
    work_dir: &Path,
) -> Result<ScenarioResult> {
    let start = std::time::Instant::now();
    let agent_dir = work_dir.join("workdir");
    fs::create_dir_all(&agent_dir)?;

    let mut steplog = StepLog::new(work_dir.to_path_buf());

    // Copy project files from template_dir/project/ to agent_dir (if project/ exists)
    let project_src = template_dir.join("project");
    if project_src.exists() {
        copy_project_files(&project_src, &agent_dir)?;
    }

    // git init
    git_init(&agent_dir)?;

    // If pyproject.toml exists, run uv sync
    if agent_dir.join("pyproject.toml").exists() {
        let log_name = steplog.next_log_name("uv_sync");
        let log_path = work_dir.join(&log_name);
        let idx = steplog.begin("uv sync", &log_name);
        let ok = run_cmd_to_file(&agent_dir, "uv", &["sync"], &log_path);
        steplog.finish(idx, if ok { StepStatus::Done } else { StepStatus::Failed });
    }

    // Agent call
    let argv = build_argv(cmd_template, binary_path, model, prompt);
    let log_name = steplog.next_log_name("agent");
    let log_path = work_dir.join(&log_name);
    let idx = steplog.begin("agent", &log_name);
    let ok = run_argv_to_file(&agent_dir, &argv, &log_path);
    steplog.finish(idx, if ok { StepStatus::Done } else { StepStatus::Failed });

    // Run tests if test.py exists in template
    let test_src = template_dir.join("project").join("test.py");
    let has_tests = test_src.exists();

    let (tests_passed, tests_total, passed) = if has_tests {
        let (p, t, success) = run_tests_with_retry(
            &test_src,
            &agent_dir,
            work_dir,
            &mut steplog,
            cmd_template,
            binary_path,
            model,
            MAX_RETRIES,
        )?;
        (p, t, success)
    } else {
        (0, 0, true)
    };

    let duration_secs = start.elapsed().as_secs_f64();

    Ok(ScenarioResult {
        scenario_id: scenario_id.to_string(),
        passed,
        tests_passed,
        tests_total,
        duration_secs,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_tests_with_retry(
    test_src: &Path,
    agent_dir: &Path,
    work_dir: &Path,
    steplog: &mut StepLog,
    cmd_template: &str,
    binary_path: &str,
    model: &str,
    retries_remaining: usize,
) -> Result<(u32, u32, bool)> {
    // Copy test.py into agent_dir
    let test_dest = agent_dir.join("test.py");
    fs::copy(test_src, &test_dest)?;

    // Run pytest
    let log_name = steplog.next_log_name("pytest");
    let log_path = work_dir.join(&log_name);
    let idx = steplog.begin("pytest", &log_name);
    let ok = run_cmd_to_file(agent_dir, "uv", &["run", "pytest", "test.py", "-v"], &log_path);
    steplog.finish(idx, if ok { StepStatus::Done } else { StepStatus::Failed });

    // Parse results
    let output = fs::read_to_string(&log_path).unwrap_or_default();
    let (tests_passed, tests_total) = parse_pytest_summary(&output);

    // Clean up test.py
    let _ = fs::remove_file(&test_dest);

    let all_passed = ok && tests_passed == tests_total && tests_total > 0;

    if !all_passed && retries_remaining > 0 {
        // Build retry prompt with test output
        let retry_prompt = format!(
            "The tests failed. Here is the pytest output:\n\n{}\n\nPlease fix the issues.",
            output
        );
        let argv = build_argv(cmd_template, binary_path, model, &retry_prompt);
        let retry_log_name = steplog.next_log_name("agent_retry");
        let retry_log_path = work_dir.join(&retry_log_name);
        let ridx = steplog.begin("agent retry", &retry_log_name);
        let rok = run_argv_to_file(agent_dir, &argv, &retry_log_path);
        steplog.finish(ridx, if rok { StepStatus::Done } else { StepStatus::Failed });

        return run_tests_with_retry(
            test_src,
            agent_dir,
            work_dir,
            steplog,
            cmd_template,
            binary_path,
            model,
            retries_remaining - 1,
        );
    }

    Ok((tests_passed, tests_total, all_passed))
}

pub fn parse_pytest_summary(output: &str) -> (u32, u32) {
    // Look for lines like "5 passed, 3 failed" or "8 passed"
    for line in output.lines() {
        let mut passed: u32 = 0;
        let mut failed: u32 = 0;
        let mut found_passed = false;
        let mut found_failed = false;

        // Parse "X passed"
        if let Some(pos) = line.find(" passed") {
            let before = &line[..pos];
            if let Some(num_str) = before.split_whitespace().last() {
                if let Ok(n) = num_str.parse::<u32>() {
                    passed = n;
                    found_passed = true;
                }
            }
        }

        // Parse "X failed"
        if let Some(pos) = line.find(" failed") {
            let before = &line[..pos];
            if let Some(num_str) = before.split_whitespace().last() {
                if let Ok(n) = num_str.parse::<u32>() {
                    failed = n;
                    found_failed = true;
                }
            }
        }

        if found_passed || found_failed {
            return (passed, passed + failed);
        }
    }
    (0, 0)
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let src_path = entry.path();
        let dest_path = dest.join(&file_name);
        if src_path.is_dir() {
            fs::create_dir_all(&dest_path)?;
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

fn run_cmd(cwd: &Path, program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| LitmusError::Engine(format!("failed to run {}: {}", program, e)))?;
    if !status.success() {
        return Err(LitmusError::Engine(format!(
            "{} exited with status {}",
            program, status
        )));
    }
    Ok(())
}

fn run_cmd_to_file(cwd: &Path, program: &str, args: &[&str], log_path: &Path) -> bool {
    let file = match fs::File::create(log_path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let stderr_file = match file.try_clone() {
        Ok(f) => f,
        Err(_) => return false,
    };
    let result = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(stderr_file))
        .status();
    match result {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

fn run_argv_to_file(cwd: &Path, argv: &[String], log_path: &Path) -> bool {
    if argv.is_empty() {
        return false;
    }
    let file = match fs::File::create(log_path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let stderr_file = match file.try_clone() {
        Ok(f) => f,
        Err(_) => return false,
    };
    let result = Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(stderr_file))
        .status();
    match result {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_template() {
        let tokens = tokenize_template("claude -p --model {model} {message}");
        assert_eq!(tokens, vec!["claude", "-p", "--model", "{model}", "{message}"]);
    }

    #[test]
    fn test_build_argv_substitutes_placeholders() {
        let argv = build_argv(
            "claude -p --model {model} {message}",
            "/usr/bin/claude",
            "sonnet-4",
            "Write hello world",
        );
        assert_eq!(argv[0], "/usr/bin/claude");
        assert_eq!(argv[3], "sonnet-4");
        assert_eq!(argv[4], "Write hello world");
    }

    #[test]
    fn test_build_argv_message_stays_single_arg() {
        let argv = build_argv(
            "agent --model {model} {message}",
            "/bin/agent",
            "gpt-4o",
            "Fix the bug.\nLine 2 with 'quotes'",
        );
        assert_eq!(argv.len(), 4);
        assert!(argv[3].contains('\n'));
    }

    #[test]
    fn test_parse_pytest_summary_passed_and_failed() {
        let output = "===== 5 passed, 3 failed in 1.23s =====";
        assert_eq!(parse_pytest_summary(output), (5, 8));
    }

    #[test]
    fn test_parse_pytest_summary_all_passed() {
        let output = "===== 8 passed in 0.5s =====";
        assert_eq!(parse_pytest_summary(output), (8, 8));
    }

    #[test]
    fn test_parse_pytest_summary_no_match() {
        assert_eq!(parse_pytest_summary("no pytest output here"), (0, 0));
    }

    #[test]
    fn test_copy_project_files_excludes_test_and_pycache() {
        let dir = tempfile::tempdir().unwrap();

        let src = dir.path().join("project");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("main.py"), "print('hi')").unwrap();
        std::fs::write(src.join("test.py"), "def test(): pass").unwrap();
        std::fs::create_dir_all(src.join("__pycache__")).unwrap();
        std::fs::write(src.join("__pycache__/cache.pyc"), "bytes").unwrap();

        let dest = dir.path().join("workdir");
        std::fs::create_dir_all(&dest).unwrap();
        copy_project_files(&src, &dest).unwrap();

        assert!(dest.join("main.py").exists());
        assert!(!dest.join("test.py").exists());
        assert!(!dest.join("__pycache__").exists());
    }

    #[test]
    fn test_git_init_creates_repo() {
        let dir = tempfile::tempdir().unwrap();
        let workdir = dir.path().join("workdir");
        std::fs::create_dir_all(&workdir).unwrap();
        std::fs::write(workdir.join("main.py"), "pass").unwrap();

        let result = git_init(&workdir);
        assert!(result.is_ok(), "git_init failed: {:?}", result);
        assert!(workdir.join(".git").exists());
    }
}

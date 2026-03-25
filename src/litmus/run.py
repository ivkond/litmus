"""
Scenario execution engine.

Runs LLM agent scenarios: uv sync -> agent call -> pytest.
Errors do not stop the run.
"""

import contextlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import PROJECT_ROOT

TEMPLATE_DIR = PROJECT_ROOT / "template"
RESULTS_DIR = PROJECT_ROOT / "results"


def get_scenario_ids(template_dir: Path) -> list[str]:
    """Scan template dir for subdirectories with prompt.txt, return scenario IDs."""
    if not template_dir.is_dir():
        return []
    return [
        d.name
        for d in sorted(template_dir.iterdir())
        if d.is_dir() and (d / "prompt.txt").is_file()
    ]


class CancelledError(Exception):
    """Raised when a task is cancelled via cancel_event."""


# Global registry of active child processes for cleanup on exit
_active_procs: set[subprocess.Popen] = set()
_active_procs_lock = threading.Lock()


_shutting_down = False


def _rmtree_retry(path: Path, retries: int = 3, delay: float = 0.5) -> None:
    """shutil.rmtree with retries for Windows file-lock issues."""
    for attempt in range(retries):
        try:
            shutil.rmtree(path)
            return
        except PermissionError:
            if attempt < retries - 1:
                time.sleep(delay)
            else:
                raise


def cleanup_children() -> None:
    """Kill all tracked child processes. Call on app exit."""
    global _shutting_down
    _shutting_down = True
    with _active_procs_lock:
        procs = list(_active_procs)
    for proc in procs:
        try:
            if proc.poll() is None:
                _kill_tree(proc.pid)
        except Exception:
            pass


def _resolve_cmd_to_exe(cmd: list[str]) -> list[str]:
    """
    On Windows, .CMD/.BAT wrappers route through cmd.exe which mangles
    special characters in arguments. This function reads the .CMD file,
    detects the actual executable (e.g. node.exe, powershell.exe), and
    rewrites the command to call it directly — bypassing cmd.exe entirely.

    Supported patterns:
      - Node.js wrappers: "%_prog%" "path/to/script.js" %*
      - PowerShell wrappers: powershell.exe ... -File "script.ps1" %*
    """
    if sys.platform != "win32" or not cmd:
        return cmd
    exe = cmd[0]
    if not exe.lower().endswith((".cmd", ".bat")):
        return cmd

    try:
        content = Path(exe).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return cmd

    # Pattern 1: Node.js npm/yarn .CMD wrappers
    # Common form: "%_prog%" "dp0\node_modules\...\entry.js" %*
    # Or: "node" "dp0\path\to\entry.js" %*
    # The dp0 variable points to the .CMD directory
    cmd_dir = str(Path(exe).parent)

    # Look for node.exe invocations with a JS entry point
    # Patterns: "%_prog%"  "%dp0%\path\to\script" %*
    #           "node"  "%dp0%\path\to\script" %*
    node_match = re.search(
        r'["\']?%_prog%["\']?\s+["\']?%dp0%\\([^"\'%]+)["\']?\s+%\*',
        content,
    )
    if node_match:
        script_rel = node_match.group(1)
        script_path = Path(cmd_dir) / script_rel
        node_exe = shutil.which("node")
        if node_exe and script_path.is_file():
            return [node_exe, str(script_path), *cmd[1:]]

    # Pattern 2: PowerShell wrappers
    ps_match = re.search(
        r'powershell\.exe\s+.*-File\s+["\']?([^"\']+\.ps1)["\']?\s+%\*',
        content,
        re.IGNORECASE,
    )
    if ps_match:
        script_raw = ps_match.group(1)
        # Resolve %SCRIPT_DIR% or %~dp0 references
        script_raw = script_raw.replace("%SCRIPT_DIR%", cmd_dir)
        script_raw = script_raw.replace("%~dp0", cmd_dir + "\\")
        ps_exe = shutil.which("powershell")
        if ps_exe and Path(script_raw).is_file():
            return [
                ps_exe,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script_raw,
                *cmd[1:],
            ]

    # Fallback: prepend cmd /c (may mangle special chars in args)
    return ["cmd", "/c", *cmd]


def _run_popen(
    cmd: list[str],
    cwd: Path,
    log_file: Path,
    label: str,
    run_id: str,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Run command via Popen, writing output to log_file.

    Kills process and raises CancelledError if cancel_event is set.
    """
    try:
        # On Windows, .CMD/.BAT files can't be run directly by CreateProcess,
        # and cmd.exe mangles special characters in arguments.
        # _resolve_cmd_to_exe() bypasses cmd.exe by finding the real executable.
        run_cmd_list = _resolve_cmd_to_exe(list(cmd))
        with log_file.open("w", encoding="utf-8") as f:
            proc = subprocess.Popen(
                run_cmd_list,
                cwd=cwd,
                stdout=f,
                stderr=subprocess.STDOUT,
                text=True,
            )
            with _active_procs_lock:
                _active_procs.add(proc)
            try:
                while proc.poll() is None:
                    if cancel_event and cancel_event.is_set():
                        _kill_tree(proc.pid)
                        proc.wait()
                        f.write("\n[cancelled]")
                        raise CancelledError()
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        proc.wait(timeout=0.5)
            finally:
                with _active_procs_lock:
                    _active_procs.discard(proc)
        if proc.returncode != 0:
            if _shutting_down:
                # Process was killed during app shutdown — not a real failure
                with log_file.open("a", encoding="utf-8") as f:
                    f.write("\n[killed at shutdown]")
                raise CancelledError()
            with log_file.open("a", encoding="utf-8") as f:
                f.write(f"\n[exit code {proc.returncode}]")
            print(f"  [{run_id}] {label} failed (exit {proc.returncode})", file=sys.stderr)
            return False
        return True
    except CancelledError:
        raise
    except Exception as e:
        print(f"  [{run_id}] {label} error: {e}", file=sys.stderr)
        with contextlib.suppress(OSError), log_file.open("a", encoding="utf-8") as f:
            f.write(f"\nException: {e}")
        return False


def _kill_tree(pid: int) -> None:
    """Kill process and all its children. Cross-platform."""
    try:
        if sys.platform == "win32":
            # /T = kill tree, /F = force
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            # Invariant: pid's process group must be only this job's tree. Default
            # Popen() does not call setsid / start_new_session — the child often
            # shares the parent's PGID, so killpg can fail or hit the wrong scope.
            # Fixing that (e.g. start_new_session=True) changes TTY ownership and
            # signal delivery for all spawned CLIs; validate separately before enabling.
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:
        # Best-effort: if kill fails, process may have already exited
        pass


def run_cmd(
    cmd: list[str],
    cwd: Path,
    log_file: Path,
    step_name: str,
    run_id: str,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Run command, writing output to log_file. Supports cancellation via cancel_event."""
    return _run_popen(cmd, cwd, log_file, step_name, run_id, cancel_event)


def build_agent_argv(template: str, model: str, message: str) -> list[str]:
    """Build argv list from command template. Placeholders: {model}, {message}.

    Prompt text is passed as a single argument (no splitting on newlines).
    The template is tokenized with shlex.split to support quoted paths.
    The executable is resolved via shutil.which on the first token.
    """
    tokens = shlex.split(template, posix=(sys.platform != "win32"))
    argv = []
    for t in tokens:
        if t == "{model}":
            argv.append(model)
        elif t == "{message}":
            argv.append(message)
        else:
            argv.append(t)
    if argv:
        exe = shutil.which(argv[0])
        if exe is not None:
            argv[0] = exe
    return argv


def run_agent_argv(
    argv: list[str],
    cwd: Path,
    log_file: Path,
    run_id: str,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Run agent, writing output to log_file. Supports cancellation via cancel_event."""
    return _run_popen(argv, cwd, log_file, "agent", run_id, cancel_event)


def make_model_safe(model: str) -> str:
    """Make model name filesystem-safe (injective — no collisions).

    Uses tilde-escaping: ~ is the escape char, / and : are replaced.
    Avoids percent-encoding (%2F) which Node.js agents decode back
    into slashes, breaking directory paths.

      kilo/minimax/minimax-m2.5:free  -> kilo~fminimax~fminimax-m2.5~cfree
      claude-sonnet-4-5               -> claude-sonnet-4-5  (unchanged)
    """
    return model.replace("~", "~~").replace("/", "~f").replace(":", "~c")


def unmake_model_safe(safe: str) -> str:
    """Reverse of make_model_safe."""
    return safe.replace("~c", ":").replace("~f", "/").replace("~~", "~")


class StepLog:
    """
    Structured step log for a single scenario run.
    Writes steps.json in work_dir with chronological list of steps.

    Log files are auto-numbered: 01_sync.log, 02_agent.log, etc.
    The caller provides a short tag (e.g. "sync", "agent", "test")
    and gets back the full Path to the log file.
    """

    def __init__(self, work_dir: Path) -> None:
        self._work_dir = work_dir
        self._steps: list[dict] = []
        self._file = work_dir / "steps.json"
        self._counter = 0

    def begin(self, name: str, tag: str) -> tuple[int, Path]:
        """Start a new step.

        Args:
            name: human-readable step name (shown in UI).
            tag: short identifier for the log filename (e.g. "sync", "agent").

        Returns:
            (step_index, log_file_path).
        """
        self._counter += 1
        log_name = f"{self._counter:02d}_{tag}.log"
        log_path = self._work_dir / log_name
        step = {
            "name": name,
            "log_file": log_name,
            "status": "running",
            "start": time.monotonic(),
            "start_iso": time.strftime("%H:%M:%S"),
            "end_iso": None,
            "elapsed": None,
        }
        self._steps.append(step)
        self._flush()
        return len(self._steps) - 1, log_path

    def finish(self, idx: int, status: str) -> None:
        """Finish a step with status (done/failed/cancelled)."""
        step = self._steps[idx]
        elapsed = time.monotonic() - step["start"]
        step["status"] = status
        step["elapsed"] = round(elapsed, 1)
        step["end_iso"] = time.strftime("%H:%M:%S")
        del step["start"]  # remove monotonic (not serializable)
        self._flush()

    def _flush(self) -> None:
        # Write a serializable copy (strip monotonic 'start' from running steps)
        out = []
        for s in self._steps:
            d = {k: v for k, v in s.items() if k != "start"}
            out.append(d)
        self._file.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


def _snapshot_dir(d: Path) -> set[tuple[str, float]]:
    """Return {(relative_path, mtime)} for all files in directory."""
    result: set[tuple[str, float]] = set()
    if not d.is_dir():
        return result
    for f in d.rglob("*"):
        if f.is_file():
            with contextlib.suppress(OSError):
                result.add((str(f.relative_to(d)), f.stat().st_mtime))
    return result


def run_single_scenario(
    cmd_template: str,
    model: str,
    scenario_id: str,
    template_dir: Path,
    work_dir: Path,
    run_id: str,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Run a single scenario for one (agent, model) pair.

    work_dir: scenario directory (<agent_model>/<scenario>).
        Logs and steps.json are written here.
    agent_dir: work_dir / "workdir".
        Agent working directory: project files are copied here,
        agent runs here, pytest runs here.

    Returns True if scenario passed.
    Raises CancelledError on cancellation via cancel_event.
    """
    tpl_scenario = template_dir / scenario_id
    tpl_project = tpl_scenario / "project"
    prompt_file = tpl_scenario / "prompt.txt"

    if not prompt_file.is_file():
        return False

    # Create scenario dir and agent workdir
    if work_dir.exists():
        _rmtree_retry(work_dir)
    work_dir.mkdir(parents=True)

    agent_dir = work_dir / "workdir"
    if tpl_project.is_dir() and any(tpl_project.iterdir()):
        shutil.copytree(
            tpl_project,
            agent_dir,
            ignore=shutil.ignore_patterns("test.py", "__pycache__"),
        )
    else:
        agent_dir.mkdir(parents=True)

    # Most coding agents (Claude Code, Codex, OpenCode) require a git repo
    # to identify the project root and enable file-write tools.
    # An initial commit is needed — some agents reject repos with no history.
    # .gitignore prevents agents from indexing .venv (thousands of files,
    # long paths on Windows cause ENOENT during project scanning).
    (agent_dir / ".gitignore").write_text(
        ".venv/\n__pycache__/\n.pytest_cache/\n", encoding="utf-8",
    )
    subprocess.run(["git", "init"], cwd=agent_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["git", "add", "."], cwd=agent_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(
        ["git", "-c", "user.name=litmus", "-c", "user.email=litmus@test",
         "commit", "-m", "init", "--allow-empty"],
        cwd=agent_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    log = StepLog(work_dir)
    prompt_text = prompt_file.read_text(encoding="utf-8")

    # project/ has pyproject.toml — run uv sync and tests
    has_pyproject = (tpl_project / "pyproject.toml").is_file()
    if has_pyproject:
        idx, log_path = log.begin("Project init (uv sync)", "sync")
        try:
            ok = run_cmd(
                ["uv", "sync"],
                agent_dir,
                log_path,
                "uv sync",
                run_id,
                cancel_event,
            )
        except CancelledError:
            log.finish(idx, "cancelled")
            raise
        log.finish(idx, "done" if ok else "failed")
        if not ok:
            return False

    # Snapshot working directory before agent runs (to detect silent failures)
    before_snapshot = _snapshot_dir(agent_dir)

    idx, log_path = log.begin(f"Agent call ({model})", "agent")
    agent_argv = build_agent_argv(cmd_template, model, prompt_text)
    try:
        agent_ok = run_agent_argv(
            agent_argv,
            agent_dir,
            log_path,
            run_id,
            cancel_event,
        )
    except CancelledError:
        log.finish(idx, "cancelled")
        raise

    # Warn if agent exited 0 but didn't touch any files (possible silent failure)
    if agent_ok and _snapshot_dir(agent_dir) == before_snapshot:
        print(
            f"  [{run_id}] warning: agent exited 0 but modified no files",
            file=sys.stderr,
        )
        with contextlib.suppress(OSError), log_path.open("a", encoding="utf-8") as f:
            f.write("\n[litmus] warning: agent exited 0 but modified no files")

    log.finish(idx, "done" if agent_ok else "failed")

    if not agent_ok:
        return False

    if has_pyproject:
        template_test = tpl_project / "test.py"
        if template_test.is_file():
            max_retries = 2  # initial run + N retries
            for attempt in range(max_retries + 1):
                # Inject test.py before pytest, remove after
                shutil.copy2(template_test, agent_dir / "test.py")

                test_label = f"Run tests (pytest){' #' + str(attempt + 1) if attempt > 0 else ''}"
                idx, log_path = log.begin(test_label, "test")
                try:
                    ok = run_cmd(
                        ["uv", "run", "pytest", "test.py", "-v"],
                        agent_dir,
                        log_path,
                        "pytest",
                        run_id,
                        cancel_event,
                    )
                except CancelledError:
                    log.finish(idx, "cancelled")
                    (agent_dir / "test.py").unlink(missing_ok=True)
                    raise
                log.finish(idx, "done" if ok else "failed")

                # Remove test.py so agent can't see it on retry
                (agent_dir / "test.py").unlink(missing_ok=True)

                if ok:
                    return True

                # Tests failed — if we have retries left, send test output to agent
                if attempt < max_retries:
                    test_output = log_path.read_text(encoding="utf-8", errors="replace")
                    retry_prompt = (
                        f"The tests failed. Here is the test output:\n\n"
                        f"```\n{test_output}\n```\n\n"
                        f"Please fix the code so that all tests pass."
                    )
                    idx, log_path = log.begin(
                        f"Agent retry #{attempt + 1} ({model})",
                        "agent_retry",
                    )
                    retry_argv = build_agent_argv(cmd_template, model, retry_prompt)
                    try:
                        retry_ok = run_agent_argv(
                            retry_argv,
                            agent_dir,
                            log_path,
                            run_id,
                            cancel_event,
                        )
                    except CancelledError:
                        log.finish(idx, "cancelled")
                        raise
                    log.finish(idx, "done" if retry_ok else "failed")

            return False  # all retries exhausted
    return True  # no pyproject or no test file — consider passed

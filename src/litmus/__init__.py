"""Litmus — LLM scenario runner."""

from pathlib import Path

# Workspace root — set by main() at launch, contains template/, results/, config.yaml.
# Defaults to CWD but validated to contain template/ before the app starts.
PROJECT_ROOT: Path = Path.cwd()


def _init_workspace(target: Path) -> None:
    """Create a minimal litmus workspace with a sample scenario."""
    import sys

    template_dir = target / "template"
    if template_dir.is_dir() and any(template_dir.iterdir()):
        print(f"Workspace already initialised in {target}", file=sys.stderr)
        sys.exit(1)

    # ── Directory structure ──────────────────────────────────────────────
    template_dir.mkdir(exist_ok=True)
    (target / "results").mkdir(exist_ok=True)

    # ── Sample scenario ──────────────────────────────────────────────────
    sample = template_dir / "hello-world"
    sample.mkdir(exist_ok=True)

    (sample / "task.txt").write_text(
        "Write a Python function greet(name) that returns 'Hello, {name}!'.\n",
        encoding="utf-8",
    )
    (sample / "prompt.txt").write_text(
        "Implement the function greet(name) in main.py.\n"
        "It should return a greeting string in the format 'Hello, {name}!'.\n"
        "Include type hints.\n",
        encoding="utf-8",
    )
    (sample / "scoring.csv").write_text(
        "criterion,score\n"
        "Type hints in signature,1\n"
        "Correct return format,1\n"
        "Handles empty string,1\n",
        encoding="utf-8",
    )

    project = sample / "project"
    project.mkdir(exist_ok=True)
    (project / "main.py").write_text(
        'def greet(name: str) -> str:\n    """Return a greeting for the given name."""\n    ...\n',
        encoding="utf-8",
    )

    print(f"Workspace initialised in {target}")
    print("  template/hello-world  -- sample scenario")
    print("  results/              -- run results will go here")
    print()
    print("Next: run 'litmus' to open the TUI.")


def main() -> None:
    import atexit
    import sys

    global PROJECT_ROOT
    PROJECT_ROOT = Path.cwd()

    # ── Subcommands ──────────────────────────────────────────────────────
    if len(sys.argv) > 1 and sys.argv[1] == "init":
        _init_workspace(PROJECT_ROOT)
        return

    # ── Auto-scaffold: offer to create workspace if template/ missing ────
    if not (PROJECT_ROOT / "template").is_dir():
        print(f"No 'template/' directory found in {PROJECT_ROOT}")
        try:
            answer = input("Create a new litmus workspace here? [Y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit(1)
        if answer in ("", "y", "yes", "д", "да"):
            _init_workspace(PROJECT_ROOT)
            return
        print("Aborted. You can also run 'litmus init' explicitly.", file=sys.stderr)
        sys.exit(1)

    from .app import HarnessApp
    from .run import cleanup_children

    atexit.register(cleanup_children)
    HarnessApp().run()

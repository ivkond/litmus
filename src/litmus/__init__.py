"""Litmus — LLM scenario runner."""

from pathlib import Path

# Workspace root — set by main() at launch, contains template/, results/, config.yaml.
# Defaults to CWD but validated to contain template/ before the app starts.
PROJECT_ROOT: Path = Path.cwd()


def main() -> None:
    import atexit
    import sys

    global PROJECT_ROOT
    PROJECT_ROOT = Path.cwd()

    if not (PROJECT_ROOT / "template").is_dir():
        print(
            f"Error: no 'template/' directory in {PROJECT_ROOT}\n"
            f"Run litmus from the project root (the directory containing template/).",
            file=sys.stderr,
        )
        sys.exit(1)

    from .app import HarnessApp
    from .run import cleanup_children

    atexit.register(cleanup_children)
    HarnessApp().run()

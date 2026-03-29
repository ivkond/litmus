#!/bin/bash
set -euo pipefail

# mock/run.sh — Copies pre-built solution into project/
# Contract: --model <model> --prompt <text> --workspace <path> --scenario-dir <path>
# Exit: 0 = done, 2 = error

MODEL=""
PROMPT=""
WORKSPACE=""
SCENARIO_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --scenario-dir) SCENARIO_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$WORKSPACE" || -z "$SCENARIO_DIR" ]]; then
  echo "Usage: mock/run.sh --model <m> --prompt <p> --workspace <path> --scenario-dir <path>" >&2
  exit 2
fi

SOLUTION_DIR="$SCENARIO_DIR/solution"
if [[ ! -d "$SOLUTION_DIR" ]]; then
  echo "Error: no solution/ directory in $SCENARIO_DIR" >&2
  exit 2
fi

# Copy solution files into project/ (same location a real agent would modify)
cp -r "$SOLUTION_DIR/"* "$WORKSPACE/project/"

echo "Mock agent: copied solution from $SOLUTION_DIR to $WORKSPACE/project/"

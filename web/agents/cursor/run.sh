#!/bin/bash
set -euo pipefail

# cursor/run.sh — Run Cursor CLI agent
# Contract: --model <model> --prompt <text> --workspace <path> --scenario-dir <path>
# Requires: CURSOR_API_KEY env var
# Exit: 0 = done, 2 = agent error

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

if [[ -z "$MODEL" || -z "$PROMPT" || -z "$WORKSPACE" ]]; then
  echo "Usage: cursor/run.sh --model <m> --prompt <p> --workspace <path> --scenario-dir <path>" >&2
  exit 2
fi

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Error: CURSOR_API_KEY not set" >&2
  exit 2
fi

# Run Cursor agent in headless mode
cursor agent -p "$PROMPT" \
    --model "$MODEL" \
    --workspace "$WORKSPACE" \
    --force --trust --print \
    2>&1 | tee "$WORKSPACE/logs/agent.log"

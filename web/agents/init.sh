#!/bin/bash
set -euo pipefail

# init.sh — Prepare workspace for agent execution
# Contract: --scenario <path> --workspace <path>
# Copies ALL scenario files into workspace, installs deps if needed
# Exit: 0 = ready, 2 = error

SCENARIO=""
WORKSPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario) SCENARIO="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SCENARIO" || -z "$WORKSPACE" ]]; then
  echo "Usage: init.sh --scenario <path> --workspace <path>" >&2
  exit 2
fi

# Create workspace structure
mkdir -p "$WORKSPACE/logs"

# Copy ALL scenario contents into workspace (preserves directory structure).
# This includes project/, test files, fixtures, data, templates, and any
# language-specific assets — anything the scenario author ships.
cp -a "$SCENARIO"/. "$WORKSPACE/"
# Remove orchestrator-only files that shouldn't be in the workspace
rm -f "$WORKSPACE/prompt.txt" "$WORKSPACE/manifest.json"

# Install Python deps if requirements.txt exists
if [[ -f "$WORKSPACE/project/requirements.txt" ]]; then
  pip install -q -r "$WORKSPACE/project/requirements.txt"
fi

echo "Workspace ready: $WORKSPACE"

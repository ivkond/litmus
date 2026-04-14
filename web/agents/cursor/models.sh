#!/bin/bash
set -euo pipefail

# cursor/models.sh — Discover available Cursor models via CLI
# Requires: `agent` CLI (https://cursor.com/cli) in PATH
# Output: JSON array to stdout

infer_provider() {
  case "$1" in
    gpt-*|o-*) echo "OpenAI" ;;
    claude-*)  echo "Anthropic" ;;
    gemini-*)  echo "Google" ;;
    grok-*)    echo "xAI" ;;
    kimi-*)    echo "Moonshot" ;;
    *)         echo "" ;;
  esac
}

if command -v agent &>/dev/null; then
  raw=$(NO_COLOR=1 agent models 2>/dev/null | sed 's/\x1b\[[0-9;]*[A-Za-z]//g') || true

  if [[ -n "$raw" ]]; then
    first=true
    echo "["
    while IFS= read -r line; do
      # Skip empty lines, header, spinner, and tip
      [[ -z "$line" ]] && continue
      [[ "$line" == "Available models"* ]] && continue
      [[ "$line" == "Tip:"* ]] && continue
      [[ "$line" == *"Loading"* ]] && continue
      # Must match "id - Name" format
      [[ "$line" != *" - "* ]] && continue

      # Parse: "id - Name  (annotations)", strip whitespace
      id=$(echo "${line%% - *}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      rest="${line#* - }"
      # Strip trailing annotations like (default), (current) and trim
      name=$(echo "$rest" | sed 's/  *([^)]*)$//;s/^[[:space:]]*//;s/[[:space:]]*$//')

      provider=$(infer_provider "$id")

      $first || echo ","
      first=false
      printf '  {"id": "%s", "name": "%s", "provider": "%s"}' "$id" "$name" "$provider"
    done <<< "$raw"
    echo ""
    echo "]"
    exit 0
  fi
fi

# Fallback: hardcoded subset if agent CLI unavailable
cat <<'EOF'
[
  {"id": "gpt-5.4-medium", "name": "GPT-5.4 1M", "provider": "OpenAI"},
  {"id": "claude-4.6-sonnet-medium", "name": "Sonnet 4.6 1M", "provider": "Anthropic"},
  {"id": "claude-4.6-opus-high", "name": "Opus 4.6 1M", "provider": "Anthropic"},
  {"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro", "provider": "Google"},
  {"id": "composer-2", "name": "Composer 2", "provider": ""},
  {"id": "gpt-5.3-codex", "name": "GPT-5.3 Codex", "provider": "OpenAI"}
]
EOF

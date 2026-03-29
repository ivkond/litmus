#!/bin/bash
set -euo pipefail

# cursor/models.sh — Discover available Cursor models
# Requires: CURSOR_API_KEY env var
# Output: JSON array to stdout

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Error: CURSOR_API_KEY not set" >&2
  exit 2
fi

# Cursor CLI: list available models as JSON
# Fallback: hardcoded list if CLI doesn't support model listing yet
if cursor models --json 2>/dev/null; then
  exit 0
fi

# Fallback: known Cursor-supported models
cat <<'EOF'
[
  {"id": "gpt-4o", "name": "GPT-4o", "provider": "OpenAI"},
  {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "provider": "Anthropic"},
  {"id": "claude-3.5-sonnet", "name": "Claude 3.5 Sonnet", "provider": "Anthropic"},
  {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "provider": "Google"}
]
EOF

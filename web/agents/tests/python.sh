#!/bin/bash
set -euo pipefail

# tests/python.sh — Run pytest and write test-results.json
# Contract: --workspace <path> --output <path>
# Exit: 0 = all pass, 1 = some fail, 2 = infra error

WORKSPACE=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$WORKSPACE" || -z "$OUTPUT" ]]; then
  echo "Usage: tests/python.sh --workspace <path> --output <path>" >&2
  exit 2
fi

cd "$WORKSPACE"

# Run pytest with JSON report
REPORT_FILE="$WORKSPACE/.report.json"

pytest test.py \
  --json-report \
  --json-report-file="$REPORT_FILE" \
  -q 2>&1 || TEST_EXIT=$?

TEST_EXIT=${TEST_EXIT:-0}

# Parse pytest-json-report into our canonical format
if [[ -f "$REPORT_FILE" ]]; then
  python3 -c "
import json, sys

with open('$REPORT_FILE') as f:
    report = json.load(f)

tests = report.get('tests', [])
passed = sum(1 for t in tests if t['outcome'] == 'passed')
total = len(tests)
details = []
for t in tests:
    details.append({
        'name': t.get('nodeid', '').split('::')[-1],
        'status': 'passed' if t['outcome'] == 'passed' else 'failed',
        'duration_ms': int((t.get('duration', 0)) * 1000),
        'message': t.get('call', {}).get('longrepr', '') if t['outcome'] != 'passed' else ''
    })

result = {
    'tests_passed': passed,
    'tests_total': total,
    'framework': 'pytest',
    'details': details
}

with open('$OUTPUT', 'w') as f:
    json.dump(result, f, indent=2)
"
else
  # pytest didn't produce a report — infra error
  echo '{"tests_passed":0,"tests_total":0,"framework":"pytest","details":[]}' > "$OUTPUT"
  exit 2
fi

exit $TEST_EXIT

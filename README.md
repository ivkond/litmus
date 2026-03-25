# Litmus 🧪

[![CI](https://github.com/ivkond/litmus/actions/workflows/ci.yml/badge.svg)](https://github.com/ivkond/litmus/actions/workflows/ci.yml)
[![Security (Bandit)](https://github.com/ivkond/litmus/actions/workflows/bandit.yml/badge.svg)](https://github.com/ivkond/litmus/actions/workflows/bandit.yml)
[![Security (OSV)](https://github.com/ivkond/litmus/actions/workflows/osv-scanner.yml/badge.svg)](https://github.com/ivkond/litmus/actions/workflows/osv-scanner.yml)
[![PyPI](https://img.shields.io/pypi/v/litmus-llm)](https://pypi.org/project/litmus-llm/)
[![Python](https://img.shields.io/pypi/pyversions/litmus-llm)](https://pypi.org/project/litmus-llm/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Terminal UI for running LLM agent scenarios and comparing their performance.**

Litmus executes coding tasks across multiple AI agents and models, runs tests against the results, and produces detailed evaluation reports — all from a single TUI.

## What it does

1. **Detects agents** installed on your system (Claude Code, Codex, Aider, Cursor Agent, KiloCode, OpenCode)
2. **Runs scenarios** — each scenario is a coding task with tests and scoring criteria
3. **Evaluates results** — an LLM judge scores agent and model performance across 20 criteria each
4. **Generates reports** — HTML reports with per-scenario breakdowns, logs, and scores

## Supported agents

| Agent | Binary | Model listing |
|-------|--------|---------------|
| Claude Code | `claude` | Built-in list |
| Codex | `codex` | Built-in list |
| OpenCode | `opencode` | `opencode models` |
| KiloCode | `kilocode` | `kilocode models` |
| Aider | `aider` | `aider --list-models` |
| Cursor Agent | `agent` | `agent models` |

Litmus auto-detects which agents are available and queries their model lists.

## Quick start

Requires **Python 3.12+**.

```bash
pip install litmus-llm
litmus init      # create a workspace with a sample scenario
litmus           # open the TUI
```

Or run without installing via [uv](https://docs.astral.sh/uv/):

```bash
uvx --from litmus-llm litmus
```

### Development setup

```bash
git clone https://github.com/ivkond/litmus.git
cd litmus
uv sync
uv run litmus
```

### TUI workflow

1. 📋 **Models** — select agents and models to test
2. 🧩 **Scenarios** — pick which coding tasks to run
3. ▶️ **Run** — watch execution progress in real time
4. 📊 **Analysis** — review LLM-judged scores
5. 📄 **Reports** — browse generated HTML reports

## How it works

Each scenario lives in `template/<id>/` and contains:

```
template/1-data-structure/
  prompt.txt        # Task description sent to the agent
  task.txt          # Detailed requirements
  scoring.csv       # Evaluation criteria
  project/          # Starter code with tests
```

Execution pipeline per scenario:

```
uv sync  ->  agent call  ->  pytest  ->  collect logs
```

After all runs complete, an LLM judge evaluates the results using 20 agent criteria (tool efficiency, error recovery, reasoning depth...) and 20 model criteria (code correctness, instruction following, hallucination resistance...).

## Configuration

On first launch, Litmus generates a config file with detected agents and their settings. Configure the analysis model (any OpenAI-compatible API) through the TUI settings screen.

## Scenario packs

Litmus supports exporting and importing scenario archives (`.litmus-pack` ZIP files) for sharing test suites between machines or teams.

## Project structure

```
src/litmus/
  __init__.py       # Entry point, workspace init
  app.py            # Main app, menu screen
  agents.py         # Agent registry, detection, model listing
  run.py            # Scenario execution engine
  analysis.py       # LLM-powered evaluation (20+20 criteria)
  report.py         # HTML report generation
  pack/             # Scenario export/import
  screens/          # TUI screens (models, scenarios, run, results, analysis)
```

## Tech stack

- [Textual](https://textual.textualize.io/) — TUI framework
- [Rich](https://rich.readthedocs.io/) — terminal formatting
- [Pydantic](https://docs.pydantic.dev/) — structured evaluation models
- [OpenAI SDK](https://github.com/openai/openai-python) — LLM judge (any compatible API)

## License

[MIT](LICENSE)

# TODO

Deferred tasks from code review (2026-03-24).

## Architecture

- [x] Split `app.py` into `screens/` package (done 2026-03-25):
  - `screens/_common.py` — `TEMPLATE_DIR`, `RESULTS_DIR`, `ModelSelectionList`, `FilterInput`, `OpenWithScreen`
  - `screens/models.py` — `ModelsScreen`
  - `screens/scenarios.py` — `ScenariosScreen`, `ScenarioEditScreen`, `ConfirmDeleteScreen`, export/import screens
  - `screens/run.py` — `RunState`, `RunConfigScreen`, `RunProgressScreen`, `RunViewerScreen`, `RunDetailScreen`
  - `screens/results.py` — `ResultsBrowserScreen`
  - `screens/analysis.py` — `AnalysisModal`, `SettingsScreen`

## Configuration

- [ ] Rework config resolution: search and merge from multiple locations:
  1. `~/.config/litmus/litmus.yaml` — user-level defaults
  2. `./litmus.yaml` — project-level overrides
  - Rename config file from `config.yaml` to `litmus.yaml` across the codebase
  - Merge strategy: project-level overrides user-level, agents lists are merged by name

## Testing

- [ ] Add unit tests for:
  - Model name parsers (`_parse_lines`, `_parse_aider`, `_parse_cursor`)
  - `make_model_safe()` / reverse mapping
  - `StepLog` (begin/finish/flush)
  - `_parse_json_from_text()` (direct JSON, markdown fence, brace extraction)
  - `export_scenarios` / `import_scenarios` round-trip

## CI/CD

- [x] Set up GitHub Actions workflow (done 2026-03-25):
  - `ci.yml` orchestrator → `ci-quality.yml` (ruff + pyright) + `ci-tests.yml` (pytest, Python 3.12/3.13)
  - `bandit.yml` — Python security linter (SARIF → Security tab)
  - `osv-scanner.yml` — dependency vulnerability scan (SARIF → Security tab)
  - `dependabot.yml` — uv + github-actions ecosystems, weekly
- [x] Publish to PyPI (done 2026-03-25):
  - `publish.yml` — TestPyPI on push to `main`, PyPI on GitHub release (tag `v*`)
  - Uses trusted publishing (OIDC, no API tokens)

## Known issues

- [x] `make_model_safe` collision risk — resolved: now uses percent-encoding (`%2F`, `%3A`), injective mapping. `analysis.py` uses `unmake_model_safe()`.
- [x] `PROJECT_ROOT = Path.cwd()` — acceptable: validated in `main()` before app start; `Path(__file__)` would point to installed package, not user workspace.
- [ ] `analysis.py:210`: `run_name.split("_", 1)` to parse `{agent}_{model_safe}` is fragile if agent name contains `_`. Consider a separator that can't appear in agent names (e.g. writing a manifest file alongside run directories).

## Quality

- [ ] Replace HTML f-string generation in `report.py` / `analysis.py` with a template engine (e.g. Jinja2)

## Distribution

- [ ] Design a mechanism for publishing and distributing base scenarios (currently `template/` is gitignored). Options: include in package data, separate repo, download command.

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
  - `publish.yml` — TestPyPI on manual dispatch, PyPI on GitHub release
  - Uses trusted publishing (OIDC, no API tokens)
  - Requires: configure trusted publisher on TestPyPI/PyPI + create `testpypi`/`pypi` environments in repo settings

## Known issues

- [x] `make_model_safe` collision risk — resolved: now uses percent-encoding (`%2F`, `%3A`), injective mapping. `analysis.py` uses `unmake_model_safe()`.
- [x] `PROJECT_ROOT = Path.cwd()` — acceptable: validated in `main()` before app start; `Path(__file__)` would point to installed package, not user workspace.
- [ ] `analysis.py:210`: `run_name.split("_", 1)` to parse `{agent}_{model_safe}` is fragile if agent name contains `_`. Consider a separator that can't appear in agent names (e.g. writing a manifest file alongside run directories).

## Web

- [x] **Agent health check: verify agent image/binary, not just Docker daemon.** (done 2026-04-15)

- [ ] **Agent soft-delete / archiving.**
  DELETE returns 409 when agent has `run_results` or `run_tasks`. Design `archived_at` column + filter archived agents from active queries, allowing cleanup without losing historical data.

- [ ] **Authentication and authorization.**
  Web UI is currently open. Add auth layer: user login (OAuth / credentials), role-based access (admin can delete agents/modify settings, viewer can only read), API key auth for programmatic access.

- [ ] **UI: align with Lab Instrument design system.**
  Audit all screens against design spec. Fix inconsistencies in spacing, typography, color usage, component patterns. Ensure CSS variables are used consistently.

- [ ] **Settings: section panels and tab navigation.**
  Wrap each section (Agents, Judge Providers, Scoring, General) in collapsible panels. Consider tab-based navigation for better UX when section count grows.

- [ ] **Rework executor model: per-instance, not per-agent.**
  Executor type (docker/host/kubernetes) should be an application-level config set at startup, not a per-agent runtime choice. Remove executor type from agent CRUD, move to app config / environment. Agents reference the single configured executor instance.

- [ ] **CRUD for judge criteria.**
  Add UI and API for managing evaluation criteria (currently hardcoded in `lib/judge/criteria.ts`). Support create, edit, reorder, enable/disable individual criteria. Persist to DB, reference from scoring config.

## Quality

- [ ] Replace HTML f-string generation in `report.py` / `analysis.py` with a template engine (e.g. Jinja2)

## Distribution

- [ ] Design a mechanism for publishing and distributing base scenarios (currently `template/` is gitignored). Options: include in package data, separate repo, download command.

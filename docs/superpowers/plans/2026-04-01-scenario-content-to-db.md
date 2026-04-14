# Move prompt/task/scoring from S3 files to DB columns

## Context

Prompt, task, scoring — части сценария, не отдельные файлы. Переносим из S3 в колонки `scenarios`. Без обратной совместимости. Существующие данные в S3 **осознанно обнуляются** — пользователь пересохранит через UI (сценариев мало, они в раннем состоянии). Project files остаются в S3.

## Решения

- **Backfill**: не делаем. Колонки nullable, UI покажет пустые секции для пересохранения.
- **Judge context**: `scenario.prompt` (с fallback на `description`) вместо текущего `scenario?.description`.
- **`configSnapshot`**: старые раны с `promptPath` не мигрируются. Только новые раны.
- **`init.sh`**: удаляет `prompt.txt` из workspace — после миграции ни prompt.txt, ни task.txt, ни scoring.csv не попадают в workspace (stageScenario копирует только project/*). Это осознанное изменение — агенты не используют эти файлы из workspace напрямую. Без изменений в init.sh.
- **`web/scripts/pack.ts`**: без изменений — offline-only CLI, отдельный формат.

## Steps

### 1. DB schema + migration
- `web/src/db/schema.ts`: add `prompt text`, `task text`, `scoring text` to scenarios
- `web/drizzle/0007_scenario_content.sql` + journal

### 2. Types
- `web/src/lib/scenarios/types.ts`: add `prompt/task/scoring: string | null` to `ScenarioDetailResponse`

### 3. Queries
- `web/src/lib/scenarios/queries.ts`:
  - `fetchScenarioDetail()`: map prompt/task/scoring, filter files → only `project/*`
  - `fetchScenarioList()`: explicit column list (exclude prompt/task/scoring)

### 4. Scenario CRUD API
- `web/src/app/api/scenarios/route.ts` POST: accept + insert prompt/task/scoring; S3 upload only project/*
- `web/src/app/api/scenarios/[id]/route.ts`: GET return from DB, PUT accept prompt/task/scoring

### 5. Files API guard
- `web/src/app/api/scenarios/[id]/files/route.ts`: 410 for prompt.txt/task.txt/scoring.csv

### 6. LaneConfig
- `web/src/lib/orchestrator/types.ts`: `promptPath` → `prompt: string`

### 7. Runs API
- `web/src/app/api/runs/route.ts`: pass `scenario.prompt ?? fallback` (scenario already fetched in loop)

### 8. Scheduler
- `web/src/lib/orchestrator/scheduler.ts`:
  - `executeScenario()`: use `scenario.prompt` directly
  - `stageScenario()`: skip non-project/* files

### 9. Judge context
- `web/src/lib/judge/context.ts` line 91: `scenario?.prompt ?? scenario?.description ?? ''`

### 10. UI
- `web/src/app/scenarios/[id]/scenario-tabs.tsx`: General tab reads from props, saves via PUT /api/scenarios/{id}

### 11. Export/Import
- `web/src/app/api/scenarios/export/route.ts`: include prompt/task/scoring in manifest; S3 download loop — только `project/*` ключи (не включать prompt.txt/task.txt/scoring.csv в zip)
- `web/src/app/api/scenarios/import/route.ts`: read prompt/task/scoring from manifest, insert to DB; S3 upload — только `project/*` файлы из zip

### 12. Tests
- `web/src/lib/orchestrator/__tests__/scheduler.test.ts`: promptPath → prompt
- `web/src/app/api/scenarios/__tests__/files.test.ts`: update for 410 guard
- `web/src/app/api/scenarios/__tests__/create.test.ts`: update mock expectations
- `web/src/app/api/scenarios/__tests__/crud.test.ts`: update mock file lists
- `web/src/app/api/scenarios/__tests__/export.test.ts`: update manifest expectations
- `web/src/app/scenarios/[id]/__tests__/scenario-sidebar.test.tsx`: update if needed

## Verification

1. `npx tsc --noEmit` — clean
2. `npx vitest run` — all pass
3. `docker compose up --build`
4. Create scenario with prompt/task/scoring → saved in DB
5. Edit General tab → saves via PUT
6. Start run → scheduler uses prompt from DB
7. Judge → sees scenario.prompt (not just description)

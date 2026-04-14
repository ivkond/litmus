# Separate agentType (vendor) from agentSlug (instance)

## Context

`agentSlug` используется двояко: как instance ID агента (для логов, labels, workspace paths) и как ключ для директории скриптов (`agents/<slug>/`). Если slug != имени директории (например slug = `agent`, а скрипты в `agents/cursor/`), auth.json не находится, models.sh не работает.

**Решение**: добавить поле `agentType` в `agentExecutors` — вендор/тип агента (cursor, claude-code, mock). Он определяет директорию скриптов. `agentSlug` остаётся произвольным instance ID.

---

## Changes

### 1. DB schema + migration

`web/src/db/schema.ts` — добавить `agentType` в `agentExecutors`:
```ts
agentType: text('agent_type').notNull().default('mock'),
```

`web/drizzle/0006_agent_type.sql`:
```sql
ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS agent_type TEXT NOT NULL DEFAULT 'mock';
UPDATE agent_executors SET agent_type = agent_slug;  -- one-time backfill
```

### 2. Directory resolution: slug → type

`web/src/lib/orchestrator/docker-bind-paths.ts`:
- Rename param: `resolveAgentHostDirForDocker(agentType: string)` (parameter name only, function name stays)

`web/src/lib/agents/auth-schema.ts`:
- `loadAuthSchema(agentType: string)` — rename param for clarity

No logic changes in these functions — just the semantic meaning of the string they receive.

### 3. Callers: pass agentType instead of agentSlug for directory lookups

| File | Line | Change |
|------|------|--------|
| `web/src/app/api/agents/[id]/models/route.ts` | 42 | `resolveAgentHostDirForDocker(executor.agentType)` |
| `web/src/app/api/agents/[id]/auth/route.ts` | 31, 77, 121 | `loadAuthSchema(executor.agentType)` |
| `web/src/app/api/runs/route.ts` | 70 | `loadAuthSchema(executor.agentType)` |
| `web/src/lib/orchestrator/scheduler.ts` | 139 | `resolveAgentHostDirForDocker(lane.agent.type)` |

### 4. LaneConfig: add `type` to agent

`web/src/lib/orchestrator/types.ts` — LaneConfig.agent:
```ts
agent: { id: string; slug: string; type: string; name: string };
```

`web/src/app/api/runs/route.ts` (lane push):
```ts
agent: { id: agent.id, slug: executor.agentSlug, type: executor.agentType, name: agent.name },
```

### 5. UI: add Agent Type field to form

`web/src/components/settings/agent-form.tsx`:
- Add `agentType` dropdown/input (values = subdirectories in `agents/`: cursor, mock, etc.)
- Show above or beside slug
- Required field

`web/src/app/api/agents/route.ts` + `web/src/app/api/agents/[id]/route.ts`:
- Accept `agentType` in create/update schemas
- Store in DB

### 6. Unchanged (keep using agentSlug)

These stay as-is — they use slug correctly as an instance identifier:
- `scheduler.ts:132` — `laneKey` tracking
- `scheduler.ts:151` — container labels
- `scheduler.ts:223-224` — workspace paths `/work/runs/{runId}/{slug}/...`
- `reconciler.ts:78` — S3 artifact key
- `scheduler.ts:389` — TaskMeta

---

## Verification

1. Migration applies cleanly, existing agents get `agentType` backfilled from `agentSlug`
2. Edit agent form → see Agent Type field → set to "cursor"
3. Agent with slug "agent" + type "cursor" → auth.json loads from `agents/cursor/`
4. Discover Models works (resolves `agents/cursor/models.sh`)
5. Run creation validates required secrets from `agents/cursor/auth.json`
6. `npx vitest run` — all existing tests pass
7. `npx tsc --noEmit` — clean compilation

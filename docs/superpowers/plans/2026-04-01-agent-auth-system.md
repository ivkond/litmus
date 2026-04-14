# Agent Authentication System

## Context

Agent containers (Cursor, Claude Code, etc.) need API keys as env vars to call LLM providers. Currently `agentExecutors.config` JSONB column exists but is unused — no UI to populate it, no encryption, and the scheduler passes `env: {}` to containers. Result: `models.sh` fails with "CURSOR_API_KEY not set".

**Goal**: Add encrypted secret storage + UI for API keys (Phase 1), OAuth flow (Phase 2).

**Scope**: Phase 1 закрывает **только API key**. OAuth — отдельный PR с собственной миграцией и UI «Connect».

---

## Design Decisions

### OAuth data model
Phase 2 OAuth будет хранить `refresh_token` и `expires_at` как **отдельные колонки** в `agent_secrets` (добавятся миграцией в Phase 2). В Phase 1 эти колонки не создаются. `encrypted_value` всегда содержит одно скалярное значение (ключ или access token), не JSON blob.

### Обратная совместимость с `executor.config`
При сборке env для контейнера: `secrets` из `agent_secrets` **перекрывают** одноимённые ключи из `executor.config`. Формула: `{ ...executor.config, ...decryptedSecrets }`. Это позволяет постепенно мигрировать без потери существующих значений. В будущем `config` JSONB можно удалить.

### Auth/security
Litmus — localhost-only benchmarking tool. API routes открыты (нет сессий/middleware). Принимаем это как есть. При деплое за reverse proxy — basic auth на уровне nginx.

---

## Phase 1: API Key Auth (this PR)

### Step 1 — Generalize encryption module

- Move `web/src/lib/judge/encryption.ts` → `web/src/lib/encryption.ts`
- `getKey()`: check `LITMUS_ENCRYPTION_KEY` first, fallback to `JUDGE_ENCRYPTION_KEY`
- Add `maskKey(encrypted)`: decrypt → `••••` + last 4 chars (centralized, заменить дублирование в `judge-providers` routes на импорт)
- Leave re-export at old path (`web/src/lib/judge/encryption.ts` → `export * from '../encryption'`)
- Add `LITMUS_ENCRYPTION_KEY` to `web/src/lib/env.ts` (optional, `z.string().length(64)`)
- Add `LITMUS_ENCRYPTION_KEY: ${LITMUS_ENCRYPTION_KEY}` в `environment:` сервиса `litmus-web` в `docker-compose.yml`

### Step 2 — DB: `agent_secrets` table

```
agent_secrets:
  id            uuid PK
  agent_executor_id  uuid FK → agent_executors.id ON DELETE CASCADE
  env_var       text NOT NULL
  encrypted_value  text NOT NULL  (AES-256-GCM base64)
  auth_type     text ('api_key' | 'oauth')
  created_at    timestamp
  updated_at    timestamp
  UNIQUE(agent_executor_id, env_var)
```

- Add to `web/src/db/schema.ts`
- Generate migration via `npx drizzle-kit generate`
- OAuth-специфичные колонки (`oauth_refresh_token`, `oauth_expires_at`) НЕ добавляем — Phase 2

### Step 3 — Agent auth schema (`auth.json`)

Create `web/agents/cursor/auth.json`:
```json
{
  "authMethods": [
    { "type": "api_key", "envVar": "CURSOR_API_KEY", "label": "Cursor API Key", "required": true }
  ]
}
```

Create `web/src/lib/agents/auth-schema.ts` — types + `loadAuthSchema(slug)` reader.

**Политика путей в Docker** (compose маунтит `./agents:/opt/agent:ro` — весь каталог agents):
- `LITMUS_IN_DOCKER=1` → `path.join('/opt/agent', slug, 'auth.json')`
- Иначе (dev) → `path.resolve(process.cwd(), 'agents', slug, 'auth.json')`

**Агенты без `auth.json`** (mock и др.): `loadAuthSchema` возвращает `{ authMethods: [] }` (пустой список, без ошибки).

### Step 4 — Secrets helper

New `web/src/lib/agents/secrets.ts`:
- `getDecryptedSecretsForExecutor(executorId) → Record<string, string>` — reads `agent_secrets`, decrypts values
- Если `LITMUS_ENCRYPTION_KEY` / `JUDGE_ENCRYPTION_KEY` не задан — возвращает `{}` с warning в console (не crash)

### Step 5 — API routes

**`web/src/app/api/agents/[id]/auth/route.ts`**:
- `GET` — load auth.json schema + join with stored secrets → return `{ authMethods: [..., configured: bool, maskedValue] }`
- `PUT` — `{ envVar, value }` → **валидация**: `envVar` должен существовать в `auth.json` для данного `agentSlug` (защита от записи произвольных env vars) → encrypt + upsert into `agent_secrets`
- `DELETE` — `{ envVar }` → **валидация**: `envVar` должен существовать в `auth.json` (аналогично PUT) → remove secret
- `PUT`/`DELETE` при отсутствии encryption key → 503: «No encryption key configured (set LITMUS_ENCRYPTION_KEY or JUDGE_ENCRYPTION_KEY)»

### Step 6 — Fix container env flow

**`web/src/lib/orchestrator/types.ts`**: add `env?: Record<string, string>` to `LaneConfig`

**`web/src/app/api/runs/route.ts`** (где собираются `lanes`):
- Load secrets before building lanes, **кэшируя по `executor.id`** в `Map<string, Record<string, string>>` чтобы не дублировать запросы к БД при N моделях одного агента
- Merge: `{ ...(executor.config as Record<string,string> ?? {}), ...secrets }`
- **Валидация required secrets**: проверять **итоговый merged env** (`{ ...config, ...secrets }`): для каждого `required: true` && `type === 'api_key'` метода из `auth.json` значение должно быть задано и непустое → иначе 400 с перечнем недостающих переменных

```ts
const secretsCache = new Map<string, Record<string, string>>();
// ... в цикле по агентам:
if (!secretsCache.has(executor.id)) {
  const secrets = await getDecryptedSecretsForExecutor(executor.id);
  secretsCache.set(executor.id, { ...(executor.config as Record<string,string> ?? {}), ...secrets });
}
lanes.push({ ...existingFields, env: secretsCache.get(executor.id)! });
```

**`web/src/lib/orchestrator/scheduler.ts`**: pass `env: lane.env ?? {}` into container config

**`web/src/app/api/agents/[id]/models/route.ts`**: replace `executor.config as Record<string, string>` with merged secrets (аналогично runs)

### Step 7 — UI: auth section in agent form

New `web/src/components/settings/agent-auth-section.tsx`:
- Shown in edit mode only (after agent created)
- Fetches `GET /api/agents/[id]/auth` on mount
- Renders password input per `api_key` method
- If configured: shows `••••last4` + "Change" button
- Save calls `PUT /api/agents/[id]/auth`
- Follows existing CSS variable pattern from `agent-form.tsx`
- Agents без auth methods: секция не рендерится

Integrate into `web/src/components/settings/agent-form.tsx` below existing fields.

### Step 8 — Cleanup

- Remove `console.log('[model-discovery] bind paths:...')` from `web/src/app/api/agents/[id]/models/route.ts`
- Replace local `maskKey` duplicates in `web/src/app/api/settings/judge-providers/route.ts` and `web/src/app/api/settings/judge-providers/[id]/route.ts` with import from `web/src/lib/encryption.ts`

### Step 9 — Tests

Расположение: `__tests__/` рядом с модулем (конвенция проекта). Runner: `vitest run`.

- `web/src/lib/__tests__/encryption.test.ts` — encrypt/decrypt roundtrip, maskKey format (расширить существующий `web/src/lib/judge/__tests__/encryption.test.ts` или перенести вместе с модулем)
- `web/src/lib/agents/__tests__/secrets.test.ts` — getDecryptedSecretsForExecutor happy path, missing key graceful fallback
- `web/src/app/api/agents/[id]/auth/__tests__/auth.test.ts` — PUT validates envVar against auth.json, PUT без encryption key → 503, GET returns masked values, DELETE validates envVar

---

## Phase 2: OAuth (deferred, separate PR)

- Миграция: добавить `oauth_refresh_token` (text, encrypted), `oauth_expires_at` (timestamptz) к `agent_secrets`
- OAuth provider registry (`web/src/lib/agents/oauth-providers.ts`)
- Authorize/callback routes: **prefix `/api/agents/oauth/[provider]/`** (не `/api/auth/` — избежать коллизии с возможным NextAuth)
- Token refresh before container start
- UI "Connect" / "Disconnect" buttons
- Env vars: `CURSOR_OAUTH_CLIENT_ID`, `CURSOR_OAUTH_CLIENT_SECRET` в compose

---

## Critical files

| File | Change |
|------|--------|
| `web/src/lib/encryption.ts` | NEW — generalized from judge, includes `maskKey` |
| `web/src/lib/judge/encryption.ts` | Re-export from `../encryption` |
| `web/src/lib/env.ts` | Add `LITMUS_ENCRYPTION_KEY` |
| `web/docker-compose.yml` | Add `LITMUS_ENCRYPTION_KEY` to litmus-web environment |
| `web/src/db/schema.ts` | Add `agentSecrets` table |
| `web/src/lib/agents/auth-schema.ts` | NEW — types + loader (Docker path handling) |
| `web/src/lib/agents/secrets.ts` | NEW — decrypt helper |
| `web/src/app/api/agents/[id]/auth/route.ts` | NEW — CRUD for secrets (with envVar validation) |
| `web/src/app/api/agents/[id]/models/route.ts` | Use secrets helper, remove debug log |
| `web/src/app/api/runs/route.ts` | Load secrets into lanes (cached per executor), validate required |
| `web/src/lib/orchestrator/types.ts` | Add `env` to `LaneConfig` |
| `web/src/lib/orchestrator/scheduler.ts` | Pass `lane.env` |
| `web/src/components/settings/agent-auth-section.tsx` | NEW — UI component |
| `web/src/components/settings/agent-form.tsx` | Integrate auth section |
| `web/agents/cursor/auth.json` | NEW — cursor auth schema |
| `web/src/app/api/settings/judge-providers/route.ts` | Replace local maskKey with import |
| `web/src/app/api/settings/judge-providers/[id]/route.ts` | Replace local maskKey with import |

## Verification

1. Apply the generated DB migration (project's usual `drizzle-kit migrate` / compose flow).
2. Set `LITMUS_ENCRYPTION_KEY` in `.env` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
3. Rebuild: `docker compose up --build`
4. Open agent settings → edit Cursor agent → see "Authentication" section
5. Enter a test API key → see masked value after save
6. Edit mock agent → no auth section (no `auth.json`)
7. Click "Discover Models" on Cursor → should pass CURSOR_API_KEY to container
8. Try starting a run without configured key → expect 400 with missing secrets list
9. Start a run with key → verify agent container gets the env var (check scheduler logs)
10. Run tests (из `web/`): `npx vitest run "src/lib/__tests__/encryption" "src/lib/agents/__tests__/secrets" "src/app/api/agents/[id]/auth/__tests__/auth"`

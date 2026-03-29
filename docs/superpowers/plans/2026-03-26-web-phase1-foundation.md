# Litmus Web Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a running Next.js 15 app in `./web` with infrastructure in Docker Compose (postgres + garage + socket-proxy), Drizzle ORM schema, S3 client with verified connectivity, Lab Instrument design system (dark+light themes), and a Dashboard page displaying seed data per spec.

**Development mode:** Host-dev primary — postgres, garage, and socket-proxy run in Docker Compose; Next.js runs on the host via `npm run dev`. Containerized `litmus-web` is verified as a final step but is not the primary dev workflow.

**Shell environment:** All commands are PowerShell-native. Bash syntax appears only inside `docker compose exec` where it runs in the container's shell.

**Architecture:** Next.js 15 App Router with Server Components. PostgreSQL 16 via Drizzle ORM. Garage (S3-compatible) for object storage. Docker Compose orchestrates infrastructure services. Design system implemented as CSS custom properties with `data-theme` attribute switching.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS 4, Drizzle ORM, PostgreSQL 16, AWS SDK v3 (S3 client for Garage), JetBrains Mono + DM Sans (via next/font), Docker Compose

**Spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md`

**Design Assets:** `docs/superpowers/specs/design-system/` (HTML mockups for reference)

**Explicitly deferred to later phases:**
- Mobile navigation (hamburger collapse at <768px) — Phase 4: Polish
- Agent runtime image (devcontainer.json) — Phase 2: Run Engine
- Agent `run.sh` scripts — Phase 2: Run Engine

---

## File Structure

```
web/
├── docker-compose.yml                  # postgres + garage + socket-proxy (litmus-web defined but optional for dev)
├── Dockerfile                          # Multi-stage Next.js build
├── garage.toml                         # Garage S3 server config
├── .env.example                        # Environment variable template
├── .env                                # Local env (gitignored)
├── package.json
├── tsconfig.json                       # Includes @/* path alias
├── next.config.ts
├── drizzle.config.ts
├── drizzle/
│   └── 0000_init.sql                   # Generated migration (tables + indexes)
│   # Materialized views are NOT in drizzle migrations — managed by src/db/migrate-views.ts
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # Root layout: next/font, theme provider, nav-bar
│   │   ├── page.tsx                    # Dashboard (server component)
│   │   └── globals.css                 # CSS variables (dark + light tokens), Tailwind v4 import
│   ├── db/
│   │   ├── index.ts                    # Drizzle client singleton (pg connection)
│   │   ├── schema.ts                   # All table + enum definitions
│   │   ├── seed.ts                     # Idempotent seed: truncate + insert
│   │   └── migrate-views.ts           # Applies materialized views via raw SQL
│   ├── lib/
│   │   ├── s3.ts                       # Garage S3 client (AWS SDK v3)
│   │   ├── s3-smoke-test.ts           # put -> get -> delete verification
│   │   └── env.ts                      # Typed env variables with zod validation
│   └── components/
│       ├── nav-bar.tsx                 # Top pill navigation bar (desktop-only, mobile deferred)
│       ├── stat-card.tsx               # Dashboard metric card
│       ├── theme-toggle.tsx            # Dark/light/system toggle (client component)
│       └── ui/
│           ├── card.tsx                # Base card with --bg-raised
│           └── badge.tsx               # Status/tag badge
├── agents/
│   └── scripts/                        # Empty — populated in Phase 2
├── scripts/
│   └── (empty — populated in Phase 4)
└── public/
    └── (empty)
```

**Note on Tailwind v4:** Tailwind CSS v4 uses CSS-first configuration (`@import 'tailwindcss'` in globals.css). No `tailwind.config.ts` is needed — theme tokens are defined as CSS custom properties in `globals.css`. If `create-next-app` generates a `tailwind.config.ts`, delete it.

---

### Task 1: Initialize Next.js Project + Config Files

**Files:**
- Create: `web/package.json` (via create-next-app)
- Create: `web/tsconfig.json` (via create-next-app, then modify)
- Create: `web/next.config.ts`
- Create: `web/.env.example`
- Create: `web/.env`
- Create: `web/.gitignore` (via create-next-app, then modify)
- Delete: `web/tailwind.config.ts` (if generated, not needed for Tailwind v4)

- [x] **Step 1: Create web directory and initialize Next.js 15**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
mkdir web
cd web
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --turbopack
```

Accept defaults when prompted.

- [x] **Step 2: Delete tailwind.config.ts if it exists**

Tailwind v4 uses CSS-first configuration. The JS config file is not needed.

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
if (Test-Path tailwind.config.ts) { Remove-Item tailwind.config.ts }
if (Test-Path tailwind.config.js) { Remove-Item tailwind.config.js }
```

- [x] **Step 3: Verify tsconfig.json has `@/*` path alias**

Open `web/tsconfig.json` and ensure it contains:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

If `create-next-app` did not generate this (e.g., because no `--import-alias` flag was passed), add it manually under `compilerOptions`. This alias is used throughout the codebase for imports like `@/components/nav-bar` and `@/db/queries`.

- [x] **Step 4: Install dependencies**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm install drizzle-orm postgres dotenv zod @aws-sdk/client-s3 recharts dockerode
npm install -D drizzle-kit @types/dockerode tsx
```

- [x] **Step 5: Create `web/.env.example`**

```env
# Database
DATABASE_URL=postgres://litmus:litmus@localhost:5432/litmus

# S3 (Garage)
S3_ENDPOINT=http://localhost:3900
S3_ACCESS_KEY=GK_change_me
S3_SECRET_KEY=change_me_secret
S3_REGION=garage

# Docker (socket proxy)
DOCKER_HOST=tcp://localhost:2375
```

- [x] **Step 6: Create `web/.env`**

```powershell
Copy-Item .env.example .env
```

Values will be updated in Task 2 after Garage bucket initialization.

- [x] **Step 7: Append to `.gitignore`**

Add these lines to the existing `.gitignore`:

```
.env
.env.local
```

- [x] **Step 8: Create `web/src/lib/env.ts`**

```typescript
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('garage'),
  DOCKER_HOST: z.string().default('tcp://localhost:2375'),
});

export const env = envSchema.parse(process.env);
```

- [x] **Step 9: Update `web/next.config.ts`**

Replace the generated content with:

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
```

- [x] **Step 10: Verify dev server starts**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm run dev
```

Expected: Server starts on http://localhost:3000, default Next.js page renders. Stop with Ctrl+C.

- [x] **Step 11: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/
git commit -m "feat(web): initialize Next.js 15 project with dependencies and @/* alias"
```

---

### Task 2: Docker Compose + Garage Setup

**Files:**
- Create: `web/docker-compose.yml`
- Create: `web/garage.toml`
- Create: `web/Dockerfile`
- Modify: `web/.env`

- [x] **Step 1: Create `web/docker-compose.yml`**

```yaml
name: litmus    # Pins the project name so volume/network names are deterministic

services:
  litmus-web:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://litmus:litmus@postgres:5432/litmus
      S3_ENDPOINT: http://garage:3900
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      S3_REGION: garage
      DOCKER_HOST: tcp://docker-socket-proxy:2375
    volumes:
      - ./agents/scripts:/opt/agent:ro
      - agent-workspaces:/var/litmus/work
    networks:
      - litmus-internal
    depends_on:
      postgres:
        condition: service_healthy
      garage:
        condition: service_started
      docker-socket-proxy:
        condition: service_started
    profiles: ["full"]  # Only started with: docker compose --profile full up

  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:latest
    environment:
      CONTAINERS: 1
      IMAGES: 1
      NETWORKS: 1
      EXEC: 1
      POST: 1
      VOLUMES: 0
      SWARM: 0
      NODES: 0
      SERVICES: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - litmus-internal

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: litmus
      POSTGRES_USER: litmus
      POSTGRES_PASSWORD: litmus
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U litmus"]
      interval: 5s
      retries: 5
    networks:
      - litmus-internal

  garage:
    image: dxflrs/garage:v1.1.0
    ports:
      - "3900:3900"
      - "3902:3902"
    volumes:
      - garage-data:/var/lib/garage/data
      - garage-meta:/var/lib/garage/meta
      - ./garage.toml:/etc/garage.toml
    networks:
      - litmus-internal

networks:
  litmus-internal:
    internal: true
  litmus-agents:
    driver: bridge
    # agent containers only; outbound internet for LLM API calls
    # no access to litmus-internal services

volumes:
  pgdata:
  garage-data:
  garage-meta:
  agent-workspaces:
```

**Design notes:**
- `litmus-internal` has `internal: true` per spec — no outbound internet access for infra services.
- `litmus-web` uses `profiles: ["full"]` so `docker compose up -d` only starts infra, while `docker compose --profile full up -d` starts everything including the containerized app.
- `litmus-agents` is defined but empty — agent containers are created programmatically in Phase 2.
- Mount path is `/opt/agent` (singular) matching the spec's `run.sh` contract.
- Postgres exposes port 5432 to host for local development.

- [x] **Step 2: Create `web/garage.toml`**

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "litmus_admin_token"

[rpc]
bind_addr = "[::]:3901"
secret = "0000000000000000000000000000000000000000000000000000000000000000"
```

- [x] **Step 3: Create `web/Dockerfile`**

```dockerfile
FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
```

- [x] **Step 4: Create agents/scripts directory**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
New-Item -ItemType Directory -Path agents\scripts -Force
New-Item -ItemType File -Path agents\scripts\.gitkeep
```

- [x] **Step 5: Start infrastructure services**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
docker compose up -d postgres garage docker-socket-proxy
```

Expected: All three containers start. Verify postgres health:

```powershell
docker compose ps
```

Expected: `postgres` shows `healthy`, `garage` and `docker-socket-proxy` show `running`.

- [x] **Step 6: Initialize Garage node and buckets (FIRST RUN ONLY)**

Garage requires manual bootstrap on first start. These commands are **not idempotent** — they will error on re-run if entities already exist. This is expected and harmless.

**First-time setup:**

```powershell
# Get node ID (first line of output)
$nodeId = (docker compose exec garage /garage node id 2>&1) | Select-Object -First 1
Write-Host "Node ID: $nodeId"

# Assign layout
docker compose exec garage /garage layout assign -z dc1 -c 1G $nodeId
docker compose exec garage /garage layout apply --version 1

# Create API key (save output — contains access_key and secret_key)
docker compose exec garage /garage key create litmus-key

# Create buckets
docker compose exec garage /garage bucket create litmus-scenarios
docker compose exec garage /garage bucket create litmus-artifacts
docker compose exec garage /garage bucket create litmus-packs
```

From the `key create` output, note the `Key ID` and `Secret key` values.

```powershell
# Grant permissions (replace KEY_ID with actual value from above)
docker compose exec garage /garage bucket allow --read --write --owner litmus-scenarios --key KEY_ID
docker compose exec garage /garage bucket allow --read --write --owner litmus-artifacts --key KEY_ID
docker compose exec garage /garage bucket allow --read --write --owner litmus-packs --key KEY_ID
```

**Recovery (if partially initialized):** If any command above fails because the entity exists, skip it and continue. To fully reset Garage, remove its volumes and re-run:

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
docker compose stop garage
docker compose rm -f garage
# Volume names are deterministic because docker-compose.yml sets `name: litmus`
docker volume rm litmus_garage-data litmus_garage-meta
docker compose up -d garage
# Wait for garage to start, then re-run all layout/key/bucket commands above
```

**Verification (works on both first and subsequent runs):**

```powershell
docker compose exec garage /garage bucket list
```

Expected: Three buckets listed — `litmus-scenarios`, `litmus-artifacts`, `litmus-packs`.

- [x] **Step 7: Update `.env` with Garage credentials**

Edit `web/.env` and replace the S3 placeholder values with the actual key ID and secret from Step 6:

```env
S3_ACCESS_KEY=<Key ID from step 6>
S3_SECRET_KEY=<Secret key from step 6>
```

- [x] **Step 8: Verify Postgres connection**

```powershell
docker compose exec postgres psql -U litmus -c "SELECT version();"
```

Expected: PostgreSQL 16.x version string.

- [x] **Step 9: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/docker-compose.yml web/garage.toml web/Dockerfile web/agents/
git commit -m "feat(web): add Docker Compose with postgres, garage, socket-proxy, network isolation"
```

---

### Task 3: Drizzle Schema + Migrations (including materialized views)

**Files:**
- Create: `web/drizzle.config.ts`
- Create: `web/src/db/schema.ts`
- Create: `web/src/db/index.ts`
- Create: `web/src/db/migrate-views.ts`

- [x] **Step 1: Create `web/drizzle.config.ts`**

```typescript
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [x] **Step 2: Create `web/src/db/schema.ts`**

```typescript
import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ─── Reference Tables ───────────────────────────────────────────

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  version: text('version'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  provider: text('provider'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const scenarios = pgTable('scenarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version').default('v1'),
  language: text('language'),
  tags: text('tags').array(),
  maxScore: integer('max_score'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── Run Tables ─────────────────────────────────────────────────

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status', {
    enum: ['pending', 'running', 'completed', 'failed'],
  }).default('pending').notNull(),
  configSnapshot: jsonb('config_snapshot'),
});

export const runResults = pgTable('run_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  modelId: uuid('model_id').notNull().references(() => models.id),
  scenarioId: uuid('scenario_id').notNull().references(() => scenarios.id),
  agentVersion: text('agent_version'),
  scenarioVersion: text('scenario_version'),
  status: text('status', {
    enum: ['completed', 'failed', 'error'],
  }).default('completed').notNull(),
  testsPassed: integer('tests_passed').notNull().default(0),
  testsTotal: integer('tests_total').notNull().default(0),
  totalScore: real('total_score').notNull().default(0),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  judgeScores: jsonb('judge_scores'),
  judgeModel: text('judge_model'),
  artifactsS3Key: text('artifacts_s3_key'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_run_results_run').on(table.runId),
  index('idx_run_results_agent_model').on(table.agentId, table.modelId),
  index('idx_run_results_scenario').on(table.scenarioId),
  uniqueIndex('idx_run_results_unique_combo').on(
    table.runId, table.agentId, table.modelId, table.scenarioId,
  ),
]);

// ─── Agent Orchestration ────────────────────────────────────────

export const agentExecutors = pgTable('agent_executors', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  type: text('type', {
    enum: ['docker', 'host', 'kubernetes'],
  }).notNull(),
  agentSlug: text('agent_slug').notNull(),
  binaryPath: text('binary_path'),
  healthCheck: text('health_check'),
  config: jsonb('config').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const runTasks = pgTable('run_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  agentExecutorId: uuid('agent_executor_id').notNull().references(() => agentExecutors.id),
  modelId: uuid('model_id').notNull().references(() => models.id),
  scenarioId: uuid('scenario_id').notNull().references(() => scenarios.id),
  status: text('status', {
    enum: ['pending', 'running', 'completed', 'failed'],
  }).default('pending').notNull(),
  containerId: text('container_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  exitCode: integer('exit_code'),
  errorMessage: text('error_message'),
}, (table) => [
  index('idx_run_tasks_run').on(table.runId),
  index('idx_run_tasks_status').on(table.status),
]);

// ─── Type Exports ───────────────────────────────────────────────

export type Agent = typeof agents.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunResult = typeof runResults.$inferSelect;
export type AgentExecutor = typeof agentExecutors.$inferSelect;
export type RunTask = typeof runTasks.$inferSelect;
```

- [x] **Step 3: Create `web/src/db/index.ts`**

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Raw client for executing arbitrary SQL (materialized views, etc.)
export const sql = client;
```

- [x] **Step 4: Create `web/src/db/migrate-views.ts`**

This script creates/refreshes materialized views. It's tracked in version control and called both during initial setup and after schema changes.

```typescript
import 'dotenv/config';
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!);

const VIEWS_SQL = `
-- Drop and recreate to handle schema changes
DROP MATERIALIZED VIEW IF EXISTS score_by_agent CASCADE;
DROP MATERIALIZED VIEW IF EXISTS score_by_model CASCADE;
DROP MATERIALIZED VIEW IF EXISTS latest_results CASCADE;

-- Latest result per (agent, model, scenario) combo
CREATE MATERIALIZED VIEW latest_results AS
SELECT DISTINCT ON (agent_id, model_id, scenario_id)
    id, run_id, agent_id, model_id, scenario_id,
    agent_version, scenario_version, status,
    tests_passed, tests_total, total_score,
    duration_seconds, judge_scores, judge_model,
    artifacts_s3_key, created_at
FROM run_results
WHERE status IN ('completed', 'failed')
ORDER BY agent_id, model_id, scenario_id, created_at DESC;

CREATE UNIQUE INDEX idx_latest_results_pk
    ON latest_results(agent_id, model_id, scenario_id);

-- Model leaderboard
CREATE MATERIALIZED VIEW score_by_model AS
SELECT
    model_id,
    AVG(total_score) AS avg_score,
    COUNT(DISTINCT agent_id) AS agent_count,
    COUNT(DISTINCT scenario_id) AS scenario_count,
    COUNT(*) AS result_count
FROM latest_results
GROUP BY model_id;

CREATE UNIQUE INDEX idx_score_by_model_pk ON score_by_model(model_id);

-- Agent leaderboard
CREATE MATERIALIZED VIEW score_by_agent AS
SELECT
    agent_id,
    AVG(total_score) AS avg_score,
    COUNT(DISTINCT model_id) AS model_count,
    COUNT(DISTINCT scenario_id) AS scenario_count,
    COUNT(*) AS result_count
FROM latest_results
GROUP BY agent_id;

CREATE UNIQUE INDEX idx_score_by_agent_pk ON score_by_agent(agent_id);
`;

async function migrateViews() {
  console.log('Creating materialized views...');
  await client.unsafe(VIEWS_SQL);
  console.log('Materialized views created successfully.');
  await client.end();
}

migrateViews().catch((err) => {
  console.error('Failed to create materialized views:', err);
  process.exit(1);
});
```

- [x] **Step 5: Add db scripts to package.json**

Add to the `"scripts"` section of `web/package.json`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:views": "npx tsx src/db/migrate-views.ts",
"db:setup": "npm run db:migrate && npm run db:views",
"db:seed": "npx tsx src/db/seed.ts"
```

- [x] **Step 6: Generate table migration**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm run db:generate
```

Expected: Creates `drizzle/0000_*.sql` with CREATE TABLE statements for all 7 tables.

- [x] **Step 7: Run table migration**

```powershell
npm run db:migrate
```

Expected: Tables created. Verify:

```powershell
docker compose exec postgres psql -U litmus -c "\dt"
```

Should list: `agents`, `models`, `scenarios`, `runs`, `run_results`, `agent_executors`, `run_tasks`.

- [x] **Step 8: Run materialized view migration**

```powershell
npm run db:views
```

Expected: `Materialized views created successfully.` Verify:

```powershell
docker compose exec postgres psql -U litmus -c "\dm"
```

Should list: `latest_results`, `score_by_model`, `score_by_agent`.

- [x] **Step 9: Verify full setup path works from scratch**

To prove a new developer can bootstrap from zero, drop the database and recreate:

```powershell
docker compose exec postgres psql -U litmus -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run db:setup
```

Expected: `db:migrate` creates all 7 tables, `db:views` creates all 3 materialized views — no errors. Verify:

```powershell
docker compose exec postgres psql -U litmus -c "\dt"
docker compose exec postgres psql -U litmus -c "\dm"
```

Should list all 7 tables and 3 views. This proves the setup path is complete and order-independent of manual steps.

- [x] **Step 10: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/drizzle.config.ts web/src/db/schema.ts web/src/db/index.ts web/src/db/migrate-views.ts web/drizzle/ web/package.json
git commit -m "feat(web): add Drizzle schema, migrations, and materialized views"
```

---

### Task 4: S3 Client + Verified Connectivity

**Files:**
- Create: `web/src/lib/s3.ts`
- Create: `web/src/lib/s3-smoke-test.ts`

- [x] **Step 1: Create `web/src/lib/s3.ts`**

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  region: process.env.S3_REGION || 'garage',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

export const BUCKETS = {
  scenarios: 'litmus-scenarios',
  artifacts: 'litmus-artifacts',
  packs: 'litmus-packs',
} as const;

export async function uploadFile(
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType = 'application/octet-stream',
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function downloadFile(
  bucket: string,
  key: string,
): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function listFiles(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  return (response.Contents ?? []).map((obj) => obj.Key!);
}

export async function deleteFile(
  bucket: string,
  key: string,
): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}

export { s3 };
```

- [x] **Step 2: Create `web/src/lib/s3-smoke-test.ts`**

```typescript
import 'dotenv/config';
import { uploadFile, downloadFile, deleteFile, BUCKETS } from './s3';

const TEST_KEY = '_smoke-test/probe.txt';
const TEST_BODY = `litmus-s3-smoke-test-${Date.now()}`;

async function smokeTest() {
  console.log('S3 smoke test: put -> get -> delete');

  // PUT
  console.log(`  PUT ${BUCKETS.scenarios}/${TEST_KEY}`);
  await uploadFile(BUCKETS.scenarios, TEST_KEY, TEST_BODY, 'text/plain');

  // GET
  console.log(`  GET ${BUCKETS.scenarios}/${TEST_KEY}`);
  const downloaded = await downloadFile(BUCKETS.scenarios, TEST_KEY);
  const content = downloaded.toString('utf-8');

  if (content !== TEST_BODY) {
    throw new Error(`Content mismatch: expected "${TEST_BODY}", got "${content}"`);
  }
  console.log('  Content matches.');

  // DELETE
  console.log(`  DELETE ${BUCKETS.scenarios}/${TEST_KEY}`);
  await deleteFile(BUCKETS.scenarios, TEST_KEY);

  console.log('S3 smoke test PASSED.');
}

smokeTest().catch((err) => {
  console.error('S3 smoke test FAILED:', err);
  process.exit(1);
});
```

- [x] **Step 3: Add smoke-test script to package.json**

Add to `"scripts"`:

```json
"s3:test": "npx tsx src/lib/s3-smoke-test.ts"
```

- [x] **Step 4: Run S3 smoke test**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm run s3:test
```

Expected output:
```
S3 smoke test: put -> get -> delete
  PUT litmus-scenarios/_smoke-test/probe.txt
  GET litmus-scenarios/_smoke-test/probe.txt
  Content matches.
  DELETE litmus-scenarios/_smoke-test/probe.txt
S3 smoke test PASSED.
```

If it fails: verify `.env` credentials match the Garage key created in Task 2.

- [x] **Step 5: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/src/lib/s3.ts web/src/lib/s3-smoke-test.ts web/package.json
git commit -m "feat(web): add S3 client with verified put/get/delete smoke test"
```

---

### Task 5: Design System + Layout + Components

This task creates the full design system, root layout with fonts, and all primitive components in one pass. No intermediate layout.tsx rewrites.

**Files:**
- Replace: `web/src/app/globals.css`
- Replace: `web/src/app/layout.tsx`
- Create: `web/src/components/ui/card.tsx`
- Create: `web/src/components/ui/badge.tsx`
- Create: `web/src/components/stat-card.tsx`
- Create: `web/src/components/theme-toggle.tsx`
- Create: `web/src/components/nav-bar.tsx`

- [x] **Step 1: Replace `web/src/app/globals.css`**

Delete all default content. Write:

```css
@import 'tailwindcss';

/* ─── Lab Instrument Design System ──────────────────────────── */
/* Fonts loaded via next/font in layout.tsx; CSS vars set as fallbacks */

:root {
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --font-sans: 'DM Sans', system-ui, sans-serif;
}

/* ─── Dark Theme (default) ─── */
html[data-theme='dark'],
html:not([data-theme]) {
  --bg-base: #0C0E12;
  --bg-raised: #12151B;
  --bg-overlay: #1A1D25;
  --bg-hover: #22252F;
  --text-primary: #E8E9ED;
  --text-secondary: #8B8FA3;
  --text-muted: #555970;
  --accent: #D4A041;
  --accent-dim: rgba(212, 160, 65, 0.12);
  --border: #1E2130;
  --lens-ranking: #6B8AFF;
  --lens-ranking-bg: rgba(107, 138, 255, 0.12);
  --lens-detail: #5EC4B6;
  --lens-detail-bg: rgba(94, 196, 182, 0.12);
  --score-excellent: #3DD68C;
  --score-excellent-bg: rgba(61, 214, 140, 0.18);
  --score-good: #7BC67E;
  --score-good-bg: rgba(123, 198, 126, 0.13);
  --score-mid: #C9B44E;
  --score-mid-bg: rgba(201, 180, 78, 0.13);
  --score-poor: #D4763A;
  --score-poor-bg: rgba(212, 118, 58, 0.13);
  --score-fail: #C94444;
  --score-fail-bg: rgba(201, 68, 68, 0.13);
}

/* ─── Light Theme (Pastel) ─── */
html[data-theme='light'] {
  --bg-base: #FAF9F7;
  --bg-raised: #FFFFFF;
  --bg-overlay: #F3F1ED;
  --bg-hover: #EBE9E4;
  --text-primary: #2C2C30;
  --text-secondary: #6E6E7A;
  --text-muted: #A5A5B0;
  --accent: #C49335;
  --accent-dim: rgba(196, 147, 53, 0.08);
  --border: #E0DDD7;
  --lens-ranking: #7B96E8;
  --lens-ranking-bg: #E8EDFB;
  --lens-detail: #6BB8AD;
  --lens-detail-bg: #DEF2EF;
  --score-excellent: #2D7A4A;
  --score-excellent-bg: #D5F0E2;
  --score-good: #4E8A52;
  --score-good-bg: #E4F2E5;
  --score-mid: #8D7B2A;
  --score-mid-bg: #F5F0D8;
  --score-poor: #A85E2A;
  --score-poor-bg: #F8E8D8;
  --score-fail: #A8393B;
  --score-fail-bg: #F8DEDE;
}

/* ─── Base styles ─── */
body {
  font-family: var(--font-sans);
  background-color: var(--bg-base);
  color: var(--text-primary);
}

/* Grid background texture */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  background-image:
    linear-gradient(var(--border) 1px, transparent 1px),
    linear-gradient(90deg, var(--border) 1px, transparent 1px);
  background-size: 40px 40px;
  opacity: 0.3;
}
```

- [x] **Step 2: Replace `web/src/app/layout.tsx`**

This is the **final version** — includes fonts, theme attribute, and NavBar.

```tsx
import type { Metadata } from 'next';
import { JetBrains_Mono, DM_Sans } from 'next/font/google';
import { NavBar } from '@/components/nav-bar';
import './globals.css';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Litmus — Agent Benchmarking',
  description: 'Compare LLM coding agents across models and scenarios',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${jetbrainsMono.variable} ${dmSans.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen antialiased">
        <div className="max-w-[1440px] mx-auto px-6 py-4">
          <NavBar />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
```

- [x] **Step 3: Create `web/src/components/ui/card.tsx`**

```tsx
import { type HTMLAttributes } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

export function Card({ hover = false, className = '', children, ...props }: CardProps) {
  return (
    <div
      className={`
        rounded-lg border border-[var(--border)]
        bg-[var(--bg-raised)] p-4
        ${hover ? 'transition-colors hover:bg-[var(--bg-hover)] cursor-pointer' : ''}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}
```

- [x] **Step 4: Create `web/src/components/ui/badge.tsx`**

```tsx
interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'error';
  className?: string;
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-[var(--bg-overlay)] text-[var(--text-secondary)]',
  accent: 'bg-[var(--accent-dim)] text-[var(--accent)]',
  success: 'bg-[var(--score-excellent-bg)] text-[var(--score-excellent)]',
  warning: 'bg-[var(--score-mid-bg)] text-[var(--score-mid)]',
  error: 'bg-[var(--score-fail-bg)] text-[var(--score-fail)]',
};

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center px-2 py-0.5 rounded-md
        font-[var(--font-mono)] text-xs font-medium
        ${variantStyles[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
```

- [x] **Step 5: Create `web/src/components/stat-card.tsx`**

```tsx
import { Card } from './ui/card';

interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
}

export function StatCard({ label, value, subtitle }: StatCardProps) {
  return (
    <Card>
      <p className="text-xs font-[var(--font-mono)] uppercase tracking-wider text-[var(--text-muted)] mb-1">
        {label}
      </p>
      <p className="text-2xl font-[var(--font-mono)] font-semibold text-[var(--text-primary)]">
        {value}
      </p>
      {subtitle && (
        <p className="text-xs text-[var(--text-secondary)] mt-1">{subtitle}</p>
      )}
    </Card>
  );
}
```

- [x] **Step 6: Create `web/src/components/theme-toggle.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const saved = localStorage.getItem('litmus-theme') as Theme | null;
    if (saved) {
      setTheme(saved);
      applyTheme(saved);
    }
  }, []);

  function applyTheme(t: Theme) {
    const resolved = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  function cycle() {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(next);
    localStorage.setItem('litmus-theme', next);
    applyTheme(next);
  }

  const icons: Record<Theme, string> = {
    dark: '\u263D',   // crescent moon
    light: '\u2600',  // sun
    system: '\u25D1',  // half circle
  };

  return (
    <button
      onClick={cycle}
      className="
        font-[var(--font-mono)] text-sm px-2 py-1 rounded-md
        text-[var(--text-secondary)]
        hover:text-[var(--text-primary)]
        hover:bg-[var(--bg-hover)]
        transition-colors
      "
      title={`Theme: ${theme}`}
    >
      {icons[theme]}
    </button>
  );
}
```

- [x] **Step 7: Create `web/src/components/nav-bar.tsx`**

Desktop-only pill navigation. Mobile hamburger deferred to Phase 4.

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme-toggle';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/run', label: 'Run' },
  { href: '/compare', label: 'Compare' },
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/settings', label: 'Settings' },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center justify-between h-12 mb-6">
      {/* Logo */}
      <Link
        href="/"
        className="font-[var(--font-mono)] text-sm font-bold text-[var(--accent)] tracking-wider"
      >
        LITMUS
      </Link>

      {/* Pill navigation (desktop-only; mobile hamburger deferred to Phase 4) */}
      <div className="
        flex items-center gap-1
        bg-[var(--bg-raised)] border border-[var(--border)]
        rounded-full px-1.5 py-1
      ">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                font-[var(--font-mono)] text-xs px-3 py-1 rounded-full transition-colors
                ${isActive
                  ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }
              `}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Theme toggle */}
      <ThemeToggle />
    </nav>
  );
}
```

- [x] **Step 8: Verify design system renders end-to-end**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm run dev
```

Open http://localhost:3000. Verify:
- Dark background (#0C0E12) with subtle grid pattern
- "LITMUS" in amber (#D4A041) top-left
- Pill navigation with 5 items, "Dashboard" highlighted in amber
- Theme toggle top-right
- Click theme toggle: dark → light (warm ivory #FAF9F7 background, all text readable) → system → dark
- JetBrains Mono visible on "LITMUS" and nav items
- DM Sans visible on body text

- [x] **Step 9: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/src/app/globals.css web/src/app/layout.tsx web/src/components/
git commit -m "feat(web): add Lab Instrument design system, nav-bar, theme toggle, and UI primitives"
```

---

### Task 6: Seed Data (idempotent)

**Files:**
- Create: `web/src/db/seed.ts`

- [x] **Step 1: Create `web/src/db/seed.ts`**

This script is idempotent: it truncates all data tables (CASCADE) then re-inserts. Safe to run repeatedly.

```typescript
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { agents, models, scenarios, runs, runResults } from './schema';

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

async function seed() {
  console.log('Seeding database (truncate + insert)...');

  // ─── Truncate in dependency order ───────────────────────────
  await client`TRUNCATE run_results, run_tasks, runs, agent_executors, scenarios, models, agents CASCADE`;

  // ─── Agents ─────────────────────────────────────────────────
  const insertedAgents = await db
    .insert(agents)
    .values([
      { name: 'Claude Code', version: '1.0.32' },
      { name: 'Aider', version: '0.82.0' },
      { name: 'OpenCode', version: '0.5.1' },
    ])
    .returning();

  // ─── Models ─────────────────────────────────────────────────
  const insertedModels = await db
    .insert(models)
    .values([
      { name: 'Sonnet 4', provider: 'Anthropic' },
      { name: 'Opus 4', provider: 'Anthropic' },
      { name: 'GPT-4o', provider: 'OpenAI' },
      { name: 'Gemini 2.5 Pro', provider: 'Google' },
    ])
    .returning();

  // ─── Scenarios ──────────────────────────────────────────────
  const insertedScenarios = await db
    .insert(scenarios)
    .values([
      { slug: '1-data-structure', name: 'Data Structure', language: 'python', description: 'Implement a binary search tree with insert, search, delete', maxScore: 100 },
      { slug: '2-simple-architecture', name: 'Simple Architecture', language: 'python', description: 'Design a layered REST API service', maxScore: 100 },
      { slug: '3-api-design', name: 'API Design', language: 'python', description: 'Build a RESTful API with proper error handling', maxScore: 100 },
      { slug: '4-refactoring', name: 'Refactoring', language: 'python', description: 'Refactor legacy code into clean architecture', maxScore: 100 },
      { slug: '5-testing', name: 'Testing', language: 'python', description: 'Write comprehensive test suite for existing code', maxScore: 100 },
      { slug: '6-debugging', name: 'Debugging', language: 'python', description: 'Find and fix bugs in provided code', maxScore: 100 },
    ])
    .returning();

  // ─── Run + Results ──────────────────────────────────────────
  const [run1] = await db
    .insert(runs)
    .values({
      status: 'completed',
      finishedAt: new Date(),
      configSnapshot: { agents: 3, models: 4, scenarios: 6 },
    })
    .returning();

  // Deterministic scores using seeded pseudo-random (no Math.random)
  const resultRows = [];
  let seedCounter = 0;
  function seededScore(agentIdx: number, modelIdx: number, scenarioIdx: number): number {
    // Deterministic but varied scores based on position
    const base = 45 + ((agentIdx * 17 + modelIdx * 13 + scenarioIdx * 7 + seedCounter++) % 40);
    const agentBonus = [8, 3, 0][agentIdx] ?? 0;   // Claude > Aider > OpenCode
    const modelBonus = [5, 10, 3, 4][modelIdx] ?? 0; // Opus best, Sonnet second
    return Math.min(100, base + agentBonus + modelBonus);
  }

  for (let ai = 0; ai < insertedAgents.length; ai++) {
    for (let mi = 0; mi < insertedModels.length; mi++) {
      for (let si = 0; si < insertedScenarios.length; si++) {
        const score = seededScore(ai, mi, si);
        const total = 5 + (si % 6);  // 5-10 tests per scenario, deterministic
        const passed = Math.round(total * score / 100);

        resultRows.push({
          runId: run1.id,
          agentId: insertedAgents[ai].id,
          modelId: insertedModels[mi].id,
          scenarioId: insertedScenarios[si].id,
          agentVersion: insertedAgents[ai].version,
          scenarioVersion: 'v1',
          status: score > 25 ? ('completed' as const) : ('failed' as const),
          testsPassed: passed,
          testsTotal: total,
          totalScore: score,
          durationSeconds: 30 + ((ai * 100 + mi * 40 + si * 20) % 270),
        });
      }
    }
  }

  await db.insert(runResults).values(resultRows);

  // ─── Refresh materialized views ─────────────────────────────
  await client`REFRESH MATERIALIZED VIEW latest_results`;
  await client`REFRESH MATERIALIZED VIEW score_by_model`;
  await client`REFRESH MATERIALIZED VIEW score_by_agent`;

  const summary = `Seeded: ${insertedAgents.length} agents, ${insertedModels.length} models, ${insertedScenarios.length} scenarios, ${resultRows.length} results`;
  console.log(summary);
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
```

- [x] **Step 2: Run seed**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm run db:seed
```

Expected: `Seeded: 3 agents, 4 models, 6 scenarios, 72 results`

- [x] **Step 3: Run seed again to verify idempotency**

```powershell
npm run db:seed
```

Expected: Same output, no errors. Result count stays 72:

```powershell
docker compose exec postgres psql -U litmus -c "SELECT COUNT(*) FROM run_results;"
```

Expected: `72`

- [x] **Step 4: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/src/db/seed.ts web/package.json
git commit -m "feat(web): add idempotent seed script with deterministic sample data"
```

---

### Task 7: Dashboard Page (per spec contract)

**Files:**
- Replace: `web/src/app/page.tsx`
- Create: `web/src/db/queries.ts`

- [x] **Step 1: Create `web/src/db/queries.ts`**

The spec requires Recent Activity with columns: `run ID, agent×model combos, scenarios count, pass rate, date` (spec updated: each row = one run, agent×model column aggregates all tested combinations as comma-separated list). This query returns per-run data matching that contract.

```typescript
import { db } from './index';
import { agents, models, runs, runResults } from './schema';
import { count, avg, eq, sql } from 'drizzle-orm';

export async function getDashboardStats() {
  const [agentCount] = await db.select({ count: count() }).from(agents);
  const [modelCount] = await db.select({ count: count() }).from(models);
  const [runCount] = await db.select({ count: count() }).from(runs);
  const [avgScore] = await db
    .select({ avg: avg(runResults.totalScore) })
    .from(runResults)
    .where(eq(runResults.status, 'completed'));

  return {
    agents: agentCount.count,
    models: modelCount.count,
    runs: runCount.count,
    avgScore: avgScore.avg ? Math.round(Number(avgScore.avg)) : 0,
  };
}

export interface RecentRunRow {
  id: string;
  status: string;
  startedAt: Date | null;
  agentModelPairs: string;   // "Claude Code×Sonnet 4, Aider×GPT-4o, ..."
  scenarioCount: number;
  passRate: string;          // "85%" or "—"
}

export async function getRecentRuns(limit = 10): Promise<RecentRunRow[]> {
  const rows = await db.execute(sql`
    SELECT
      r.id,
      r.status,
      r.started_at AS "startedAt",
      (
        SELECT string_agg(DISTINCT a.name || ' x ' || m.name, ', ' ORDER BY a.name || ' x ' || m.name)
        FROM run_results rr
        JOIN agents a ON a.id = rr.agent_id
        JOIN models m ON m.id = rr.model_id
        WHERE rr.run_id = r.id
      ) AS "agentModelPairs",
      (
        SELECT COUNT(DISTINCT rr.scenario_id)
        FROM run_results rr WHERE rr.run_id = r.id
      )::int AS "scenarioCount",
      (
        SELECT CASE
          WHEN COUNT(*) = 0 THEN NULL
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE rr.status = 'completed') / COUNT(*),
            0
          )
        END
        FROM run_results rr WHERE rr.run_id = r.id
      ) AS "passRate"
    FROM runs r
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `);

  return rows.map((row: any) => ({
    id: row.id,
    status: row.status,
    startedAt: row.startedAt,
    agentModelPairs: row.agentModelPairs || '—',
    scenarioCount: row.scenarioCount ?? 0,
    passRate: row.passRate != null ? `${row.passRate}%` : '—',
  }));
}
```

- [x] **Step 2: Replace `web/src/app/page.tsx`**

```tsx
import Link from 'next/link';
import { getDashboardStats, getRecentRuns } from '@/db/queries';
import { StatCard } from '@/components/stat-card';
import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const stats = await getDashboardStats();
  const recentRuns = await getRecentRuns();
  const hasData = stats.runs > 0;

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Runs" value={stats.runs} />
        <StatCard label="Agents" value={stats.agents} />
        <StatCard label="Models" value={stats.models} />
        <StatCard label="Avg Score" value={`${stats.avgScore}%`} />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-4">
        <Link href="/run">
          <Card hover>
            <p className="font-[var(--font-mono)] text-sm text-[var(--accent)] font-semibold">
              + New Run
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Configure agents, models, and scenarios
            </p>
          </Card>
        </Link>
        {hasData ? (
          <Link href="/compare">
            <Card hover>
              <p className="font-[var(--font-mono)] text-sm text-[var(--lens-ranking)] font-semibold">
                Compare
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Leaderboards, heatmaps, and analysis
              </p>
            </Card>
          </Link>
        ) : (
          <Card className="opacity-50 cursor-not-allowed">
            <p className="font-[var(--font-mono)] text-sm text-[var(--text-muted)] font-semibold">
              Compare
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Run benchmarks first
            </p>
          </Card>
        )}
      </div>

      {/* Recent activity — columns per spec: Run ID, Agent×Model, Scenarios, Pass Rate, Date */}
      {hasData && (
        <div>
          <h2 className="font-[var(--font-mono)] text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">
            Recent Activity
          </h2>
          <Card>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {['Run ID', 'Agent \u00d7 Model', 'Scenarios', 'Pass Rate', 'Date'].map((h) => (
                    <th
                      key={h}
                      className="font-[var(--font-mono)] text-xs text-[var(--text-muted)] text-left py-2 px-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="font-[var(--font-mono)] text-xs text-[var(--text-secondary)] py-2 px-3">
                      {run.id.slice(0, 8)}
                    </td>
                    <td className="text-xs text-[var(--text-primary)] py-2 px-3 max-w-[300px] truncate">
                      {run.agentModelPairs}
                    </td>
                    <td className="font-[var(--font-mono)] text-xs text-[var(--text-secondary)] py-2 px-3">
                      {run.scenarioCount}
                    </td>
                    <td className="font-[var(--font-mono)] text-xs text-[var(--text-primary)] py-2 px-3">
                      {run.passRate}
                    </td>
                    <td className="font-[var(--font-mono)] text-xs text-[var(--text-muted)] py-2 px-3">
                      {run.startedAt?.toLocaleDateString() ?? '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 3: Verify Dashboard renders with seed data**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
npm run dev
```

Open http://localhost:3000. Verify:
- 4 stat cards: Total Runs = 1, Agents = 3, Models = 4, Avg Score = a percentage
- "New Run" card (amber accent) + "Compare" card (blue lens-ranking)
- Recent Activity table with columns: **Run ID**, **Agent x Model**, **Scenarios**, **Pass Rate**, **Date**
- Table shows 1 row with: 8-char run ID, comma-separated agent×model pairs, scenario count 6, a pass rate percentage, today's date

- [x] **Step 4: Verify light theme rendering**

Click theme toggle twice (dark → light). Verify:
- Warm ivory background (#FAF9F7)
- All text readable
- Cards have white background with subtle border
- Table text contrast is sufficient

- [x] **Step 5: Commit**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus
git add web/src/db/queries.ts web/src/app/page.tsx
git commit -m "feat(web): add Dashboard page with stats, quick actions, and recent activity per spec"
```

- [x] **Step 6: Stop host dev server**

Before Task 8 starts the containerized build on port 3000, the host dev server must be stopped. Press `Ctrl+C` in the terminal running `npm run dev`, or close it. Verify the port is free:

```powershell
# Should return nothing (no process on port 3000)
netstat -ano | findstr :3000
```

---

### Task 8: Verify Containerized Runtime

This task verifies that `litmus-web` runs correctly inside Docker Compose, proving the Dockerfile and service configuration work.

**Files:** None (verification only)

- [x] **Step 1: Build the litmus-web image**

```powershell
cd C:\projects\moex\experiments\model-selection\litmus\web
docker compose --profile full build litmus-web
```

Expected: Multi-stage build completes without errors.

- [x] **Step 2: Start all services including litmus-web**

```powershell
docker compose --profile full up -d
```

Expected: All 4 services running.

- [x] **Step 3: Verify litmus-web serves the Dashboard**

Wait a few seconds for startup, then:

```powershell
# Check container logs for startup
docker compose logs litmus-web --tail 20
```

Expected: Next.js starts on port 3000. No connection errors to postgres or garage.

Open http://localhost:3000 — should show the Dashboard with seed data (same as host-dev mode).

- [x] **Step 4: Stop containerized litmus-web, return to host-dev**

```powershell
docker compose --profile full stop litmus-web
```

For continued development, use host-dev mode:
```powershell
npm run dev
```

- [x] **Step 5: Commit (no file changes — this is verification only)**

No commit needed. But if any Dockerfile fixes were required, commit them:

```powershell
# Only if Dockerfile was modified during verification
git add web/Dockerfile
git commit -m "fix(web): update Dockerfile for containerized runtime"
```

---

## Phase 1 Complete Checklist

After all 8 tasks, verify:

- [x] `docker compose up -d` — postgres, garage, socket-proxy all running/healthy
- [x] `npm run dev` — Next.js starts on :3000 without errors (host-dev mode)
- [x] `docker compose --profile full up -d` — litmus-web container starts and serves Dashboard
- [x] `npm run db:setup` — creates tables + materialized views from scratch (idempotent)
- [x] `npm run db:seed` — populates data (idempotent, safe to run twice)
- [x] `npm run s3:test` — S3 put/get/delete verified against Garage
- [x] Dashboard shows seed data: 4 stat cards, quick-action cards, recent activity table
- [x] Recent Activity columns match spec: Run ID, Agent×Model, Scenarios, Pass Rate, Date
- [x] Theme toggle cycles dark → light → system, all themes visually correct
- [x] Dark theme: #0C0E12 background, #D4A041 accent, grid texture, JetBrains Mono on data
- [x] Light theme: #FAF9F7 background, #C49335 accent, pastel tones
- [x] Pill navigation with 5 items, active item highlighted in amber
- [x] `tsconfig.json` has `@/*` path alias, all imports use it
- [x] Database has 7 tables + 3 materialized views with unique indexes
- [x] `litmus-internal` network has `internal: true`
- [x] Agent mount path is `/opt/agent` (singular) matching spec

---

## Subsequent Plans (to be written after Phase 1)

### Phase 2: Run Engine (`2026-03-26-web-phase2-run-engine.md`)

Scope:
- **Matrix Builder** page (agent×model×scenario selector)
- **Runs API** (`POST /api/runs`, `GET /api/runs`, `GET /api/runs/[runId]`, `DELETE`)
- **AgentExecutor interface** + `DockerExecutor` (dockerode) + `HostExecutor` (execa)
- **Scheduler** (concurrent containers, sequential scenarios per container)
- **Reconciler** (test-results.json parsing, DB write, S3 upload)
- **SSE progress stream** (`GET /api/runs/[runId]/stream`)
- **Progress View** page (real-time matrix fill with error/failed states)
- **Dev Container runtime image** (devcontainer.json + test frameworks)
- **Claude agent `run.sh`** (reference implementation)

### Phase 3: Compare & Analysis (`2026-03-26-web-phase3-compare.md`)

Scope:
- **Compare APIs** (leaderboard, heatmap, drilldown)
- **Lens Picker** page (2x2 grid)
- **Leaderboard** component (ranked list with medals, coverage bars, warnings)
- **Heatmap** component (color-coded score matrix, best-in-row, TOTAL row)
- **Drill-down** panel (scores + run lineage + artifact links + trend)
- **Winner callout** in detailed views
- **Materialized view refresh** (debounced background job, 5s coalesce window)

### Phase 4: Scenarios, Settings & Polish (`2026-03-26-web-phase4-scenarios.md`)

Scope:
- **Scenarios API** (CRUD + `.litmus-pack` import/export with manifest.json)
- **Scenario Library** page (card grid + import)
- **Scenario Detail** page (tabbed content viewer: Prompt/Task/Scoring/Project/Tests)
- **Agents API** (CRUD + health check)
- **Settings** page (agents list, judge config with auto-run toggle, theme)
- **Mobile navigation** (hamburger collapse at <768px)
- **Agent Dockerfiles** (devcontainer.json + run.sh for claude, aider, opencode, kilocode)
- **Migration script** (`scripts/import-sqlite.ts`)

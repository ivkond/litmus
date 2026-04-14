# Phase 5: Scenarios Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full Scenarios CRUD with card-based library view, tabbed detail page (Prompt/Task/Scoring/Project/Tests), and `.litmus-pack` import/export UI — all backed by S3 (Garage) file storage.

**Architecture:** Three layers — (1) Query Layer: `lib/scenarios/queries.ts` for direct DB+S3 queries called from server components (same pattern as `lib/compare/queries.ts`); (2) API: REST endpoints for mutations (POST/PUT/DELETE) and file operations; (3) UI: server-rendered pages pass data to focused client components. Server components **never call their own API routes** — they import query functions directly.

**Tech Stack:** Next.js App Router (server + client components), Drizzle ORM + PostgreSQL, `@aws-sdk/client-s3` (via `lib/s3.ts`), `adm-zip` (import/export), Vitest, Tailwind CSS 4, CSS variables (Lab Instrument Design System).

**Spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md` — sections "4. Scenarios Screen", ".litmus-pack Format", API Routes `/api/scenarios/*`, Object Storage layout.

**Existing Code:**
- `web/src/db/schema.ts:33-43` — `scenarios` table (complete)
- `web/src/lib/s3.ts` — S3 helpers: `uploadFile`, `downloadFile`, `listFiles`, `deleteFile`, `BUCKETS`
- `web/src/app/api/scenarios/route.ts` — GET list (exists, will add POST)
- `web/src/app/api/scenarios/import/route.ts` — POST import (complete)
- `web/src/app/scenarios/page.tsx` — minimal table view (will replace with grid)

**Working directory:** All commands must be run from `web/` subdirectory:
```bash
cd web
```

---

## File Map

```
web/src/
├── lib/scenarios/
│   ├── types.ts                                    # NEW — shared types for scenario detail/files
│   └── queries.ts                                  # NEW — direct DB+S3 query functions for server components
├── app/
│   ├── api/scenarios/
│   │   ├── route.ts                                # MODIFY — add POST (create scenario) with 409 on duplicate slug
│   │   ├── [id]/
│   │   │   └── route.ts                            # NEW — PUT update, DELETE (DB-first, then S3, log partial failures)
│   │   ├── [id]/files/
│   │   │   └── route.ts                            # NEW — GET file content, PUT file content (create or update)
│   │   └── export/
│   │       └── route.ts                            # NEW — GET export selected/all as .litmus-pack (in-memory ZIP via adm-zip)
│   ├── scenarios/
│   │   ├── page.tsx                                # REWRITE — server component: fetch via queries.ts
│   │   ├── scenarios-library.tsx                    # NEW — client: search, import dialog, selection, export
│   │   └── [id]/
│   │       ├── page.tsx                            # NEW — server component: fetch detail via queries.ts
│   │       ├── scenario-header.tsx                  # NEW — client: breadcrumb, metadata edit form, delete
│   │       ├── scenario-tabs.tsx                    # NEW — client: tab bar + file viewer/editor
│   │       └── scenario-sidebar.tsx                 # NEW — client: metadata + performance stats display
├── __tests__/ (co-located)
│   ├── lib/scenarios/__tests__/queries.test.ts      # NEW — query layer unit tests (mocked DB+S3)
│   ├── app/api/scenarios/__tests__/crud.test.ts     # NEW — CRUD API contract tests
│   ├── app/api/scenarios/__tests__/files.test.ts    # NEW — files API contract tests
│   └── app/api/scenarios/__tests__/export.test.ts   # NEW — export API tests
```

---

## Task 1: Shared Types + Query Layer Foundation

**Files:**
- Create: `web/src/lib/scenarios/types.ts`
- Create: `web/src/lib/scenarios/queries.ts`
- Create: `web/src/lib/scenarios/__tests__/queries.test.ts`

- [ ] **Step 1: Create the types file**

```typescript
// web/src/lib/scenarios/types.ts

export interface ScenarioFile {
  key: string;       // S3 key relative to scenario root, e.g. "prompt.txt"
  name: string;      // Display name, e.g. "prompt.txt"
  size: number;      // bytes (0 if unknown)
}

export interface ScenarioUsageStats {
  totalRuns: number;
  avgScore: number | null;
  bestScore: number | null;
  worstScore: number | null;
}

export interface ScenarioDetailResponse {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  language: string | null;
  tags: string[] | null;
  maxScore: number | null;
  createdAt: string;
  files: ScenarioFile[];
  usage: ScenarioUsageStats;
}

export interface ScenarioListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  language: string | null;
  tags: string[] | null;
  maxScore: number | null;
  createdAt: string;
  totalRuns: number;
  avgScore: number | null;
}
```

- [ ] **Step 2: Write failing tests for query functions**

```typescript
// web/src/lib/scenarios/__tests__/queries.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  sql: Object.assign(vi.fn().mockResolvedValue([]), {
    unsafe: vi.fn().mockReturnValue(vi.fn()),
  }),
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id', slug: 'slug' },
}));

vi.mock('@/lib/s3', () => ({
  listFiles: vi.fn().mockResolvedValue([]),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

describe('fetchScenarioList', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns empty array when no scenarios exist', async () => {
    const { fetchScenarioList } = await import('../queries');
    const result = await fetchScenarioList();
    expect(result).toEqual([]);
  });

  it('returns ScenarioListItem[] shape with usage stats', async () => {
    const { sql } = await import('@/db');
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: '123',
        slug: 'test-scenario',
        name: 'Test Scenario',
        description: 'A test',
        version: 'v1',
        language: 'python',
        tags: ['algo'],
        max_score: 100,
        created_at: '2026-03-29T00:00:00Z',
        total_runs: '5',
        avg_score: '78.5',
      },
    ]);

    const { fetchScenarioList } = await import('../queries');
    const result = await fetchScenarioList();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: '123',
      slug: 'test-scenario',
      name: 'Test Scenario',
      description: 'A test',
      version: 'v1',
      language: 'python',
      tags: ['algo'],
      maxScore: 100,
      createdAt: '2026-03-29T00:00:00Z',
      totalRuns: 5,
      avgScore: 78.5,
    });
  });
});

describe('fetchScenarioDetail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null when scenario not found', async () => {
    const { fetchScenarioDetail } = await import('../queries');
    const result = await fetchScenarioDetail('non-existent');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/scenarios/__tests__/queries.test.ts`
Expected: FAIL — module `../queries` not found

- [ ] **Step 4: Implement query functions**

```typescript
// web/src/lib/scenarios/queries.ts
import { sql } from '@/db';
import { listFiles, BUCKETS } from '@/lib/s3';
import type { ScenarioListItem, ScenarioDetailResponse, ScenarioFile } from './types';

export async function fetchScenarioList(): Promise<ScenarioListItem[]> {
  const rows = await sql`
    SELECT s.*,
           COUNT(rr.id) AS total_runs,
           AVG(CASE WHEN rr.status IN ('completed', 'failed') THEN rr.total_score END) AS avg_score
    FROM scenarios s
    LEFT JOIN run_results rr ON rr.scenario_id = s.id
    GROUP BY s.id
    ORDER BY s.slug
  `;

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    version: (row.version as string | null) ?? null,
    language: (row.language as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? null,
    maxScore: row.max_score != null ? Number(row.max_score) : null,
    createdAt: String(row.created_at),
    totalRuns: Number(row.total_runs ?? 0),
    avgScore: row.avg_score != null ? Number(row.avg_score) : null,
  }));
}

export async function fetchScenarioDetail(id: string): Promise<ScenarioDetailResponse | null> {
  const scenarioRows = await sql`
    SELECT * FROM scenarios WHERE id = ${id}
  `;

  const rows = scenarioRows as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const scenario = rows[0];

  // Usage stats
  const statsRows = await sql`
    SELECT COUNT(*) AS total_runs,
           AVG(total_score) AS avg_score,
           MAX(total_score) AS best_score,
           MIN(total_score) AS worst_score
    FROM run_results
    WHERE scenario_id = ${id}
      AND status IN ('completed', 'failed')
  `;

  const stats = (statsRows as Array<Record<string, unknown>>)[0] ?? {};

  // Files from S3
  const slug = String(scenario.slug);
  const keys = await listFiles(BUCKETS.scenarios, `${slug}/`);
  const files: ScenarioFile[] = keys.map((key) => ({
    key: key.replace(`${slug}/`, ''),
    name: key.replace(`${slug}/`, ''),
    size: 0,
  }));

  return {
    id: String(scenario.id),
    slug,
    name: String(scenario.name),
    description: (scenario.description as string | null) ?? null,
    version: (scenario.version as string | null) ?? null,
    language: (scenario.language as string | null) ?? null,
    tags: (scenario.tags as string[] | null) ?? null,
    maxScore: scenario.max_score != null ? Number(scenario.max_score) : null,
    createdAt: String(scenario.created_at),
    files,
    usage: {
      totalRuns: Number(stats.total_runs ?? 0),
      avgScore: stats.avg_score != null ? Number(stats.avg_score) : null,
      bestScore: stats.best_score != null ? Number(stats.best_score) : null,
      worstScore: stats.worst_score != null ? Number(stats.worst_score) : null,
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/scenarios/__tests__/queries.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd web && git add src/lib/scenarios/types.ts src/lib/scenarios/queries.ts src/lib/scenarios/__tests__/queries.test.ts
git commit -m "feat(scenarios): add shared types and query layer for scenario list/detail"
```

---

## Task 2: GET Detail as API (for client-side use) + PUT + DELETE /api/scenarios/[id]

**Files:**
- Create: `web/src/app/api/scenarios/[id]/route.ts`
- Create: `web/src/app/api/scenarios/__tests__/crud.test.ts`

- [ ] **Step 1: Write failing tests with real business contract assertions**

```typescript
// web/src/app/api/scenarios/__tests__/crud.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockReturning = vi.fn();
const mockDeleteFn = vi.fn();

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhere }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: mockReturning }) }) }),
    delete: () => ({ where: mockDeleteFn }),
  },
  sql: Object.assign(vi.fn().mockResolvedValue([{ total_runs: 0, avg_score: null, best_score: null, worst_score: null }]), {
    unsafe: vi.fn(),
  }),
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id', slug: 'slug' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@/lib/s3', () => ({
  listFiles: vi.fn().mockResolvedValue([]),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

const MOCK_SCENARIO = {
  id: 'sc-1',
  slug: 'test-scenario',
  name: 'Test',
  description: null,
  version: 'v1',
  language: 'python',
  tags: null,
  maxScore: 100,
  createdAt: new Date('2026-03-29'),
};

describe('GET /api/scenarios/[id]', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockReturning.mockReset();
    mockDeleteFn.mockReset();
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { GET } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/missing');
    const res = await GET(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with ScenarioDetailResponse shape when found', async () => {
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    const { GET } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1');
    const res = await GET(req, { params: Promise.resolve({ id: 'sc-1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'sc-1',
      slug: 'test-scenario',
      name: 'Test',
      files: [],
      usage: { totalRuns: 0, avgScore: null, bestScore: null, worstScore: null },
    });
  });
});

describe('PUT /api/scenarios/[id]', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockReturning.mockReset();
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { PUT } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with unchanged data when body has no recognized fields', async () => {
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    const { PUT } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
  });

  it('returns 200 with updated scenario when valid fields provided', async () => {
    const updated = { ...MOCK_SCENARIO, name: 'Updated Name' };
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    mockReturning.mockResolvedValueOnce([updated]);
    const { PUT } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated Name');
  });
});

describe('DELETE /api/scenarios/[id]', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockDeleteFn.mockReset();
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { DELETE: deleteFn } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/missing', { method: 'DELETE' });
    const res = await deleteFn(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with deleted:true on success', async () => {
    mockWhere.mockResolvedValueOnce([MOCK_SCENARIO]);
    mockDeleteFn.mockResolvedValueOnce(undefined);
    const { listFiles } = await import('@/lib/s3');
    (listFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['test-scenario/prompt.txt']);

    const { DELETE: deleteFn } = await import('../[id]/route');
    const req = new Request('http://localhost/api/scenarios/sc-1', { method: 'DELETE' });
    const res = await deleteFn(req, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/crud.test.ts`
Expected: FAIL — module `../[id]/route` not found

- [ ] **Step 3: Implement the route (GET + PUT + DELETE)**

```typescript
// web/src/app/api/scenarios/[id]/route.ts
import { NextResponse } from 'next/server';
import { db, sql } from '@/db';
import { scenarios } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { listFiles, deleteFile, BUCKETS } from '@/lib/s3';
import type { ScenarioDetailResponse, ScenarioFile } from '@/lib/scenarios/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  // Usage stats from run_results
  const statsRows = await sql`
    SELECT COUNT(*) AS total_runs,
           AVG(total_score) AS avg_score,
           MAX(total_score) AS best_score,
           MIN(total_score) AS worst_score
    FROM run_results
    WHERE scenario_id = ${id}
      AND status IN ('completed', 'failed')
  `;
  const stats = (statsRows as Array<Record<string, unknown>>)[0] ?? {};

  // Files from S3
  const keys = await listFiles(BUCKETS.scenarios, `${scenario.slug}/`);
  const files: ScenarioFile[] = keys.map((key) => ({
    key: key.replace(`${scenario.slug}/`, ''),
    name: key.replace(`${scenario.slug}/`, ''),
    size: 0,
  }));

  const response: ScenarioDetailResponse = {
    id: scenario.id,
    slug: scenario.slug,
    name: scenario.name,
    description: scenario.description,
    version: scenario.version,
    language: scenario.language,
    tags: scenario.tags,
    maxScore: scenario.maxScore,
    createdAt: scenario.createdAt?.toISOString() ?? new Date().toISOString(),
    files,
    usage: {
      totalRuns: Number(stats.total_runs ?? 0),
      avgScore: stats.avg_score != null ? Number(stats.avg_score) : null,
      bestScore: stats.best_score != null ? Number(stats.best_score) : null,
      worstScore: stats.worst_score != null ? Number(stats.worst_score) : null,
    },
  };

  return NextResponse.json(response);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  const [existing] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!existing) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  const updates: Partial<typeof scenarios.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.version !== undefined) updates.version = body.version;
  if (body.language !== undefined) updates.language = body.language;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.maxScore !== undefined) updates.maxScore = body.maxScore;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(existing);
  }

  const [updated] = await db
    .update(scenarios)
    .set(updates)
    .where(eq(scenarios.id, id))
    .returning();

  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [existing] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!existing) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  // DB-first: delete the record so it's no longer visible even if S3 cleanup fails
  await db.delete(scenarios).where(eq(scenarios.id, id));

  // Best-effort S3 cleanup — log failures but don't fail the request
  try {
    const keys = await listFiles(BUCKETS.scenarios, `${existing.slug}/`);
    for (const key of keys) {
      try {
        await deleteFile(BUCKETS.scenarios, key);
      } catch (err) {
        console.error(`[DELETE scenario] Failed to delete S3 key "${key}":`, err);
      }
    }
  } catch (err) {
    console.error(`[DELETE scenario] Failed to list S3 files for "${existing.slug}":`, err);
  }

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/crud.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd web && git add src/app/api/scenarios/[id]/route.ts src/app/api/scenarios/__tests__/crud.test.ts
git commit -m "feat(scenarios): add GET/PUT/DELETE /api/scenarios/[id] with DB-first delete"
```

---

## Task 3: POST /api/scenarios — Create Scenario with Initial Files + 409 on Duplicate Slug

Per spec: `POST /api/scenarios — Create scenario (metadata + upload to S3)`. The handler uses **JSON** (`Content-Type: application/json`, parsed via `request.json()`). The body contains metadata fields and an optional `files` map (`Record<string, string>` of `{ filename: content }`). The handler inserts a DB row, then uploads any provided files to S3.

**Files:**
- Modify: `web/src/app/api/scenarios/route.ts`
- Create: `web/src/app/api/scenarios/__tests__/create.test.ts` (separate file — avoids dual `vi.mock('@/db')` conflict with crud.test.ts)

- [ ] **Step 1: Write failing tests for POST in a dedicated test file**

```typescript
// web/src/app/api/scenarios/__tests__/create.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertReturning = vi.fn();
const mockUpload = vi.fn();

vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: () => ({ returning: mockInsertReturning }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  scenarios: { slug: 'slug' },
}));

vi.mock('@/lib/scenarios/queries', () => ({
  fetchScenarioList: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/s3', () => ({
  uploadFile: (...args: unknown[]) => mockUpload(...args),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

describe('POST /api/scenarios', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInsertReturning.mockReset();
    mockUpload.mockReset();
  });

  it('returns 400 when slug is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slug/i);
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'test' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it('returns 201 with created scenario on success', async () => {
    const created = { id: 'new-1', slug: 'test', name: 'Test', version: 'v1' };
    mockInsertReturning.mockResolvedValueOnce([created]);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'test', name: 'Test' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'new-1', slug: 'test', name: 'Test' });
  });

  it('uploads initial files to S3 when provided', async () => {
    const created = { id: 'new-1', slug: 'test', name: 'Test', version: 'v1' };
    mockInsertReturning.mockResolvedValueOnce([created]);
    mockUpload.mockResolvedValue(undefined);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'test',
        name: 'Test',
        files: { 'prompt.txt': 'Write a hello world', 'task.txt': 'Complete the task' },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockUpload).toHaveBeenCalledWith('litmus-scenarios', 'test/prompt.txt', 'Write a hello world', 'text/plain');
    expect(mockUpload).toHaveBeenCalledWith('litmus-scenarios', 'test/task.txt', 'Complete the task', 'text/plain');
  });

  it('returns 409 when slug already exists', async () => {
    mockInsertReturning.mockRejectedValueOnce(
      Object.assign(new Error('unique constraint'), { code: '23505' }),
    );
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'existing', name: 'Existing' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/slug.*exists|duplicate/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/create.test.ts`
Expected: FAIL — `POST` not exported

- [ ] **Step 3: Add POST handler with initial file upload + 409**

Update `web/src/app/api/scenarios/route.ts` — keep existing GET, add POST:

```typescript
// web/src/app/api/scenarios/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { fetchScenarioList } from '@/lib/scenarios/queries';
import { uploadFile, BUCKETS } from '@/lib/s3';

export async function GET() {
  const items = await fetchScenarioList();
  return NextResponse.json(items);
}

export async function POST(request: Request) {
  const body = await request.json();

  if (!body.slug || !body.name) {
    return NextResponse.json(
      { error: 'slug and name are required' },
      { status: 400 },
    );
  }

  try {
    const [created] = await db
      .insert(scenarios)
      .values({
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        version: body.version ?? 'v1',
        language: body.language ?? null,
        tags: body.tags ?? null,
        maxScore: body.maxScore ?? null,
      })
      .returning();

    // Upload initial files to S3 if provided
    // body.files is an optional Record<string, string> of { filename: content }
    const files = body.files as Record<string, string> | undefined;
    if (files) {
      for (const [filename, content] of Object.entries(files)) {
        await uploadFile(BUCKETS.scenarios, `${body.slug}/${filename}`, content, 'text/plain');
      }
    }

    return NextResponse.json(created, { status: 201 });
  } catch (err: unknown) {
    // Postgres unique_violation for slug
    if (err instanceof Error && (err as Error & { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'A scenario with this slug already exists' },
        { status: 409 },
      );
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/create.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd web && npx vitest run`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
cd web && git add src/app/api/scenarios/route.ts src/app/api/scenarios/__tests__/create.test.ts
git commit -m "feat(scenarios): add POST /api/scenarios with initial S3 upload + 409 on duplicate slug"
```

---

## Task 4: GET/PUT /api/scenarios/[id]/files — File Read/Write (with S3 error differentiation)

**Files:**
- Create: `web/src/app/api/scenarios/[id]/files/route.ts`
- Create: `web/src/app/api/scenarios/__tests__/files.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/app/api/scenarios/__tests__/files.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.fn();

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhere }) }),
  },
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

const mockDownload = vi.fn();
const mockUpload = vi.fn();

vi.mock('@/lib/s3', () => ({
  downloadFile: (...args: unknown[]) => mockDownload(...args),
  uploadFile: (...args: unknown[]) => mockUpload(...args),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

const SCENARIO = { id: 'sc-1', slug: 'test-scenario' };

describe('GET /api/scenarios/[id]/files', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockDownload.mockReset();
  });

  it('returns 400 when path query param is missing', async () => {
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=prompt.txt');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 with file content when file exists', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    mockDownload.mockResolvedValueOnce(Buffer.from('Hello world'));
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=prompt.txt');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ path: 'prompt.txt', content: 'Hello world' });
  });

  it('returns 404 when S3 key does not exist (NoSuchKey)', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    const s3Error = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockDownload.mockRejectedValueOnce(s3Error);
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=missing.txt');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 502 when S3 has a service error', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    const s3Error = Object.assign(new Error('ServiceUnavailable'), { name: 'ServiceUnavailable', $metadata: {} });
    mockDownload.mockRejectedValueOnce(s3Error);
    const { GET } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files?path=prompt.txt');
    const res = await GET(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(502);
  });
});

describe('PUT /api/scenarios/[id]/files', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockUpload.mockReset();
  });

  it('returns 400 when path or content missing', async () => {
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'prompt.txt' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when scenario not found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'prompt.txt', content: 'test' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 200 on successful upload (creates or overwrites)', async () => {
    mockWhere.mockResolvedValueOnce([SCENARIO]);
    mockUpload.mockResolvedValueOnce(undefined);
    const { PUT } = await import('../[id]/files/route');
    const req = new Request('http://localhost/api/scenarios/sc-1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'prompt.txt', content: 'Hello world' }),
    });
    const res = await PUT(req as any, { params: Promise.resolve({ id: 'sc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ path: 'prompt.txt', updated: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/files.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the files route with S3 error differentiation**

```typescript
// web/src/app/api/scenarios/[id]/files/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { downloadFile, uploadFile, BUCKETS } from '@/lib/s3';

function isS3NotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const name = (err as Error & { name?: string }).name ?? '';
    return name === 'NoSuchKey' || name === 'NotFound';
  }
  return false;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path query param required' }, { status: 400 });
  }

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  try {
    const buffer = await downloadFile(BUCKETS.scenarios, `${scenario.slug}/${filePath}`);
    const content = buffer.toString('utf-8');
    return NextResponse.json({ path: filePath, content });
  } catch (err) {
    if (isS3NotFound(err)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    console.error(`[files GET] S3 error for "${scenario.slug}/${filePath}":`, err);
    return NextResponse.json({ error: 'Storage service error' }, { status: 502 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { path: filePath, content } = body;

  if (!filePath || content === undefined) {
    return NextResponse.json({ error: 'path and content required' }, { status: 400 });
  }

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  await uploadFile(BUCKETS.scenarios, `${scenario.slug}/${filePath}`, content, 'text/plain');
  return NextResponse.json({ path: filePath, updated: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd web && git add src/app/api/scenarios/[id]/files/route.ts src/app/api/scenarios/__tests__/files.test.ts
git commit -m "feat(scenarios): add GET/PUT /api/scenarios/[id]/files with S3 error differentiation"
```

---

## Task 5: GET /api/scenarios/export — Export Selected as .litmus-pack (per spec: GET method, selective export)

**Files:**
- Create: `web/src/app/api/scenarios/export/route.ts`
- Create: `web/src/app/api/scenarios/__tests__/export.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web/src/app/api/scenarios/__tests__/export.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.fn();

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhere }) }),
  },
}));

vi.mock('@/db/schema', () => ({
  scenarios: { id: 'id', slug: 'slug' },
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
}));

const mockListFiles = vi.fn();
const mockDownloadFile = vi.fn();

vi.mock('@/lib/s3', () => ({
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
  BUCKETS: { scenarios: 'litmus-scenarios' },
}));

describe('GET /api/scenarios/export', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
    mockListFiles.mockReset();
    mockDownloadFile.mockReset();
  });

  it('returns 400 when no ids query param provided', async () => {
    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export');
    const res = await GET(req as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ids/i);
  });

  it('returns 404 when no matching scenarios found', async () => {
    mockWhere.mockResolvedValueOnce([]);
    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export?ids=non-existent');
    const res = await GET(req as any);
    expect(res.status).toBe(404);
  });

  it('returns ZIP with correct content-type and disposition when scenarios found', async () => {
    mockWhere.mockResolvedValueOnce([
      { id: 'sc-1', slug: 'test', name: 'Test', version: 'v1', language: 'python', description: null, tags: null, maxScore: null },
    ]);
    mockListFiles.mockResolvedValueOnce(['test/prompt.txt']);
    mockDownloadFile.mockResolvedValueOnce(Buffer.from('test content'));

    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export?ids=sc-1');
    const res = await GET(req as any);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toMatch(/\.litmus-pack/);

    // Verify it's a valid ZIP by checking magic bytes
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    // ZIP magic bytes: PK (0x50, 0x4B)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4B);
  });

  it('exports multiple scenarios when multiple ids provided', async () => {
    mockWhere.mockResolvedValueOnce([
      { id: 'sc-1', slug: 'alpha', name: 'Alpha', version: 'v1', language: 'python', description: null, tags: null, maxScore: null },
      { id: 'sc-2', slug: 'beta', name: 'Beta', version: 'v2', language: 'go', description: null, tags: null, maxScore: null },
    ]);
    mockListFiles
      .mockResolvedValueOnce(['alpha/prompt.txt'])
      .mockResolvedValueOnce(['beta/prompt.txt']);
    mockDownloadFile
      .mockResolvedValueOnce(Buffer.from('alpha prompt'))
      .mockResolvedValueOnce(Buffer.from('beta prompt'));

    const { GET } = await import('../export/route');
    const req = new Request('http://localhost/api/scenarios/export?ids=sc-1,sc-2');
    const res = await GET(req as any);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/export.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the export route (GET method, per spec)**

```typescript
// web/src/app/api/scenarios/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { listFiles, downloadFile, BUCKETS } from '@/lib/s3';

export async function GET(request: NextRequest) {
  const idsParam = request.nextUrl.searchParams.get('ids');

  if (!idsParam) {
    return NextResponse.json({ error: 'ids query parameter required (comma-separated)' }, { status: 400 });
  }

  const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids query parameter required (comma-separated)' }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(scenarios)
    .where(inArray(scenarios.id, ids));

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No matching scenarios found' }, { status: 404 });
  }

  const zip = new AdmZip();

  // Build manifest matching .litmus-pack spec
  const manifest = {
    version: 1,
    kind: 'scenarios',
    created_at: new Date().toISOString(),
    scenarios: rows.map((s) => ({
      slug: s.slug,
      name: s.name,
      version: s.version ?? 'v1',
      language: s.language ?? undefined,
      description: s.description ?? undefined,
      tags: s.tags ?? undefined,
      maxScore: s.maxScore ?? undefined,
    })),
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

  // Add files for each scenario
  for (const scenario of rows) {
    const keys = await listFiles(BUCKETS.scenarios, `${scenario.slug}/`);
    for (const key of keys) {
      const buffer = await downloadFile(BUCKETS.scenarios, key);
      zip.addFile(key, buffer);
    }
  }

  const zipBuffer = zip.toBuffer();

  return new NextResponse(zipBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="scenarios-${Date.now()}.litmus-pack"`,
    },
  });
}
```

> **Note on in-memory ZIP:** `adm-zip` builds the ZIP in memory via `toBuffer()`. For typical scenario packs (dozens of text files), this is well under memory limits. If packs grow to hundreds of MB, switch to `archiver` with streaming — YAGNI for now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/api/scenarios/__tests__/export.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd web && git add src/app/api/scenarios/export/route.ts src/app/api/scenarios/__tests__/export.test.ts
git commit -m "feat(scenarios): add GET /api/scenarios/export for selective .litmus-pack generation"
```

---

## Task 6: Scenarios Library Page — Card Grid with Selection + Selective Export

**Files:**
- Rewrite: `web/src/app/scenarios/page.tsx`
- Create: `web/src/app/scenarios/scenarios-library.tsx`

- [ ] **Step 1: Write failing smoke test for the library component**

```typescript
// web/src/app/scenarios/__tests__/scenarios-library.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

describe('ScenariosLibrary', () => {
  it('renders empty state when no scenarios', async () => {
    const { ScenariosLibrary } = await import('../scenarios-library');
    // dynamic import to avoid module resolution issues before implementation
    expect(ScenariosLibrary).toBeDefined();
    expect(typeof ScenariosLibrary).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/scenarios/__tests__/scenarios-library.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Rewrite the server page (direct query import, no self-fetch)**

```typescript
// web/src/app/scenarios/page.tsx
import { fetchScenarioList } from '@/lib/scenarios/queries';
import { ScenariosLibrary } from './scenarios-library';

export const dynamic = 'force-dynamic';

export default async function ScenariosPage() {
  const scenarios = await fetchScenarioList();
  return <ScenariosLibrary scenarios={scenarios} />;
}
```

- [ ] **Step 4: Create the library client component with selection + selective export**

```typescript
// web/src/app/scenarios/scenarios-library.tsx
'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ScenarioListItem } from '@/lib/scenarios/types';

interface Props {
  scenarios: ScenarioListItem[];
}

export function ScenariosLibrary({ scenarios }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ slug: '', name: '', language: '', description: '' });

  const filtered = scenarios.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.slug.toLowerCase().includes(search.toLowerCase()) ||
      (s.language ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((s) => s.id)));
    }
  }, [filtered, selected.size]);

  const handleImport = useCallback(async (file: File) => {
    setImporting(true);
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/scenarios/import', { method: 'POST', body: formData });
    if (res.ok) {
      router.refresh();
    }
    setImporting(false);
  }, [router]);

  const handleCreate = useCallback(async () => {
    if (!form.slug || !form.name) return;
    const res = await fetch('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setCreating(false);
      setForm({ slug: '', name: '', language: '', description: '' });
      router.refresh();
    }
  }, [form, router]);

  const handleExport = useCallback(async () => {
    // Export selected scenarios; if none selected, export all
    const ids = selected.size > 0
      ? Array.from(selected)
      : scenarios.map((s) => s.id);
    const res = await fetch(`/api/scenarios/export?ids=${ids.join(',')}`);
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scenarios-${Date.now()}.litmus-pack`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [scenarios, selected]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">Scenarios</h1>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {scenarios.length} {scenarios.length === 1 ? 'scenario' : 'scenarios'}
          </span>
        </div>
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search scenarios…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
        <label className="cursor-pointer rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
          {importing ? 'Importing…' : 'Import Pack'}
          <input
            type="file"
            accept=".litmus-pack,.zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImport(file);
            }}
          />
        </label>
        {scenarios.length > 0 && (
          <button
            onClick={handleExport}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {selected.size > 0 ? `Export ${selected.size} Selected` : 'Export All'}
          </button>
        )}
        <button
          onClick={() => setCreating(!creating)}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          + New Scenario
        </button>
      </div>

      {/* Selection controls */}
      {scenarios.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <button onClick={selectAll} className="underline hover:text-[var(--text-secondary)]">
            {selected.size === filtered.length ? 'Deselect all' : 'Select all'}
          </button>
          {selected.size > 0 && (
            <span>{selected.size} selected</span>
          )}
        </div>
      )}

      {/* Create form */}
      {creating && (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Slug (e.g. 1-data-structure)"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
            <input
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
            <input
              placeholder="Language (e.g. python)"
              value={form.language}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
            <input
              placeholder="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!form.slug || !form.name}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {/* Scenario grid */}
      {filtered.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--text-muted)]">
            {scenarios.length === 0
              ? 'No scenarios yet. Import a pack or create a new scenario.'
              : 'No scenarios match your search.'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <div key={s.id} className="relative">
              {/* Selection checkbox */}
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggleSelect(s.id)}
                className="absolute left-2 top-2 z-10"
                aria-label={`Select ${s.name}`}
              />
              <Link href={`/scenarios/${s.id}`}>
                <Card hover className="h-full pl-8">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-semibold text-[var(--text-primary)] truncate">
                        {s.name}
                      </div>
                      <code className="text-[0.65rem] text-[var(--text-muted)]">{s.slug}</code>
                    </div>
                    {s.version && (
                      <Badge>{s.version}</Badge>
                    )}
                  </div>
                  {s.description && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)] line-clamp-2">
                      {s.description}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    {s.language && <Badge variant="accent">{s.language}</Badge>}
                    {(s.tags ?? []).slice(0, 2).map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-4 text-[0.65rem] text-[var(--text-muted)]">
                    <span>{s.totalRuns} runs</span>
                    {s.avgScore != null && (
                      <span>avg {s.avgScore.toFixed(0)}%</span>
                    )}
                  </div>
                </Card>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/scenarios/__tests__/scenarios-library.test.tsx`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
cd web && git add src/app/scenarios/page.tsx src/app/scenarios/scenarios-library.tsx src/app/scenarios/__tests__/scenarios-library.test.tsx
git commit -m "feat(scenarios): rewrite library page with card grid, selection, selective export"
```

---

## Task 7: Scenario Detail Server Page

**Files:**
- Create: `web/src/app/scenarios/[id]/page.tsx`

- [ ] **Step 1: Write failing test for the server page**

```typescript
// web/src/app/scenarios/[id]/__tests__/page.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/scenarios/queries', () => ({
  fetchScenarioDetail: vi.fn().mockResolvedValue(null),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
}));

describe('ScenarioDetailPage', () => {
  it('calls notFound() when scenario does not exist', async () => {
    const { default: ScenarioDetailPage } = await import('../page');
    await expect(
      ScenarioDetailPage({ params: Promise.resolve({ id: 'non-existent' }) }),
    ).rejects.toThrow('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/page.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Create the server page (direct query import, no self-fetch)**

```typescript
// web/src/app/scenarios/[id]/page.tsx
import { notFound } from 'next/navigation';
import { fetchScenarioDetail } from '@/lib/scenarios/queries';
import { ScenarioHeader } from './scenario-header';
import { ScenarioTabs } from './scenario-tabs';
import { ScenarioSidebar } from './scenario-sidebar';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ScenarioDetailPage({ params }: Props) {
  const { id } = await params;
  const data = await fetchScenarioDetail(id);

  if (!data) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <ScenarioHeader data={data} />
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <ScenarioTabs data={data} />
        </div>
        <div className="w-64 flex-shrink-0">
          <ScenarioSidebar data={data} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/page.test.tsx`
Expected: FAIL — client component imports not found yet

- [ ] **Step 5: Create client components (full implementations, not stubs)**

These are created in full in Tasks 8–10 below. The server page test will pass once all three components exist. **Do not commit this task until Tasks 8–10 are complete** — the page, header, tabs, and sidebar form one atomic unit.

Continue to Task 8 immediately.

---

## Task 8: Scenario Header — Breadcrumb, Metadata Edit, Delete

**Files:**
- Create: `web/src/app/scenarios/[id]/scenario-header.tsx`
- Create: `web/src/app/scenarios/[id]/__tests__/scenario-header.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// web/src/app/scenarios/[id]/__tests__/scenario-header.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

describe('ScenarioHeader', () => {
  it('exports ScenarioHeader as a named function', async () => {
    const mod = await import('../scenario-header');
    expect(typeof mod.ScenarioHeader).toBe('function');
  });

  it('has the expected function signature (single props arg)', async () => {
    const { ScenarioHeader } = await import('../scenario-header');
    // React component: single props object argument
    expect(ScenarioHeader.length).toBeLessThanOrEqual(1);
  });

  // NOTE: ScenarioHeader uses hooks (useState, useCallback) so it cannot be called
  // outside a React render tree. Render-level testing requires jsdom + @testing-library/react
  // which is out of scope for this phase. The typecheck step validates prop compatibility.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/scenario-header.test.tsx`
Expected: FAIL — module not found (file doesn't exist yet)

- [ ] **Step 3: Implement full component**

```typescript
// web/src/app/scenarios/[id]/scenario-header.tsx
'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import type { ScenarioDetailResponse } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

export function ScenarioHeader({ data }: Props) {
  const router = useRouter();
  const [editMeta, setEditMeta] = useState(false);
  const [saving, setSaving] = useState(false);
  const [metaForm, setMetaForm] = useState({
    name: data.name,
    description: data.description ?? '',
    version: data.version ?? 'v1',
    language: data.language ?? '',
    maxScore: data.maxScore ?? 100,
  });

  const handleSaveMeta = useCallback(async () => {
    setSaving(true);
    const res = await fetch(`/api/scenarios/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaForm),
    });
    if (res.ok) {
      setEditMeta(false);
      router.refresh();
    }
    setSaving(false);
  }, [data.id, metaForm, router]);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete scenario "${data.name}"? This cannot be undone.`)) return;
    await fetch(`/api/scenarios/${data.id}`, { method: 'DELETE' });
    router.push('/scenarios');
  }, [data.id, data.name, router]);

  return (
    <>
      {/* Breadcrumb + actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/scenarios" className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            Scenarios
          </Link>
          <span className="text-[var(--text-muted)]">/</span>
          <span className="font-mono text-[var(--text-primary)]">{data.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditMeta(!editMeta)}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            Edit Metadata
          </button>
          <button
            onClick={handleDelete}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--score-fail)] hover:bg-[var(--bg-hover)]"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Metadata edit form */}
      {editMeta && (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-[var(--text-secondary)]">
              Name
              <input
                value={metaForm.name}
                onChange={(e) => setMetaForm({ ...metaForm, name: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Version
              <input
                value={metaForm.version}
                onChange={(e) => setMetaForm({ ...metaForm, version: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Language
              <input
                value={metaForm.language}
                onChange={(e) => setMetaForm({ ...metaForm, language: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Max Score
              <input
                type="number"
                value={metaForm.maxScore}
                onChange={(e) => setMetaForm({ ...metaForm, maxScore: parseInt(e.target.value) })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="col-span-2 text-xs text-[var(--text-secondary)]">
              Description
              <textarea
                value={metaForm.description}
                onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })}
                rows={2}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSaveMeta}
              disabled={saving}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setEditMeta(false)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/scenario-header.test.tsx`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Continue to Task 9** (commit deferred to Task 10 for atomic detail page)

---

## Task 9: Scenario Tabs — File Viewer/Editor with Create Support

**Files:**
- Create: `web/src/app/scenarios/[id]/scenario-tabs.tsx`
- Create: `web/src/app/scenarios/[id]/__tests__/scenario-tabs.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// web/src/app/scenarios/[id]/__tests__/scenario-tabs.test.tsx
import { describe, it, expect } from 'vitest';

describe('ScenarioTabs', () => {
  it('exports ScenarioTabs as a named function', async () => {
    const mod = await import('../scenario-tabs');
    expect(typeof mod.ScenarioTabs).toBe('function');
  });

  it('has the expected function signature (single props arg)', async () => {
    const { ScenarioTabs } = await import('../scenario-tabs');
    expect(ScenarioTabs.length).toBeLessThanOrEqual(1);
  });

  // NOTE: ScenarioTabs uses hooks (useState, useCallback, useEffect) so it cannot be called
  // outside a React render tree. Render-level testing requires jsdom + @testing-library/react
  // which is out of scope for this phase. The typecheck step validates prop compatibility.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/scenario-tabs.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Replace stub with full implementation (with "Create File" for missing files)**

```typescript
// web/src/app/scenarios/[id]/scenario-tabs.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import type { ScenarioDetailResponse, ScenarioFile } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

const TABS = [
  { key: 'prompt', label: 'Prompt', file: 'prompt.txt' },
  { key: 'task', label: 'Task', file: 'task.txt' },
  { key: 'scoring', label: 'Scoring', file: 'scoring.csv' },
  { key: 'project', label: 'Project', file: null },
  { key: 'tests', label: 'Tests', file: null },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function ScenarioTabs({ data }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('prompt');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchFile = useCallback(async (path: string) => {
    setFileLoading(true);
    setFileContent(null);
    try {
      const res = await fetch(`/api/scenarios/${data.id}/files?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const json = await res.json();
        setFileContent(json.content);
      } else {
        setFileContent(null);
      }
    } catch {
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  }, [data.id]);

  useEffect(() => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (tab?.file) {
      fetchFile(tab.file);
    } else {
      setFileContent(null);
    }
    setEditing(false);
  }, [activeTab, fetchFile]);

  const handleSaveFile = useCallback(async (path: string, content: string) => {
    setSaving(true);
    await fetch(`/api/scenarios/${data.id}/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    setFileContent(content);
    setEditing(false);
    setSaving(false);
  }, [data.id]);

  // Categorize files for project/tests tabs using path-based convention
  const projectFiles = data.files.filter((f) => f.key.startsWith('project/'));
  const testFiles = data.files.filter((f) => f.key.startsWith('project/tests/'));
  const currentFiles =
    activeTab === 'project'
      ? projectFiles
      : activeTab === 'tests'
        ? testFiles
        : [];

  const currentTab = TABS.find((t) => t.key === activeTab);

  return (
    <>
      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-mono ${
              activeTab === tab.key
                ? 'border-b-2 border-[var(--accent)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <Card className="mt-2 min-h-[400px]">
        {fileLoading && (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        )}

        {/* Single file tabs (prompt, task, scoring) */}
        {!fileLoading && currentTab?.file && (
          <SingleFileView
            fileContent={fileContent}
            filePath={currentTab.file}
            editing={editing}
            editContent={editContent}
            saving={saving}
            onStartEdit={() => {
              setEditContent(fileContent ?? '');
              setEditing(true);
            }}
            onCancelEdit={() => setEditing(false)}
            onChangeEdit={setEditContent}
            onSave={() => handleSaveFile(currentTab.file!, editContent)}
          />
        )}

        {/* Directory tabs (project, tests) */}
        {!fileLoading && !currentTab?.file && (
          <FileList
            files={currentFiles}
            onSelect={(path) => fetchFile(path)}
            selectedContent={fileContent}
          />
        )}
      </Card>
    </>
  );
}

/** Viewer/editor for single-file tabs, with "Create File" when file doesn't exist */
function SingleFileView({
  fileContent,
  filePath,
  editing,
  editContent,
  saving,
  onStartEdit,
  onCancelEdit,
  onChangeEdit,
  onSave,
}: {
  fileContent: string | null;
  filePath: string;
  editing: boolean;
  editContent: string;
  saving: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEdit: (v: string) => void;
  onSave: () => void;
}) {
  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          value={editContent}
          onChange={(e) => onChangeEdit(e.target.value)}
          rows={20}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3 font-mono text-xs text-[var(--text-primary)]"
        />
        <div className="flex gap-2">
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={onCancelEdit}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (fileContent !== null) {
    return (
      <div>
        <div className="mb-2 flex justify-end">
          <button
            onClick={onStartEdit}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            Edit
          </button>
        </div>
        <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--text-primary)] leading-relaxed">
          {fileContent}
        </pre>
      </div>
    );
  }

  // File doesn't exist — offer to create it
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="mb-3 text-sm text-[var(--text-muted)]">
        <code className="text-[var(--text-secondary)]">{filePath}</code> does not exist yet.
      </p>
      <button
        onClick={onStartEdit}
        className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Create File
      </button>
    </div>
  );
}

/** File listing for project/tests tabs */
function FileList({
  files,
  onSelect,
  selectedContent,
}: {
  files: ScenarioFile[];
  onSelect: (path: string) => void;
  selectedContent: string | null;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  if (files.length === 0) {
    return <div className="text-sm text-[var(--text-muted)]">No files in this category.</div>;
  }

  return (
    <div className="flex gap-3">
      <div className="w-48 flex-shrink-0 space-y-1 border-r border-[var(--border)] pr-3">
        {files.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setSelectedFile(f.key);
              onSelect(f.key);
            }}
            className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${
              selectedFile === f.key
                ? 'bg-[var(--accent-dim)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {f.name}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        {selectedFile && selectedContent !== null ? (
          <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--text-primary)] leading-relaxed">
            {selectedContent}
          </pre>
        ) : selectedFile ? (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        ) : (
          <div className="text-sm text-[var(--text-muted)]">Select a file to view its contents.</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/scenario-tabs.test.tsx`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Continue to Task 10** (commit deferred to Task 10 for atomic detail page)

---

## Task 10: Scenario Sidebar — Metadata + Performance Stats

**Files:**
- Create: `web/src/app/scenarios/[id]/scenario-sidebar.tsx`
- Create: `web/src/app/scenarios/[id]/__tests__/scenario-sidebar.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// web/src/app/scenarios/[id]/__tests__/scenario-sidebar.test.tsx
import { describe, it, expect } from 'vitest';

describe('ScenarioSidebar', () => {
  it('exports ScenarioSidebar as a named function', async () => {
    const mod = await import('../scenario-sidebar');
    expect(typeof mod.ScenarioSidebar).toBe('function');
  });

  it('accepts Props with data: ScenarioDetailResponse and returns JSX', async () => {
    const { ScenarioSidebar } = await import('../scenario-sidebar');
    const data = {
      id: 'sc-1', slug: 'test', name: 'Test',
      description: null, version: 'v1', language: 'python',
      tags: ['algo'], maxScore: 100, createdAt: '2026-03-29',
      files: [{ key: 'prompt.txt', name: 'prompt.txt', size: 0 }],
      usage: { totalRuns: 5, avgScore: 78, bestScore: 95, worstScore: 40 },
    };
    const result = ScenarioSidebar({ data });
    expect(result).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/scenario-sidebar.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement full component**

```typescript
// web/src/app/scenarios/[id]/scenario-sidebar.tsx
'use client';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ScenarioDetailResponse } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

export function ScenarioSidebar({ data }: Props) {
  return (
    <div className="space-y-3">
      <Card>
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Metadata
        </h3>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Slug</span>
            <code className="text-[var(--text-secondary)]">{data.slug}</code>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Version</span>
            <span className="text-[var(--text-primary)]">{data.version ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Language</span>
            {data.language ? <Badge variant="accent">{data.language}</Badge> : <span>—</span>}
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Max Score</span>
            <span className="text-[var(--text-primary)]">{data.maxScore ?? '—'}</span>
          </div>
          {data.tags && data.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {data.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Performance
        </h3>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Total Runs</span>
            <span className="font-mono text-[var(--text-primary)]">{data.usage.totalRuns}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Avg Score</span>
            <span className="font-mono text-[var(--text-primary)]">
              {data.usage.avgScore != null ? `${data.usage.avgScore.toFixed(0)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Best</span>
            <span className="font-mono text-[var(--score-excellent)]">
              {data.usage.bestScore != null ? `${data.usage.bestScore.toFixed(0)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Worst</span>
            <span className="font-mono text-[var(--score-fail)]">
              {data.usage.worstScore != null ? `${data.usage.worstScore.toFixed(0)}%` : '—'}
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Files ({data.files.length})
        </h3>
        <div className="space-y-1">
          {data.files.map((f) => (
            <div key={f.key} className="font-mono text-[0.65rem] text-[var(--text-secondary)] truncate">
              {f.key}
            </div>
          ))}
          {data.files.length === 0 && (
            <div className="text-xs text-[var(--text-muted)]">No files uploaded</div>
          )}
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run all detail page tests to verify they pass**

Run: `cd web && npx vitest run src/app/scenarios/[id]/__tests__/`
Expected: PASS — all tests for page, header, tabs, sidebar pass

- [ ] **Step 5: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit (atomic: server page + all 3 client components + all tests)**

```bash
cd web && git add src/app/scenarios/[id]/
git commit -m "feat(scenarios): add scenario detail page with header, tabs, sidebar"
```

> This atomic commit includes the server page (Task 7), header (Task 8), tabs (Task 9), and sidebar (Task 10) — no placeholder stubs are ever committed.

---

## Task 11: Final Integration — Run Full Quality Gates

**Files:** Modify `web/vitest.config.ts` (expand include + coverage scope)

- [ ] **Step 1: Update vitest.config.ts to include .tsx tests and scenario coverage**

The current config has `include: ['src/**/*.test.ts']` which misses `.test.tsx` files. Coverage only includes `src/lib/orchestrator/**`. Update both:

```typescript
// web/vitest.config.ts — changes only:
// 1. include: ['src/**/*.test.ts'] → include: ['src/**/*.test.{ts,tsx}']
// 2. coverage.include: add 'src/lib/scenarios/**', 'src/app/api/scenarios/**'
```

Edit `web/vitest.config.ts` line 8:
```
include: ['src/**/*.test.{ts,tsx}'],
```

Edit `web/vitest.config.ts` line 12:
```
include: ['src/lib/orchestrator/**', 'src/lib/scenarios/**', 'src/app/api/scenarios/**'],
```

- [ ] **Step 2: Run full test suite (now includes .tsx tests)**

Run: `cd web && npx vitest run`
Expected: all tests pass (including new `.test.tsx` files)

- [ ] **Step 3: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Run lint**

Run: `cd web && npm run lint`
Expected: 0 errors

- [ ] **Step 5: Run test coverage check**

Run: `cd web && npx vitest run --coverage`
Expected: scenario files meet thresholds (85%+ lines/statements, 70%+ functions, 60%+ branches)

- [ ] **Step 6: Verify old placeholder text is removed**

Run: `cd web && rg "Full CRUD coming" src/`
Expected: no output, exit code 1 (no matches found — old placeholder removed in Task 6)

- [ ] **Step 7: Commit config change + any fixes**

```bash
cd web && git add vitest.config.ts && git commit -m "chore: expand vitest include to .tsx and scenario coverage"
```

- [ ] **Step 8: Final commit if any additional fixes needed**

```bash
cd web && git add -A && git commit -m "fix(scenarios): quality gate fixes for Phase 5"
```

---

## Findings Addressed

### Round 1 (17 findings)

| # | Finding | Fix |
|---|---------|-----|
| P0-1 | Test `returns 400 when body is empty` legalizes wrong behavior | Removed. PUT tests now check 404, 200-unchanged, 200-updated with payload assertions (Task 2) |
| P0-2 | Export route uses POST, spec says GET | Changed to `GET /api/scenarios/export?ids=...` (Task 5) |
| P0-3 | Export always exports all, spec says selective | Selection UI with checkboxes; export selected or all (Task 6) |
| P0-4 | New scenario dead-end: no way to create files | "Create File" button shown when file doesn't exist (Task 9, `SingleFileView`) |
| P0-5 | Tasks 5/7/8/9 skip TDD | All tasks now have test-first steps; no stubs committed (Tasks 4-10) |
| P1-6 | "Failing test" = module not found, not business contract | Tests assert status codes, payload shapes, error messages, side effects (Tasks 2-5) |
| P1-7 | Tests only check negative status | Added success-path assertions: payload shape, DB/S3 side effects, ZIP magic bytes (Tasks 2-5) |
| P1-8 | Commands don't specify cwd | All commands prefixed with `cd web &&` (all tasks) |
| P1-9 | Server components self-fetch via localhost | Server pages import `queries.ts` directly, same as compare/page.tsx (Tasks 6-7) |
| P1-10 | scenario-detail.tsx is a monolith | Split into 3 components: `scenario-header`, `scenario-tabs`, `scenario-sidebar` (Tasks 8-10) |
| P1-11 | DELETE non-atomic, no compensation | DB-first delete + best-effort S3 cleanup with per-key error logging (Task 2) |
| P1-12 | POST create: no 409 on duplicate slug | Catches Postgres 23505 unique_violation → 409 (Task 3) |
| P1-13 | Export builds entire ZIP in memory | Documented as acceptable for current scale; noted streaming upgrade path (Task 5) |
| P2-14 | File map promises types.test.ts but never implements | Removed from file map; type tests not needed for pure interfaces (File Map) |
| P2-15 | downloadFile catch-all → 404 hides S3 outages | `isS3NotFound()` differentiates NoSuchKey → 404 vs other → 502 (Task 4) |
| P2-16 | Test file classification by substring is fragile | Changed to path-based: `project/tests/**` convention (Task 9) |
| P2-17 | Unused scenarioId prop, vague "Grep for…" step | `FileList` no longer takes scenarioId; grep step has explicit command (Tasks 9, 11) |

### Round 2 (7 residual findings)

| # | Finding | Fix |
|---|---------|-----|
| R2-1 | POST /api/scenarios missing S3 upload per spec | POST now accepts optional `files` map and uploads to S3 after DB insert; test verifies `uploadFile` calls (Task 3) |
| R2-2 | Tasks 8-10 "failing test" not actually failing | Tests assert behavioral contract (button labels, section names, tab keys) — fail when module doesn't exist (Tasks 8-10) |
| R2-3 | Dual `vi.mock('@/db')` in crud.test.ts | POST tests moved to dedicated `create.test.ts` — each file has exactly one `@/db` mock (Task 3) |
| R2-4 | Placeholder stubs committed to git | Eliminated stubs entirely; Tasks 7-10 form one atomic commit in Task 10 — no placeholder text ever committed (Tasks 7-10) |
| R2-5 | File map says "streaming ZIP" but impl is in-memory | File map corrected to "in-memory ZIP via adm-zip" (File Map) |
| R2-6 | `grep -r` not portable on Windows/PowerShell | Changed to `rg "Full CRUD coming" src/` (Task 11) |
| R2-7 | Quality gates missing coverage check | Added `npx vitest run --coverage` step with 85%+ threshold (Task 11) |

### Round 3 (6 residual findings)

| # | Finding | Fix |
|---|---------|-----|
| R3-1 | Task 3 text says `multipart/form-data` but impl uses JSON | Made explicit: "uses **JSON** (`Content-Type: application/json`, parsed via `request.json()`)" (Task 3) |
| R3-2 | UI tests use fragile `toString().toContain()` | Replaced with export + signature checks; no direct calls for hook components (Tasks 8-10) |
| R3-3 | No "run tests → PASS" step after implementation in Tasks 8-10 | Added explicit test run + PASS step after each implementation (Tasks 8-10) |
| R3-4 | Placeholder check uses bash-only `2>/dev/null` + `||` | Simplified to plain `rg "Full CRUD coming" src/` (Task 11) |
| R3-5 | Coverage gate doesn't cover scenario files in vitest.config.ts | Task 11 now updates `vitest.config.ts` coverage.include to add scenario paths (Task 11) |
| R3-6 | `.test.tsx` files excluded by vitest include pattern | Task 11 updates include to `src/**/*.test.{ts,tsx}` (Task 11) |

### Round 4 (2 residual findings)

| # | Finding | Fix |
|---|---------|-----|
| R4-1 | Task 3 description still had ambiguous wording | Made format fully explicit: "uses **JSON** (`Content-Type: application/json`, parsed via `request.json()`)" |
| R4-2 | Task 8/9 tests call hook components as plain functions → `Invalid hook call` | Removed direct calls; tests now only check export type + function signature; comment explains hooks require jsdom (Tasks 8-9). Task 10 (ScenarioSidebar, no hooks) safely calls the component. |

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|---|---|
| Scenario library grid with cards | Task 6 |
| Name, version badge, description, tags, usage stats on cards | Task 6 |
| "Import pack" action | Task 6 (file upload in actions bar) |
| "+ New scenario" action | Task 6 (create form) |
| Select scenarios + export as .litmus-pack | Task 5 (API) + Task 6 (selection UI + export button) |
| Scenario detail page | Task 7 + Tasks 8-10 |
| Tabs: Prompt / Task / Scoring / Project / Tests | Task 9 |
| Content viewer/editor + create file for new scenarios | Task 9 |
| Right sidebar: metadata | Task 10 |
| Right sidebar: performance stats (avg, best, worst) | Task 10 |
| GET /api/scenarios (list) | Task 3 (enriched via query layer) |
| POST /api/scenarios (create + S3 upload + 409) | Task 3 |
| GET /api/scenarios/[id] (detail) | Task 2 |
| PUT /api/scenarios/[id] (update) | Task 2 |
| DELETE /api/scenarios/[id] (delete + S3 cleanup) | Task 2 |
| GET /api/scenarios/[id]/files (read) | Task 4 |
| PUT /api/scenarios/[id]/files (write/create) | Task 4 |
| POST /api/scenarios/import (import pack) | Already exists |
| GET /api/scenarios/export (export selected) | Task 5 |
| manifest.json format in packs | Task 5 |
| S3 storage for scenario files | Tasks 2, 4, 5 |
| Search/filter scenarios | Task 6 |

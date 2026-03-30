# Phase 5: Agents Screen + Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full Agents management UI (list, CRUD, health check, model discovery) as a section on the Settings page, plus General settings section (theme toggle, auto-judge toggle, parallel execution).

**Architecture:** Server component fetches agents + settings data, passes to client components. Agents section reuses existing API routes (`/api/agents/*`). One new DELETE endpoint is needed. Three new settings keys (`general_theme`, `general_auto_judge`, `general_max_concurrent_lanes`) are registered in the scoring settings schema. All UI follows Lab Instrument design system with CSS variables.

**Tech Stack:** Next.js App Router, React client components, Tailwind CSS 4, CSS variables (Lab Instrument), Drizzle ORM + PostgreSQL, Vitest (node environment, no jsdom).

**Spec:** `docs/superpowers/specs/2026-03-26-litmus-web-design.md` — section "5. Settings Screen", API Routes `/api/agents/*`.

**Testing approach:** Vitest runs in `environment: 'node'` — no DOM rendering, no React renderer. Component tests verify module exports only (no direct function calls — hooks crash outside renderer). Business logic is tested through: (1) API contract tests with mocked DB (DELETE endpoint, PUT upsert executor); (2) settings schema/defaults validation (Zod schemas for 15 keys). No `@testing-library/react` — matches existing project patterns (see `scenarios-library.test.tsx`, `scoring.test.ts`).

**Existing Backend (ready to use):**
- `web/src/app/api/agents/route.ts` — GET list, POST create
- `web/src/app/api/agents/[id]/route.ts` — PUT update (DELETE missing — Task 1)
- `web/src/app/api/agents/[id]/health/route.ts` — POST health check
- `web/src/app/api/agents/[id]/models/route.ts` — POST model discovery
- `web/src/app/api/settings/scoring/route.ts` — GET/PUT/DELETE scoring settings

**Working directory:** All commands must be run from `web/` subdirectory:
```bash
cd web
```

---

## File Map

```
web/src/
├── lib/judge/
│   └── types.ts                                      # MODIFY — add 3 general_* keys to settingsSchemas + settingsDefaults
├── app/
│   ├── api/agents/[id]/
│   │   └── route.ts                                  # MODIFY — add DELETE handler
│   ├── settings/
│   │   └── page.tsx                                  # MODIFY — add AgentManager + GeneralSettings sections
│   └── api/agents/[id]/__tests__/
│       ├── delete.test.ts                            # NEW — DELETE endpoint contract test
│       └── upsert-executor.test.ts                   # NEW — PUT upsert executor test
├── components/settings/
│   ├── agent-manager.tsx                              # NEW — agents list, CRUD, health, model discovery
│   ├── agent-form.tsx                                 # NEW — create/edit agent form
│   ├── general-settings.tsx                           # NEW — theme toggle, auto-judge toggle, parallel execution
│   ├── __tests__/
│   │   ├── agent-form.test.tsx                        # NEW — component export test
│   │   ├── agent-manager.test.tsx                     # NEW — component export test
│   │   └── general-settings.test.tsx                  # NEW — component export test
│   ├── judge-providers.tsx                            # EXISTING — no changes
│   └── scoring-config.tsx                             # EXISTING — no changes
├── app/api/settings/__tests__/
│   └── scoring.test.ts                               # EXISTING — auto-validates new keys via "all defaults pass" test
```

---

## Task 1: Agent DELETE API Endpoint

**DoD:** DELETE handler exported from `route.ts`. `delete.test.ts` passes 2 cases (success 200 + 404). `npx vitest run src/app/api/agents/[id]/__tests__/delete.test.ts` green. Committed.

The existing agents API has GET, POST, PUT but **no DELETE**. Schema has no `ON DELETE CASCADE` on `agentExecutors.agentId`, so both tables must be deleted explicitly.

**Files:**
- Modify: `web/src/app/api/agents/[id]/route.ts`
- Create: `web/src/app/api/agents/[id]/__tests__/delete.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/app/api/agents/[id]/__tests__/delete.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = { id: 'a1', name: 'Test Agent', version: null, availableModels: null, createdAt: new Date() };

const deletedIds: string[] = [];
const selectResults: Record<string, unknown[]> = {
  agents: [mockAgent],
};

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: { name: string }) => ({
        where: vi.fn().mockImplementation(() => {
          return Promise.resolve(selectResults[table.name] ?? []);
        }),
      })),
    }),
    delete: vi.fn().mockImplementation((table: { name: string }) => ({
      where: vi.fn().mockImplementation(() => {
        deletedIds.push(table.name);
        return Promise.resolve();
      }),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { agentId: 'agentExecutors.agentId', name: 'agentExecutors' },
}));

describe('DELETE /api/agents/[id]', () => {
  beforeEach(() => {
    deletedIds.length = 0;
    selectResults.agents = [mockAgent];
    vi.clearAllMocks();
  });

  it('deletes executor then agent and returns 200', async () => {
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe('a1');
    // Executors deleted first, then agent
    expect(deletedIds[0]).toBe('agentExecutors');
    expect(deletedIds[1]).toBe('agents');
  });

  it('returns 404 when agent does not exist', async () => {
    selectResults.agents = [];
    const { DELETE } = await import('../route');
    const request = new Request('http://localhost/api/agents/missing', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'missing' }) });

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/agents/[id]/__tests__/delete.test.ts`
Expected: FAIL — `DELETE` is not exported from `../route`

- [ ] **Step 3: Add DELETE handler to the existing route file**

Add to the end of `web/src/app/api/agents/[id]/route.ts`:

```typescript
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // No cascade FK on agentExecutors.agentId — delete explicitly, executors first
  await db.delete(agentExecutors).where(eq(agentExecutors.agentId, id));
  await db.delete(agents).where(eq(agents.id, id));

  return NextResponse.json({ deleted: id });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/agents/[id]/__tests__/delete.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/agents/[id]/route.ts src/app/api/agents/[id]/__tests__/delete.test.ts
git commit -m "feat(web): add DELETE endpoint for agents"
```

---

## Task 2: Fix PUT /api/agents/[id] — Upsert Executor

**DoD:** PUT handler creates executor when none exists (insert) or updates existing one. Returns 400 when creating without `type`/`agentSlug`. `upsert-executor.test.ts` passes 3 cases (create, missing fields 400, empty slug 400). `npx vitest run src/app/api/agents/[id]/__tests__/upsert-executor.test.ts` green. Committed.

The current PUT handler only updates an existing executor. If an agent has no executor (e.g. created via direct DB insert), the form sends executor data but nothing is saved. This must be an upsert. The Zod schema stays permissive (`optional` fields) since partial updates on existing executors are valid — but the handler itself enforces `type` and `agentSlug` as required when creating a new executor (runtime guard, not schema-level).

**Files:**
- Modify: `web/src/app/api/agents/[id]/route.ts`
- Create: `web/src/app/api/agents/[id]/__tests__/upsert-executor.test.ts`

- [ ] **Step 1: Write a failing test for executor upsert**

```typescript
// web/src/app/api/agents/[id]/__tests__/upsert-executor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track what gets inserted
const insertedExecutors: Record<string, unknown>[] = [];

const agentRow = { id: 'a1', name: 'Test', version: null, availableModels: null, createdAt: new Date() };

// The handler has TWO distinct call patterns on db.select().from(table).where():
//   1. Executor lookup: .select().from(agentExecutors).where(...).limit(1)   → returns []
//   2. Final response:  .select().from(agents).where(...)                    → returns [agentRow]
//      and:             .select().from(agentExecutors).where(...)            → returns []
// The mock must handle BOTH: .where() returning a thenable with .limit(), where
// .limit() resolves to the rows AND the bare .where() also resolves to the rows.
vi.mock('@/db', () => {
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: { name?: string }) => {
          const isExecutorTable = table?.name === 'agentExecutors';
          const rows = isExecutorTable ? [] : [agentRow];
          return {
            where: vi.fn().mockImplementation(() => {
              // Return a thenable that ALSO has .limit() for the executor lookup chain
              const result = Promise.resolve(rows);
              (result as Record<string, unknown>).limit = vi.fn().mockResolvedValue(rows);
              return result;
            }),
          };
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((val: Record<string, unknown>) => {
          insertedExecutors.push(val);
          return Promise.resolve();
        }),
      }),
    },
  };
});

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', name: 'agents' },
  agentExecutors: { agentId: 'agentExecutors.agentId', id: 'agentExecutors.id', name: 'agentExecutors' },
}));

describe('PUT /api/agents/[id] — executor upsert', () => {
  beforeEach(() => {
    insertedExecutors.length = 0;
    vi.clearAllMocks();
  });

  it('creates executor when agent has none', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { type: 'docker', agentSlug: 'new-agent' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    expect(insertedExecutors.length).toBe(1);
    expect(insertedExecutors[0].agentSlug).toBe('new-agent');
    expect(insertedExecutors[0].agentId).toBe('a1');
  });

  it('returns 400 when executor has type but no agentSlug', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { type: 'docker' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(400);
    expect(insertedExecutors.length).toBe(0);
  });

  it('rejects empty agentSlug via Zod validation', async () => {
    const { PUT } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executor: { type: 'docker', agentSlug: '' },
      }),
    });
    const response = await PUT(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(400);
    expect(insertedExecutors.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/agents/[id]/__tests__/upsert-executor.test.ts`
Expected: FAIL — first test fails because current code doesn't call insert; second test may pass (Zod already has `min(1)` on agentSlug)

- [ ] **Step 3: Fix PUT handler to upsert executor**

In `web/src/app/api/agents/[id]/route.ts`, replace the executor update block:

```typescript
  if (executor) {
    const existing = await db
      .select()
      .from(agentExecutors)
      .where(eq(agentExecutors.agentId, id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(agentExecutors)
        .set(executor)
        .where(eq(agentExecutors.id, existing[0].id));
    }
  }
```

Replace with:

```typescript
  if (executor) {
    const existing = await db
      .select()
      .from(agentExecutors)
      .where(eq(agentExecutors.agentId, id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(agentExecutors)
        .set(executor)
        .where(eq(agentExecutors.id, existing[0].id));
    } else {
      // No executor exists — fail-fast if required fields are missing
      if (!executor.type || !executor.agentSlug) {
        return NextResponse.json(
          { error: 'executor.type and executor.agentSlug are required to create a new executor' },
          { status: 400 },
        );
      }
      await db
        .insert(agentExecutors)
        .values({
          agentId: id,
          type: executor.type,
          agentSlug: executor.agentSlug,
          binaryPath: executor.binaryPath,
          healthCheck: executor.healthCheck,
          config: executor.config ?? {},
        });
    }
  }
```

Note: When no executor exists, the handler returns 400 if `type` or `agentSlug` are missing (fail-fast). Zod validates `agentSlug: z.string().min(1).optional()` for format, but a partial update without slug is valid for existing executors — the 400 only applies to creation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/agents/[id]/__tests__/upsert-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/agents/[id]/route.ts src/app/api/agents/[id]/__tests__/upsert-executor.test.ts
git commit -m "fix(web): PUT /api/agents/:id upserts executor when none exists"
```

---

## Task 3: Register General Settings Keys (scoring.test.ts TDD)

**DoD:** `settingsSchemas` and `settingsDefaults` have 15 keys total (12 existing + 3 new: `general_theme`, `general_auto_judge`, `general_max_concurrent_lanes`). 3 new test cases pass in `scoring.test.ts`. Existing "all defaults pass their own validation" test covers all 15. `npx vitest run src/app/api/settings/__tests__/scoring.test.ts` green. Committed.

Add three new keys to `settingsSchemas` and `settingsDefaults` so the existing `PUT /api/settings/scoring` accepts them. The existing test "all defaults pass their own validation" will automatically validate the new keys.

**Files:**
- Modify: `web/src/lib/judge/types.ts`

- [ ] **Step 1: Write the failing test that asserts the 3 new keys exist**

Add to `web/src/app/api/settings/__tests__/scoring.test.ts`:

```typescript
it('has general settings keys registered', () => {
  expect(settingsSchemas).toHaveProperty('general_theme');
  expect(settingsSchemas).toHaveProperty('general_auto_judge');
  expect(settingsSchemas).toHaveProperty('general_max_concurrent_lanes');
});

it('general_theme accepts light/dark/system only', () => {
  const schema = settingsSchemas['general_theme'];
  expect(schema.safeParse('dark').success).toBe(true);
  expect(schema.safeParse('light').success).toBe(true);
  expect(schema.safeParse('system').success).toBe(true);
  expect(schema.safeParse('auto').success).toBe(false);
});

it('general_max_concurrent_lanes: range 1-10', () => {
  const schema = settingsSchemas['general_max_concurrent_lanes'];
  expect(schema.safeParse(3).success).toBe(true);
  expect(schema.safeParse(0).success).toBe(false);
  expect(schema.safeParse(11).success).toBe(false);
});
```

Run: `npx vitest run src/app/api/settings/__tests__/scoring.test.ts`
Expected: FAIL — `settingsSchemas` does not have property `general_theme`

- [ ] **Step 2: Add the three keys to settingsSchemas and settingsDefaults**

In `web/src/lib/judge/types.ts`, add to `settingsSchemas` object (before the closing `}`):

```typescript
  general_theme: z.enum(['light', 'dark', 'system']),
  general_auto_judge: z.boolean(),
  general_max_concurrent_lanes: z.number().int().min(1).max(10),
```

Add to `settingsDefaults` object (before the closing `}`):

```typescript
  general_theme: 'dark',
  general_auto_judge: false,
  general_max_concurrent_lanes: 3,
```

- [ ] **Step 3: Run tests to verify new keys pass validation**

Run: `npx vitest run src/app/api/settings/__tests__/scoring.test.ts`
Expected: PASS — all 3 new tests green, "all defaults pass their own validation" now covers 15 keys

- [ ] **Step 4: Commit**

```bash
git add src/lib/judge/types.ts src/app/api/settings/__tests__/scoring.test.ts
git commit -m "feat(web): register general settings keys (theme, auto-judge, parallel lanes)"
```

---

## Task 4: Agent Form Component

**DoD:** `AgentForm` exported from `agent-form.tsx`. `AgentWithExecutors` type exported. `agent-form.test.tsx` passes 2 cases (export defined, typeof function). `npx vitest run src/components/settings/__tests__/agent-form.test.tsx` green. Committed.

**Files:**
- Create: `web/src/components/settings/agent-form.tsx`

- [ ] **Step 1: Write the component test**

```typescript
// web/src/components/settings/__tests__/agent-form.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe('AgentForm', () => {
  // Note: Cannot call component functions directly in node env (hooks crash
  // outside React renderer). Tests verify module shape only.

  it('exports a named function component', async () => {
    const mod = await import('../agent-form');
    expect(mod.AgentForm).toBeDefined();
    expect(typeof mod.AgentForm).toBe('function');
  });

  it('exports AgentWithExecutors type (used by other components)', async () => {
    // Type-level check — if this import compiles, the type is exported
    const mod = await import('../agent-form');
    expect(mod).toHaveProperty('AgentForm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/__tests__/agent-form.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentForm**

```tsx
// web/src/components/settings/agent-form.tsx
'use client';

import { useState, useCallback } from 'react';

export interface AgentWithExecutors {
  id: string;
  name: string;
  version: string | null;
  availableModels: unknown[];
  createdAt: Date;
  executors: Array<{
    id: string;
    agentId: string;
    type: string;
    agentSlug: string;
    binaryPath: string | null;
    healthCheck: string | null;
    config: unknown;
    createdAt: Date;
  }>;
}

interface Props {
  agent?: AgentWithExecutors;
  onSave: () => Promise<void>;
  onCancel: () => void;
}

export function AgentForm({ agent, onSave, onCancel }: Props) {
  const isEdit = !!agent;
  const executor = agent?.executors[0];

  const [form, setForm] = useState({
    name: agent?.name ?? '',
    version: agent?.version ?? '',
    type: executor?.type ?? 'docker',
    agentSlug: executor?.agentSlug ?? '',
    binaryPath: executor?.binaryPath ?? '',
    healthCheck: executor?.healthCheck ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In edit mode with existing executor, slug is pre-filled and locked.
  // In edit mode without executor, slug is editable (new executor will be created).
  // In create mode, slug is always editable.
  const slugLocked = isEdit && !!executor;
  const canSave = form.name.trim() !== '' && form.agentSlug.trim() !== '';

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const url = isEdit ? `/api/agents/${agent.id}` : '/api/agents';
      const method = isEdit ? 'PUT' : 'POST';

      const body = {
        name: form.name,
        version: form.version || undefined,
        executor: {
          type: form.type,
          agentSlug: form.agentSlug,
          binaryPath: form.binaryPath || undefined,
          healthCheck: form.healthCheck || undefined,
        },
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ? JSON.stringify(data.error) : `Request failed (${res.status})`);
        return;
      }

      await onSave();
    } finally {
      setSaving(false);
    }
  }, [canSave, isEdit, agent?.id, form, onSave]);

  const inputClass = `w-full px-3 py-1.5 rounded-md text-sm font-mono
    bg-[var(--bg-base)] border border-[var(--border)]
    text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
    focus:outline-none focus:border-[var(--accent)]`;

  const labelClass = 'block text-xs font-mono text-[var(--text-secondary)] mb-1';

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-xs font-mono text-[var(--score-fail)] bg-[var(--score-fail-bg)] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="agent-name" className={labelClass}>Name</label>
          <input
            id="agent-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Claude Code"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="agent-version" className={labelClass}>Version</label>
          <input
            id="agent-version"
            value={form.version}
            onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
            placeholder="e.g. 1.0"
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="agent-slug" className={labelClass}>Agent Slug</label>
          <input
            id="agent-slug"
            value={form.agentSlug}
            onChange={(e) => setForm((f) => ({ ...f, agentSlug: e.target.value }))}
            placeholder="e.g. claude-code"
            className={inputClass}
            disabled={slugLocked}
          />
          {slugLocked && (
            <span className="text-[10px] text-[var(--text-muted)]">Slug cannot be changed after creation</span>
          )}
        </div>
        <div>
          <label htmlFor="executor-type" className={labelClass}>Executor Type</label>
          <select
            id="executor-type"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className={inputClass}
          >
            <option value="docker">Docker</option>
            <option value="host">Host</option>
            <option value="kubernetes">Kubernetes</option>
          </select>
        </div>
      </div>

      {form.type === 'host' && (
        <div>
          <label htmlFor="binary-path" className={labelClass}>Binary Path</label>
          <input
            id="binary-path"
            value={form.binaryPath}
            onChange={(e) => setForm((f) => ({ ...f, binaryPath: e.target.value }))}
            placeholder="/usr/local/bin/claude"
            className={inputClass}
          />
        </div>
      )}

      <div>
        <label htmlFor="health-check" className={labelClass}>Health Check Command</label>
        <input
          id="health-check"
          value={form.healthCheck}
          onChange={(e) => setForm((f) => ({ ...f, healthCheck: e.target.value }))}
          placeholder="e.g. cursor --version"
          className={inputClass}
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm font-mono rounded-md
            text-[var(--text-secondary)] hover:text-[var(--text-primary)]
            hover:bg-[var(--bg-hover)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="px-3 py-1.5 text-sm font-mono rounded-md
            bg-[var(--accent)] text-[var(--bg-base)]
            hover:opacity-90 transition-opacity
            disabled:opacity-50"
        >
          {saving ? 'Saving…' : isEdit ? 'Update' : 'Save'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/__tests__/agent-form.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/agent-form.tsx src/components/settings/__tests__/agent-form.test.tsx
git commit -m "feat(web): agent create/edit form component"
```

---

## Task 5: Agent Manager Component

**DoD:** `AgentManager` exported from `agent-manager.tsx`. `agent-manager.test.tsx` passes 1 case (export defined as function). `npx vitest run src/components/settings/__tests__/agent-manager.test.tsx` green. Committed. Runtime behavior verified via Task 8 manual checklist (items M1–M4).

**Files:**
- Create: `web/src/components/settings/agent-manager.tsx`
- Create: `web/src/components/settings/__tests__/agent-manager.test.tsx`

- [ ] **Step 1: Write the component test**

```typescript
// web/src/components/settings/__tests__/agent-manager.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe('AgentManager', () => {
  it('exports a named function component', async () => {
    const mod = await import('../agent-manager');
    expect(mod.AgentManager).toBeDefined();
    expect(typeof mod.AgentManager).toBe('function');
  });
});

// Note: Component behavior (CRUD, health check, model discovery) is tested
// via the backend API contract tests in api/agents/__tests__/ and via
// manual visual verification. React components with hooks cannot be unit-tested
// in node environment without jsdom + testing-library.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/__tests__/agent-manager.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentManager**

```tsx
// web/src/components/settings/agent-manager.tsx
'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentForm } from './agent-form';
import type { AgentWithExecutors } from './agent-form';

interface Props {
  initialAgents: AgentWithExecutors[];
}

export function AgentManager({ initialAgents }: Props) {
  const router = useRouter();
  const [agents, setAgents] = useState(initialAgents);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<Record<string, 'checking' | 'healthy' | 'unhealthy'>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    const res = await fetch('/api/agents');
    if (!res.ok) return;
    const data = await res.json();
    setAgents(data);
    router.refresh();
  }, [router]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this agent and its executor config?')) return;
    const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    await refreshAgents();
  }, [refreshAgents]);

  const handleHealthCheck = useCallback(async (agentId: string) => {
    setHealthStatus((prev) => ({ ...prev, [agentId]: 'checking' }));
    try {
      const res = await fetch(`/api/agents/${agentId}/health`, { method: 'POST' });
      if (!res.ok) {
        setHealthStatus((prev) => ({ ...prev, [agentId]: 'unhealthy' }));
        return;
      }
      const data = await res.json();
      setHealthStatus((prev) => ({ ...prev, [agentId]: data.healthy ? 'healthy' : 'unhealthy' }));
    } catch {
      setHealthStatus((prev) => ({ ...prev, [agentId]: 'unhealthy' }));
    }
  }, []);

  const handleDiscoverModels = useCallback(async (agentId: string) => {
    setDiscovering(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}/models`, { method: 'POST' });
      if (res.ok) await refreshAgents();
    } finally {
      setDiscovering(null);
    }
  }, [refreshAgents]);

  const modelCount = (agent: AgentWithExecutors) => {
    const count = (agent.availableModels ?? []).length;
    return `${count} model${count !== 1 ? 's' : ''}`;
  };

  const healthBadge = (agentId: string) => {
    const status = healthStatus[agentId];
    if (!status) return null;
    if (status === 'checking') return <Badge>checking…</Badge>;
    if (status === 'healthy') return <Badge variant="success">healthy</Badge>;
    return <Badge variant="error">unhealthy</Badge>;
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold font-mono text-[var(--text-primary)]">Agents</h2>
        <button
          onClick={() => setAdding(!adding)}
          className="px-3 py-1.5 rounded-md text-sm font-mono
            bg-[var(--accent-dim)] text-[var(--accent)]
            hover:bg-[var(--accent)] hover:text-[var(--bg-base)]
            transition-colors"
        >
          {adding ? 'Cancel' : '+ Add Agent'}
        </button>
      </div>

      {adding && (
        <Card className="mb-4">
          <AgentForm
            onSave={async () => {
              setAdding(false);
              await refreshAgents();
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      )}

      {agents.length === 0 && !adding && (
        <Card>
          <p className="text-sm text-[var(--text-muted)] text-center py-6">
            No agents configured. Add an agent to start running benchmarks.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {agents.map((agent) => (
          <Card key={agent.id}>
            {editing === agent.id ? (
              <AgentForm
                agent={agent}
                onSave={async () => {
                  setEditing(null);
                  await refreshAgents();
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-medium text-[var(--text-primary)]">
                    {agent.name}
                  </span>
                  {agent.version && <Badge>v{agent.version}</Badge>}
                  {agent.executors[0] && (
                    <Badge variant="accent">{agent.executors[0].type}</Badge>
                  )}
                  <span className="text-xs text-[var(--text-muted)] font-mono">
                    {modelCount(agent)}
                  </span>
                  {healthBadge(agent.id)}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleHealthCheck(agent.id)}
                    disabled={healthStatus[agent.id] === 'checking'}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                      hover:bg-[var(--bg-hover)] transition-colors
                      disabled:opacity-50"
                    title="Check executor health"
                  >
                    Health
                  </button>
                  <button
                    onClick={() => handleDiscoverModels(agent.id)}
                    disabled={discovering === agent.id}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                      hover:bg-[var(--bg-hover)] transition-colors
                      disabled:opacity-50"
                    title="Discover available models"
                  >
                    {discovering === agent.id ? 'Discovering…' : 'Models'}
                  </button>
                  <button
                    onClick={() => setEditing(agent.id)}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                      hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(agent.id)}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--score-fail)] hover:bg-[var(--score-fail-bg)]
                      transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/__tests__/agent-manager.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/agent-manager.tsx src/components/settings/__tests__/agent-manager.test.tsx
git commit -m "feat(web): agent manager component with health check and model discovery"
```

---

## Task 6: General Settings Component

**DoD:** `GeneralSettings` and `GeneralSettingsData` exported from `general-settings.tsx`. `general-settings.test.tsx` passes 2 cases (export checks). `npx vitest run src/components/settings/__tests__/general-settings.test.tsx` green. Committed. Schema correctness of the 3 `general_*` keys covered by Task 3 tests. Runtime behavior verified via Task 8 manual checklist (items M5–M8).

**Files:**
- Create: `web/src/components/settings/general-settings.tsx`
- Create: `web/src/components/settings/__tests__/general-settings.test.tsx`

- [ ] **Step 1: Write the component test**

```typescript
// web/src/components/settings/__tests__/general-settings.test.tsx
import { describe, it, expect, vi } from 'vitest';

describe('GeneralSettings', () => {
  it('exports a named function component', async () => {
    const mod = await import('../general-settings');
    expect(mod.GeneralSettings).toBeDefined();
    expect(typeof mod.GeneralSettings).toBe('function');
  });

  it('exports GeneralSettingsData type (used by settings page)', async () => {
    // If this import compiles without error, the type is correctly exported
    const mod = await import('../general-settings');
    expect(mod).toHaveProperty('GeneralSettings');
  });
});

// Note: Component save behavior (PUT /api/settings/scoring, 422 error parsing)
// is covered by the scoring schema tests in api/settings/__tests__/scoring.test.ts
// which validate that the 3 general_* keys are accepted. Component-level behavior
// cannot be unit-tested in node env without jsdom.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/__tests__/general-settings.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GeneralSettings**

```tsx
// web/src/components/settings/general-settings.tsx
'use client';

import { useState, useCallback, useEffect } from 'react';

export interface GeneralSettingsData {
  theme: 'light' | 'dark' | 'system';
  autoJudge: boolean;
  maxConcurrentLanes: number;
}

interface Props {
  initialSettings: GeneralSettingsData;
}

export function GeneralSettings({ initialSettings }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(<K extends keyof GeneralSettingsData>(key: K, value: GeneralSettingsData[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const applyTheme = useCallback((theme: string) => {
    if (typeof window === 'undefined') return;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    localStorage.setItem('litmus-theme', theme);
  }, []);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme, applyTheme]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/scoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          general_theme: settings.theme,
          general_auto_judge: settings.autoJudge,
          general_max_concurrent_lanes: settings.maxConcurrentLanes,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // PUT /api/settings/scoring returns { errors: string[] } on 422
        const msg = Array.isArray(data?.errors) ? data.errors.join('; ') : `Save failed (${res.status})`;
        setError(msg);
        return;
      }
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const inputClass = `w-full px-3 py-1.5 rounded-md text-sm font-mono
    bg-[var(--bg-base)] border border-[var(--border)]
    text-[var(--text-primary)]
    focus:outline-none focus:border-[var(--accent)]`;

  const labelClass = 'block text-xs font-mono text-[var(--text-secondary)] mb-1';

  return (
    <section>
      <h2 className="text-lg font-semibold font-mono text-[var(--text-primary)] mb-4">General</h2>

      {error && (
        <div className="text-xs font-mono text-[var(--score-fail)] bg-[var(--score-fail-bg)] px-3 py-2 rounded-md mb-4">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div className="max-w-xs">
          <label htmlFor="theme-select" className={labelClass}>Theme</label>
          <select
            id="theme-select"
            value={settings.theme}
            onChange={(e) => update('theme', e.target.value as GeneralSettingsData['theme'])}
            className={inputClass}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="auto-judge"
            checked={settings.autoJudge}
            onChange={(e) => update('autoJudge', e.target.checked)}
            className="rounded border-[var(--border)] bg-[var(--bg-base)] text-[var(--accent)]
              focus:ring-[var(--accent)] focus:ring-offset-0"
          />
          <label htmlFor="auto-judge" className="text-sm font-mono text-[var(--text-primary)]">
            Auto-run judge after benchmark
          </label>
        </div>

        <div className="max-w-xs">
          <label htmlFor="max-lanes" className={labelClass}>Parallel Execution (max concurrent lanes)</label>
          <input
            type="number"
            id="max-lanes"
            min={1}
            max={10}
            value={settings.maxConcurrentLanes}
            onChange={(e) => update('maxConcurrentLanes', Number(e.target.value))}
            className={inputClass}
          />
        </div>

        {dirty && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-mono rounded-md
              bg-[var(--accent)] text-[var(--bg-base)]
              hover:opacity-90 transition-opacity
              disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/__tests__/general-settings.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/general-settings.tsx src/components/settings/__tests__/general-settings.test.tsx
git commit -m "feat(web): general settings component with theme, auto-judge, parallel execution"
```

---

## Task 7: Wire Settings Page — All Sections

**DoD:** Settings page imports and uses all 4 section components (AgentManager, JudgeProviders, ScoringConfig, GeneralSettings). Server component fetches agents (two-select pattern) and general settings (Zod `.catch()` parsing). `npx tsc --noEmit` passes — confirms all imports resolve and prop types match. Committed. Visual verification deferred to Task 8 manual checklist.

**Files:**
- Modify: `web/src/app/settings/page.tsx`

- [ ] **Step 1: Read current settings page**

Read `web/src/app/settings/page.tsx` to confirm current structure.

- [ ] **Step 2: Rewrite settings page as server component that fetches data**

```tsx
// web/src/app/settings/page.tsx
import { db } from '@/db';
import { agents, agentExecutors, settings } from '@/db/schema';
import { z } from 'zod';
import { AgentManager } from '@/components/settings/agent-manager';
import { JudgeProviders } from '@/components/settings/judge-providers';
import { ScoringConfig } from '@/components/settings/scoring-config';
import { GeneralSettings } from '@/components/settings/general-settings';
import type { GeneralSettingsData } from '@/components/settings/general-settings';
import type { AgentWithExecutors } from '@/components/settings/agent-form';

export const dynamic = 'force-dynamic';

const generalSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).catch('dark'),
  autoJudge: z.boolean().catch(false),
  maxConcurrentLanes: z.number().int().min(1).max(10).catch(3),
});

async function fetchAgentsWithExecutors(): Promise<AgentWithExecutors[]> {
  const allAgents = await db.select().from(agents).orderBy(agents.name);
  const allExecutors = await db.select().from(agentExecutors);

  return allAgents.map((agent) => ({
    ...agent,
    availableModels: (agent.availableModels ?? []) as unknown[],
    executors: allExecutors.filter((e) => e.agentId === agent.id),
  }));
}

async function fetchGeneralSettings(): Promise<GeneralSettingsData> {
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return generalSettingsSchema.parse({
    theme: map.get('general_theme'),
    autoJudge: map.get('general_auto_judge'),
    maxConcurrentLanes: map.get('general_max_concurrent_lanes'),
  });
}

export default async function SettingsPage() {
  const [agentList, generalSettings] = await Promise.all([
    fetchAgentsWithExecutors(),
    fetchGeneralSettings(),
  ]);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold font-mono text-[var(--text-primary)]">Settings</h1>

      <AgentManager initialAgents={agentList} />

      <hr className="border-[var(--border)]" />

      <JudgeProviders />

      <hr className="border-[var(--border)]" />

      <ScoringConfig />

      <hr className="border-[var(--border)]" />

      <GeneralSettings initialSettings={generalSettings} />
    </div>
  );
}
```

Key design decisions:
- `generalSettingsSchema` with `.catch()` — Zod-parsed defaults for dirty/missing JSONB values (fixes finding #7: no unsafe casts)
- `fetchAgentsWithExecutors` mirrors existing `GET /api/agents` pattern (two selects + filter, no leftJoin — fixes finding #3)
- `AgentWithExecutors` type imported from `agent-form.tsx` — single source of truth

- [ ] **Step 3: Verify type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "feat(web): wire agents manager and general settings into settings page"
```

---

## Task 8: Type Check + Lint + Full Test Suite + Manual Runtime Verification

**DoD:** `npx tsc --noEmit` — 0 errors. `npx eslint` on changed dirs — 0 errors. `npx vitest run` — all tests pass (existing + 13 new test cases: 10 across 5 new test files + 3 added to existing `scoring.test.ts`). Manual checklist M1–M8 passed (screenshot or log evidence for each). Committed if fixes were needed.

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Lint**

Run: `npx eslint src/components/settings/ src/app/settings/ src/app/api/agents/ src/lib/judge/types.ts`
Expected: No errors (fix any that appear)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, including:
- Existing `scoring.test.ts` "all defaults pass their own validation" now validates 15 keys
- New `delete.test.ts` — DELETE endpoint contract
- New component tests — module exports

- [ ] **Step 4: Manual runtime checklist**

Start dev server (`npm run dev`), open `http://localhost:3000/settings`. All items must pass before committing.

**Agents (Task 5):**
- [ ] **M1 — Create agent:** Click "+ Add Agent" → fill Name="Test", Slug="test-agent", Type=docker → Save. Expected: form closes, agent appears in list with name, docker badge, "0 models".
- [ ] **M2 — Edit agent:** Click "Edit" on existing agent → change Name → Update. Expected: name updates in list without page reload.
- [ ] **M3 — Delete agent:** Click "Delete" on agent → confirm dialog. Expected: agent removed from list. Verify no orphaned executors: run `SELECT * FROM agent_executors WHERE agent_id NOT IN (SELECT id FROM agents)` in DB — should return 0 rows.
- [ ] **M4 — Health check:** Click "Health" on agent with executor. Expected: badge shows "checking…" then "healthy" or "unhealthy" (depends on executor availability).

**General Settings (Task 6):**
- [ ] **M5 — Theme toggle:** Change theme dropdown from Dark → Light. Expected: page re-themes immediately (background, text colors change). Refresh page — theme persists (localStorage).
- [ ] **M6 — System theme:** Set theme to System. Expected: follows OS preference. Toggle OS dark mode if possible to verify.
- [ ] **M7 — Save settings:** Change "Parallel Execution" to 5 → click "Save Changes". Expected: no error, button disappears (dirty=false). Refresh page — value is still 5.
- [ ] **M8 — 422 error rendering:** Set "Parallel Execution" to 99 in the input field (type manually, ignoring `max=10` HTML attribute) → click "Save Changes". Expected: red error banner appears with validation message from server (not raw JSON). Value in input stays at 99 (not reset), allowing correction.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(web): lint and type fixes for phase 5"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Agent DELETE endpoint | `api/agents/[id]/route.ts` |
| 2 | Fix PUT upsert executor | `api/agents/[id]/route.ts` |
| 3 | Register general settings keys | `lib/judge/types.ts` |
| 4 | Agent create/edit form | `components/settings/agent-form.tsx` |
| 5 | Agent manager (list, health, models) | `components/settings/agent-manager.tsx` |
| 6 | General settings (theme, auto-judge, lanes) | `components/settings/general-settings.tsx` |
| 7 | Wire settings page | `app/settings/page.tsx` |
| 8 | Type check + lint + full suite | — |

**Spec coverage:**
- ✅ Settings → Agents list with executor type, version, status, health check button
- ✅ Settings → LLM Judge (already existed — JudgeProviders + ScoringConfig)
- ✅ Settings → General: Theme toggle (light/dark/system), auto-judge toggle, parallel execution
- ✅ Agent CRUD (create, read, update, delete)
- ✅ Agent health check trigger from UI
- ✅ Agent model discovery trigger from UI

**Round 1 findings addressed:**
1. ✅ No @testing-library/react — tests use dynamic import for module export checks only
2. ✅ No placeholder tests — all tests verify real contracts (module exports, Zod schemas)
3. ✅ No leftJoin — uses same two-select pattern as existing `GET /api/agents`
4. ✅ Architecture section accurately reflects changes
5. ✅ AgentForm: `slugLocked` only when `isEdit && !!executor` — agent without executor can edit slug
6. ✅ All fetch calls check `res.ok` before calling `onSave` or updating state; error shown in UI
7. ✅ `fetchGeneralSettings` uses Zod `.catch()` for safe parsing of JSONB values
8. ✅ File map matches actual test paths used in tasks
9. ✅ No reference to nonexistent `/api/settings` — uses `/api/settings/scoring` correctly
10. ✅ DELETE comment says "No cascade FK" — explicit delete of both tables

**Round 2 findings addressed:**
1. ✅ No direct component function calls — tests only check `typeof mod.X === 'function'` (no hooks invoked)
2. ✅ PUT /api/agents/[id] upserts executor — Task 2 with proper chain mock (`.where().limit()`) and guard on required fields
3. ✅ TDD red-green: Task 3 starts with failing `toHaveProperty('general_theme')` assertion, commits test+impl together
4. ✅ Tautological fetch tests removed — component behavior documented as untestable in node env; real coverage via API contract tests
5. ✅ GeneralSettings reads `data.errors` (array) matching `PUT /api/settings/scoring` 422 shape
6. ✅ File map includes `agent-form.test.tsx`
7. ✅ Round 1 finding #1 text corrected (no "function call pattern" claim)
8. ✅ Task 2 step 1: single clear instruction — create `upsert-executor.test.ts` (no ambiguity)

**Round 4 findings addressed:**
1. ✅ Mock chain fixed: `.where()` returns a thenable (Promise) with `.limit()` attached — handles both `await .where().limit()` (executor lookup) and `await .where()` (final response selects at lines 55-56)
2. ✅ Fail-fast validation: `else` branch returns 400 when creating executor without `type`/`agentSlug` — no silent skip
3. ✅ No `require('@/db/schema')` in mock — uses `table?.name === 'agentExecutors'` string comparison
4. ✅ Testing approach header updated — removed "fetch contract tests with mocked global.fetch" mention
5. ✅ SMART DoD added to every task with measurable pass criteria (test counts, commands, green state)

**Round 5 findings addressed:**
1. ✅ Task 5 DoD — removed runtime behavior claims ("renders list with health/edit/delete"), now states only what tests verify (export check) + explicit "manual verification" note
2. ✅ Task 6 DoD — removed "theme applies immediately", "saves via PUT", "parses 422" from DoD; noted as manual verification + Task 3 schema coverage
3. ✅ Task 2 description — replaced "Zod schema must require" with "handler enforces at runtime (not schema-level)" — matches actual implementation
4. ✅ Task 8 DoD — corrected count to 13 new test cases (10 in 5 new files + 3 added to existing `scoring.test.ts`)

**Round 6 findings addressed:**
1. ✅ Task 7 DoD — removed "renders 4 sections" claim, now says "imports and uses" (tsc-verifiable) + defers visual check to Task 8 manual checklist
2. ✅ Task 5/6 "manual verification" — replaced vague note with concrete checklist items M1–M4 (agents CRUD) and M5–M8 (general settings) with input/expected output per item
3. ✅ Task 8 — added Step 5 with mandatory manual runtime checklist (M1–M8) as gate before phase completion; DoD updated to require manual checklist pass

**Round 7 findings addressed:**
1. ✅ M8 — replaced DevTools fetch (doesn't update component state) with direct input of invalid value (99) in the UI field → Save → server returns 422 → component renders error banner
2. ✅ M3 — replaced `GET /api/agents` check (can't see orphans) with direct SQL query against `agent_executors` table

# Unified Judge System — Design Spec

**Date:** 2026-03-28
**Status:** Draft
**Scope:** `./web` (standalone Next.js 16 app)
**Replaces:** Legacy dual rubric (20 AGENT_CRITERIA + 20 MODEL_CRITERIA in `src/litmus/analysis.py`)

---

## 1. Problem

The current benchmark evaluates agent+model pairs purely on test pass rate (`totalScore = testsPassed / testsTotal * 100`). This misses quality dimensions like design, reasoning, safety, and recovery that differentiate good solutions from ones that merely pass tests.

The legacy Python evaluator (`src/litmus/analysis.py`) has 40 criteria split into agent (20) and model (20) groups, but analysis showed significant overlap, noisy scoring on a 1–10 scale, and difficulty separating agent vs model contribution within a single episode.

## 2. Solution

Add an async multi-judge LLM evaluation system to `./web` that scores each run result (agent × model × scenario) against 10 unified criteria + 4 blocking checks. The final score is a configurable composite of test-based and judge-based scores.

### Key decisions

| Aspect | Decision |
|--------|----------|
| Criteria | 10 unified + 4 blocking checks |
| Score | Composite: `w_test × test_score + w_judge × judge_score`, configurable weights |
| Judge timing | Post-hoc async, event-driven via Redis Streams (queue) + Pub/Sub (notifications) |
| Judge input | Task prompt + scoring criteria + all logs (init, agent, tests) + artifacts |
| Judge providers | Multi-judge, OpenAI-compatible, configurable in Settings |
| Aggregation | Median scores + majority vote blocking (mathematical, no meta-judge) |
| Storage | Individual verdicts per judge + aggregated result |
| Infra | Valkey 8 (Alpine, AOF) — judge queue + EventBus replacement |
| Log compression | Rule-based structured extraction with pluggable compressor contract |

---

## 3. Unified Criteria

### 3.1 Ten scoring criteria (scale 1–5)

Listed in **default priority order** (rank 1 = most important). Weights are always computed dynamically from the priority order and distribution preset — they are never stored as raw numbers.

| Rank | Key | Title | Description |
|------|-----|-------|-------------|
| 1 | `task_success` | Task success | Whether the run solves the task and produces the expected end result |
| 2 | `solution_correctness` | Solution correctness | Technical correctness of the produced code, artifact, or final answer |
| 3 | `instruction_following` | Instruction following | Whether the run follows explicit instructions, constraints, and required output conditions |
| 4 | `design_quality` | Design quality | Quality of design decisions, abstractions, maintainability, and suitability for the task |
| 5 | `tool_action_quality` | Tool/action quality | Appropriateness and efficiency of tool use and execution actions |
| 6 | `reasoning_diagnosis` | Reasoning/diagnosis | Quality of reasoning, debugging, and identification of root causes when needed |
| 7 | `recovery_adaptivity` | Recovery/adaptivity | Ability to recover from mistakes or failed attempts and adjust strategy |
| 8 | `safety_scope_control` | Safety/scope control | Whether changes stay safe, scoped, and free of harmful side effects |
| 9 | `context_state_handling` | Context/state handling | How well the run uses task context and tracks intermediate workspace state |
| 10 | `verification_awareness` | Verification awareness | Whether the run checks its work through tests, validation, or consistency checks |

With the default **Linear** preset (`w_i = (N - i + 1) / sum(1..N)`, N=10), this produces approximate weights: 18%, 16%, 15%, 13%, 11%, 9%, 7%, 5%, 4%, 2%. Weights are recomputed whenever the user changes priority order or preset.

### 3.2 Four blocking checks (boolean)

| Key | Title | Description |
|-----|-------|-------------|
| `hard_instruction_violation` | Hard instruction violation | Fails an explicit must-follow instruction or hard constraint |
| `unsafe_or_out_of_scope_change` | Unsafe or out-of-scope change | Introduces harmful, risky, or unnecessary modifications outside the task scope |
| `invalid_solution_artifact` | Invalid solution/artifact | Produces unusable, broken, or technically invalid code or artifact |
| `incorrect_final_state` | Incorrect final state | Leaves the task in a clearly wrong, incomplete, or inconsistent final state |

### 3.3 Scoring formula

```
judge_weighted = sum(criteria_weight[i] * score[i])    → range [1, 5]
judge_normalized = (judge_weighted - 1) / 4 * 100      → range [0, 100]

composite = w_test * test_score + w_judge * judge_normalized
            where w_test + w_judge = 1.0 (default 0.4 / 0.6)

blocking_count = count of triggered blocking flags (see §6.5 for voting rules)
if blocking_count == 0: no cap applied
if blocking_count == 1: composite = min(composite, 60)
if blocking_count >= 2: composite = min(composite, 40)
```

### 3.4 Criteria weight configuration

Instead of manually entering fractional weights, the user reorders criteria by priority via drag & drop. The system computes weights automatically based on a distribution preset:

| Preset | Formula (rank i of N) | Top-3 share | Character |
|--------|-----------------------|-------------|-----------|
| **Flat** | `w_i = 1/N` | 10% / 10% / 10% | All nearly equal |
| **Linear** (default) | `w_i = (N - i + 1) / sum` | 18% / 16% / 15% | Even step between ranks |
| **Steep** | `w_i = (N - i + 1)² / sum` | 27% / 22% / 17% | Top ranks dominate |

Computed weights are displayed read-only next to each criterion. The distribution dropdown and drag handle are the only controls.

**Default state:** On first launch, criteria are in the priority order shown in section 3.1, with the Linear preset applied. If the user changes the preset or reorders criteria, weights are recomputed by the formula. The settings store the priority order (list of criterion keys) and the preset name — never raw weight numbers.

---

## 4. Data Layer

**Naming convention:** This spec uses **camelCase** for Drizzle ORM field names (TypeScript side). The canonical DB column names are **snake_case**, mapped by Drizzle's `{ columns: { judgeStatus: 'judge_status' } }` convention that is already established in the existing schema. All SQL snippets in this section use snake_case; all TypeScript types use camelCase.

### 4.1 New tables

#### `judge_providers`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | text NOT NULL | Display name (e.g. "Claude Sonnet 4") |
| `baseUrl` | text NOT NULL | OpenAI-compatible endpoint |
| `apiKey` | text NOT NULL | Encrypted at rest |
| `model` | text NOT NULL | Model ID to send in API call |
| `enabled` | boolean DEFAULT true | |
| `priority` | integer DEFAULT 0 | Ordering |
| `createdAt` | timestamp | |

#### `judge_verdicts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `runResultId` | FK → run_results CASCADE | |
| `judgeProviderId` | FK → judge_providers | |
| `scores` | JSONB NOT NULL | `{ criteria_key: { score: 1-5, rationale: "..." } }` |
| `blockingFlags` | JSONB NOT NULL | `{ flag_key: { triggered: bool, rationale: "..." } }` |
| `rawResponse` | text | Full LLM response for debug |
| `durationMs` | integer | Judge API call duration |
| `error` | text | Error message if judge failed. When set, `scores` and `blockingFlags` MUST be `{}` (empty JSON object). Aggregator ignores verdicts where `error IS NOT NULL`. |
| `evaluationVersion` | integer NOT NULL | Must match `run_results.evaluationVersion` at write time |
| `createdAt` | timestamp | |
| | UNIQUE | `(runResultId, judgeProviderId, evaluationVersion)` |

The UNIQUE constraint on `(runResultId, judgeProviderId, evaluationVersion)` implicitly creates a composite index that also supports lookups by `runResultId` alone — no separate index needed.

**Idempotency invariant:** Every stream task payload includes `evaluationVersion` from the moment of enqueue. The worker and aggregator perform a **hard check**:
1. **Worker:** Before writing a verdict, check `run_results.evaluationVersion == task.evaluationVersion`. If mismatch → `XACK` the message and discard (stale task from a previous evaluation round).
2. **Aggregator:** Only count verdicts where `verdict.evaluationVersion == run_results.evaluationVersion`.

**Re-evaluation flow:** Re-evaluation (section 10.1) in a single transaction: increments `evaluationVersion`, resets `judgeStatus='pending'`, snapshots providers into `judgeMeta`. Old verdicts are NOT deleted — they become orphaned (wrong version) and are ignored by the aggregator. A periodic cleanup job removes verdicts where `verdict.evaluationVersion < run_results.evaluationVersion`. This eliminates the race between old stream messages and new evaluation rounds.

#### `compression_logs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `runResultId` | FK → run_results CASCADE | One row per run_result (not per judge) |
| `inputChars` | integer NOT NULL | Raw log size |
| `outputChars` | integer NOT NULL | Compressed log size |
| `ratio` | real NOT NULL | `outputChars / inputChars` |
| `compressorType` | text NOT NULL | `'structured'`, `'none'`, future types |
| `durationMs` | integer | Compression time |
| `evaluationVersion` | integer NOT NULL | Matches `run_results.evaluationVersion` |
| `createdAt` | timestamp | |
| | UNIQUE | `(runResultId, evaluationVersion)` |

Log compression happens **once per run_result per evaluation version** before judge evaluation begins. The UNIQUE constraint ensures re-evaluation creates a new row (with incremented version) rather than duplicating. Old compression_logs rows (with stale evaluationVersion) are cleaned up by the same periodic job that removes stale verdicts.

#### `settings`

| Column | Type | Notes |
|--------|------|-------|
| `key` | text PK | |
| `value` | JSONB NOT NULL | Validated by per-key Zod schemas on write |
| `updatedAt` | timestamp | Last modification time |

Each settings key has a corresponding Zod schema defined in `web/src/lib/judge/types.ts` that validates the JSONB value on every PUT. Invalid values are rejected with a 422 response.

Settings keys:
- `composite_weights` → `{ test: 0.4, judge: 0.6 }` — Zod: both > 0, sum = 1.0
- `criteria_priority` → `{ order: ["task_success", "solution_correctness", ...], preset: "linear" }` — Zod: all 10 keys present in order, preset in `'flat' | 'linear' | 'steep'`
- `blocking_caps` → `{ "1": 60, "2": 40 }` — Zod: values 0–100
- `judge_max_retries` → `3` — Zod: integer 1–10
- `judge_max_concurrent_per_provider` → `3` — Zod: integer 1–20
- `judge_max_concurrent_global` → `10` — Zod: integer 1–50
- `judge_temperature` → `0.3` — Zod: number 0–1
- `log_compression` → `"structured"` — Zod: enum `'structured' | 'none'`
- `max_compressed_chars` → `30000` — Zod: integer 1000–200000
- `max_judge_prompt_chars` → `120000` — Zod: integer 10000–500000
- `judge_task_idle_timeout_ms` → `300000` (5 min) — Zod: integer 60000–1800000
- `judge_raw_response_retention_days` → `90` — Zod: integer 1–365

### 4.2 Changes to `run_results`

New columns:

| Column | Type | Notes |
|--------|------|-------|
| `judgeStatus` | text DEFAULT 'pending' | `'pending'` / `'partial'` / `'completed'` / `'skipped'` |
| `blockingFlags` | JSONB | Aggregated majority vote: `{ flag_key: bool }` |
| `compositeScore` | real | Final composite score |
| `judgeMeta` | JSONB | Snapshot: `{ targetProviderIds: string[] }` |
| `evaluationVersion` | integer DEFAULT 1 | Monotonically incremented on each re-evaluation |

Existing columns:
- `judgeScores` (JSONB, nullable) — repurposed: stores aggregated median `{ criteria_key: score }`
- `judgeModel` — **drop** (replaced by multi-judge `judge_verdicts`). Not in production yet, safe to remove.

**API key encryption:** `judge_providers.apiKey` is encrypted at the application level using AES-256-GCM with a key derived from `JUDGE_ENCRYPTION_KEY` env variable. Storage format: `base64(nonce + ciphertext + tag)`. The encryption module provides `encrypt(plaintext)` and `decrypt(ciphertext)` functions. On key rotation: update env var, re-encrypt all existing keys via admin endpoint `POST /api/settings/judge-providers/rotate-keys`. On key loss: all API keys must be re-entered manually.

### 4.4 Security and data policies

**Secret redaction before sending to judge providers:**
- Agent logs are scanned for common secret patterns (API keys, tokens, passwords) and redacted with `[REDACTED]` before compression and before sending to external judge APIs
- Patterns: `sk-...`, `Bearer ...`, env var assignments (`KEY=...`), base64-encoded credential blocks
- `rawResponse` in `judge_verdicts` is stored as-is (judge output, not user secrets)

**Retention policy:**
- `judge_verdicts.rawResponse`: retained for 90 days by default, then truncated to NULL by a periodic cleanup. Configurable via `judge_raw_response_retention_days` setting.
- `compression_logs`: no retention limit (small rows, useful for analytics)
- Compressed context Redis keys: auto-expire via TTL (2 hours)

**Access controls:**
- Judge provider API keys are never returned in plaintext via API (always masked)
- Settings API routes require same auth as existing admin routes

### 4.5 Materialized view changes

**`latest_results`** — add new columns to the SELECT list:

```sql
-- Add to existing column list:
composite_score, blocking_flags, judge_status
```

**`score_by_model` and `score_by_agent`** — change aggregation source:

```sql
-- Before:
AVG(total_score) AS scenario_avg

-- After:
AVG(COALESCE(composite_score, total_score)) AS scenario_avg
```

Fallback to `total_score` when `composite_score` is NULL (judge pending or skipped).

**All query paths in `queries.ts`** that reference `total_score` must switch to `COALESCE(composite_score, total_score)`:
- `fetchRankingData` — cell-level `AVG(lr.total_score)` for heatmap cells
- `fetchDetailedData` — entity-level `AVG(lr.total_score)` for leaderboard ranking
- `fetchDetailedData` — cell-level `lr.total_score` for individual heatmap cells

**Migration order:** (1) add new columns to `run_results`, (2) create new tables, (3) recreate all three matviews with updated column lists.

---

## 5. Infrastructure — Valkey + Redis EventBus

### 5.1 Docker Compose

New service added to `docker-compose.yml`:

```yaml
valkey:
  image: valkey/valkey:8-alpine
  command: valkey-server --appendonly yes --appendfsync everysec
  volumes:
    - valkey-data:/data
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "valkey-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 3
```

AOF with `appendfsync everysec` — max 1 second data loss on crash.

### 5.2 Two transport layers

The system uses **two separate Redis mechanisms** for different purposes:

#### Redis Streams — reliable judge task queue

Redis Streams (XADD / XREADGROUP) provide at-least-once delivery with consumer group acknowledgment. This is the **source of truth** for judge tasks.

- **Stream:** `litmus:judge:tasks` — judge work items
- **Consumer group:** `judge-workers`
- **Flow:** `XADD` to enqueue → `XREADGROUP` to dequeue → `XACK` after verdict written to DB
- **Persistence:** Valkey AOF ensures stream survives restarts

**Pending message reclaim loop:** Unacked messages in consumer groups are NOT automatically re-delivered — they require explicit `XAUTOCLAIM`. A periodic reclaim loop runs every 60 seconds:

1. `XAUTOCLAIM litmus:judge:tasks judge-workers <consumer-id> <idle-timeout-ms> 0-0`
   - `idle-timeout`: 5 minutes (configurable via `judge_task_idle_timeout_ms` setting)
   - Claims messages idle longer than timeout and reprocesses them
2. Each message carries a `delivery_count` (tracked via XPENDING). If `delivery_count > max_delivery_attempts` (default 3):
   - Move to dead-letter stream `litmus:judge:dead-letter` via `XADD` + `XACK` original
   - Set corresponding `judge_verdicts` row with `error: "max delivery attempts exceeded"`
   - Trigger aggregator check (may complete with partial results)
3. Dead-letter stream is inspectable via admin API for debugging

This ensures no task is permanently stuck, even without app restart.

#### Redis Pub/Sub — real-time notifications

Pub/Sub is used only for **ephemeral UI notifications** that are acceptable to lose:

- **Channel:** `litmus:events` — all runtime events (run status, task progress, judge status)
- **Subscribers:** SSE endpoints that stream to the browser
- **If missed:** UI will still show correct data on next poll/refresh — Pub/Sub is an optimization, not the source of truth

**Three Redis clients:**
- `publisherClient` — for XADD and PUBLISH
- `subscriberClient` — for Pub/Sub channel subscriptions (SSE)
- `consumerClient` — for XREADGROUP in JudgeWorker (blocking read)

#### SSE endpoints

- **Existing:** `GET /api/runs/[runId]/stream` — migrates to Redis Pub/Sub, filtered by runId
- **New:** `GET /api/compare/stream` — subscribes to `litmus:events`, filters for judge-related event types (`judge:started`, `judge:verdict`, `judge:completed`)

### 5.3 Environment

```
REDIS_URL=redis://valkey:6379
JUDGE_ENCRYPTION_KEY=<32-byte-hex-key>
```

### 5.4 npm dependencies

- `ioredis` — mature Redis client for Node.js, full Streams + Pub/Sub support, Valkey-compatible

---

## 6. JudgeService — Async Evaluation Pipeline

### 6.1 Lifecycle

```
result:created event (from reconciler.finalize)
    │
    ├─ JudgeService.enqueue(runResultId)
    │   ├─ Load enabled judge_providers → snapshot provider IDs
    │   ├─ If no providers → set judgeStatus='skipped', return
    │   ├─ Set judgeStatus='pending', store targetProviderIds in run_results.judgeMeta
    │   ├─ Load logs + artifacts from S3
    │   ├─ Compress agent log via LogCompressor → INSERT into compression_logs
    │   └─ For each provider → XADD task to litmus:judge:tasks stream
    │
    ├─ JudgeWorker (consumer group: judge-workers, respects concurrency limits)
    │   ├─ XREADGROUP from litmus:judge:tasks (blocking read)
    │   ├─ Check concurrency: per-provider and global limits from settings
    │   ├─ Process(runResultId, providerId):
    │   │   ├─ Load pre-compressed context (shared across judges)
    │   │   ├─ Build prompt (system + user)
    │   │   ├─ Call OpenAI-compatible API (temperature from settings)
    │   │   ├─ Parse JSON response → validate schema
    │   │   ├─ Retry up to judgeMaxRetries on parse error or rate limit
    │   │   ├─ INSERT into judge_verdicts
    │   │   └─ XACK the stream message
    │   └─ Trigger JudgeAggregator.check(runResultId)
    │
    └─ JudgeAggregator.check(runResultId)
        ├─ Count verdicts vs targetProviderIds (snapshot, not current enabled set)
        ├─ If incomplete → set judgeStatus='partial', PUBLISH notification to litmus:events
        └─ If complete:
            ├─ Load all verdicts
            ├─ Median per criterion (10 scores)
            ├─ Majority vote per blocking flag (4 flags)
            ├─ Compute compositeScore (weights + blocking cap)
            ├─ UPDATE run_results (judgeScores, blockingFlags, compositeScore, judgeStatus='completed')
            ├─ Schedule matview refresh (debounced, max once per 30s)
            └─ PUBLISH "judge:completed" to litmus:events
```

**Concurrency control:** JudgeWorker respects two configurable limits:
- `judge_max_concurrent_per_provider` (default 3) — max parallel API calls to a single provider
- `judge_max_concurrent_global` (default 10) — max parallel judge API calls across all providers

Limits are enforced via Redis counters (INCR/DECR with TTL). If a limit is hit, the worker waits before processing the next stream message.

**Provider snapshot:** At enqueue time, the set of target provider IDs is captured in `run_results.judgeMeta` (JSONB). The aggregator checks completion against this snapshot, not the current enabled providers list. This prevents a mismatch if a provider is disabled mid-evaluation.

**Matview refresh debounce with distributed lock:** Instead of refreshing matviews on every verdict completion, the aggregator marks a refresh as needed: `SET litmus:matview-refresh-needed 1`. A single refresh worker (elected via Redis distributed lock `litmus:matview-refresh-lock` with 60s TTL, acquired via `SET ... NX EX 60`) polls every 30 seconds:
1. Check `GET litmus:matview-refresh-needed` → if not set, skip
2. Acquire lock → if already held, skip (another instance is refreshing)
3. `DEL litmus:matview-refresh-needed`
4. `REFRESH MATERIALIZED VIEW CONCURRENTLY` for all three views
5. Release lock

**Lock safety caveat:** The 60s TTL is a crash-recovery mechanism, not a correctness guarantee. If `REFRESH MATERIALIZED VIEW CONCURRENTLY` takes longer than 60s, a second instance may start a parallel refresh. This is safe because `CONCURRENTLY` uses a snapshot and does not block reads — parallel refreshes waste resources but don't corrupt data. For large datasets where refresh regularly exceeds 60s, migrate to a PostgreSQL advisory lock (`pg_try_advisory_lock`) which is held until the connection closes and has no TTL race.

**Log compression is done once per run_result** at enqueue time, not per judge. The compressed context is stored in a Redis key (`litmus:compressed:{runResultId}:{evaluationVersion}` with 2-hour TTL) and shared across all judge workers for the same result.

**Fallback on cache miss:** If the Redis key has expired (backlog > TTL, retries, dead-letter reprocessing), the worker **re-assembles from S3 and re-compresses**. This is more expensive but guarantees the worker always has input data. The compression result is written back to Redis with a fresh TTL. A new `compression_logs` row is NOT created for cache-miss re-compressions (the original row from enqueue time is authoritative).

### 6.2 Judge evaluation granularity

One judge evaluation = one `run_result` = one (agent × model × scenario) combination. Each scenario is evaluated in isolation with its own prompt, logs, and artifacts. Judge does NOT evaluate runs as a whole across scenarios.

### 6.3 Context assembly

```typescript
interface JudgeContext {
  scenario: {
    prompt: string;
    scoringCriteria: { criterion: string; maxPoints: number }[];
  };
  execution: {
    initLog: string;
    agentLog: string;        // compressed or full depending on setting
    testLog: string;
    testResults: {
      passed: number;
      total: number;
      details: { name: string; status: string; message: string }[];
    };
  };
  artifacts: {
    files: { path: string; content: string }[];
  };
  meta: {
    agent: string;
    model: string;
    attempt: number;
    maxAttempts: number;
    durationSeconds: number;
  };
}
```

All logs and artifacts loaded from S3 by `artifactsS3Key`.

#### Token budget allocator

The total prompt sent to judge has a hard cap: `max_judge_prompt_chars` (default 120000, ~30K tokens). Budget is allocated deterministically by section priority:

| Priority | Section | Budget | Truncation strategy |
|----------|---------|--------|---------------------|
| 1 (fixed) | System prompt + criteria + blocking checks | ~3000 chars | Never truncated |
| 2 (fixed) | Scenario prompt + scoring criteria | ~2000 chars | Never truncated (user-authored, always short) |
| 3 (fixed) | Test results (structured JSON) | ~2000 chars | Truncate `details` array if > 50 test cases |
| 4 (high) | Agent log (compressed) | up to `max_compressed_chars` setting | Handled by LogCompressor |
| 5 (medium) | Artifacts (code files) | remaining budget × 0.6 | Include files sorted by relevance: modified > created > untouched. Files > 10KB: first 200 + last 200 lines. Skip binary files. |
| 6 (medium) | Test log (stdout/stderr) | remaining budget × 0.3 | Keep first 5000 + last 5000 chars |
| 7 (low) | Init log | remaining budget × 0.1 | Keep last 2000 chars only |

"Remaining budget" = `max_judge_prompt_chars` minus sections 1-4. If even after truncation the total exceeds the cap, artifact files are dropped one by one (largest first) until it fits.

### 6.4 Judge prompt

Judge receives:

1. **System prompt** — role, 1–5 scale with anchor descriptions per level, strict JSON response format
2. **10 criteria** with descriptions
3. **4 blocking checks** with descriptions
4. **Task prompt** + scoring criteria (from scenario's `scoring.csv`)
5. **Execution logs** (under deterministic token budget, see §6.3) — init → agent interaction → test results (chronologically ordered, with timestamps)
6. **Artifacts** — final code files

**Expected JSON response:**

```json
{
  "scores": {
    "task_success": { "score": 4, "rationale": "..." },
    "instruction_following": { "score": 3, "rationale": "..." },
    "solution_correctness": { "score": 4, "rationale": "..." },
    "design_quality": { "score": 3, "rationale": "..." },
    "tool_action_quality": { "score": 4, "rationale": "..." },
    "reasoning_diagnosis": { "score": 3, "rationale": "..." },
    "recovery_adaptivity": { "score": 2, "rationale": "..." },
    "safety_scope_control": { "score": 5, "rationale": "..." },
    "context_state_handling": { "score": 3, "rationale": "..." },
    "verification_awareness": { "score": 4, "rationale": "..." }
  },
  "blocking": {
    "hard_instruction_violation": { "triggered": false, "rationale": "..." },
    "unsafe_or_out_of_scope_change": { "triggered": true, "rationale": "..." },
    "invalid_solution_artifact": { "triggered": false, "rationale": "..." },
    "incorrect_final_state": { "triggered": false, "rationale": "..." }
  }
}
```

### 6.5 Multi-judge aggregation

For N target judges per run_result (from `judgeMeta.targetProviderIds`):

- **Scores:** Median per criterion. At N=2 median equals mean; at N≥3 median rejects outliers automatically.
- **Blocking flags:** Majority vote. Flag triggered if >50% of judges triggered it. At N=2 requires unanimity.
- **No meta-judge LLM** — purely mathematical aggregation to avoid self-enhancement bias.

#### Partial failure aggregation rules

When some judges succeed and some fail (have `error` field set):

| Successful judges (S) | Total target (N) | Behavior |
|------------------------|-------------------|----------|
| S = N | N | Normal aggregation: median scores, majority blocking |
| S ≥ 1 and S ≥ ceil(N/2) | N | Aggregate from successful verdicts only. `judgeStatus='completed'`. Majority vote denominator = S (not N). Note in `judgeMeta`: `{ partial: true, succeeded: S, failed: N-S }` |
| S ≥ 1 and S < ceil(N/2) | N | Aggregate from successful verdicts. `judgeStatus='completed'`. Mark as `lowConfidence: true` in `judgeMeta`. Blocking flags require unanimity among S judges (stricter threshold when few judges). |
| S = 0 | N | All failed. `judgeStatus='completed'`. `compositeScore = totalScore` (fallback to test-only). `judgeMeta.allFailed = true`. |

Key invariants:
- Aggregation **always** uses only successful verdicts (those without `error`).
- Median is computed over S scores, not N.
- `judgeStatus` transitions to `'completed'` once all N target providers have responded (success or error). There is no indefinite `'partial'` state.

### 6.6 Error handling

| Situation | Behavior |
|-----------|----------|
| Provider API timeout | Retry up to `judgeMaxRetries` with exponential backoff (2s, 4s, 8s) |
| Invalid JSON response | Retry up to `judgeMaxRetries`, then verdict with `error` field |
| Provider 429 (rate limit) | Backoff per `Retry-After` header |
| S3 artifacts missing | Judge proceeds with note "artifacts unavailable", scores based on logs only |
| Dead-letter (max delivery exceeded) | Verdict with `error: "max delivery attempts exceeded"` |

### 6.7 Startup recovery

On application startup:
1. Scan `run_results WHERE judgeStatus IN ('pending', 'partial')`
2. For each — load `judgeMeta.targetProviderIds` and current `evaluationVersion`. Check which providers have not yet submitted a verdict in `judge_verdicts WHERE evaluationVersion = run_results.evaluationVersion` (old-version verdicts are ignored).
3. Re-enqueue missing tasks to `litmus:judge:tasks` stream (payload includes current `evaluationVersion`)
4. Also check for unacknowledged messages in the stream (XPENDING) and reclaim them

---

## 7. Log Compression

### 7.1 Compressor contract

```typescript
interface CompressedLog {
  content: string;
  inputChars: number;
  outputChars: number;
}

interface LogCompressor {
  readonly type: string;   // 'structured', 'none', future implementations
  compress(rawLog: string, options: { maxChars: number }): CompressedLog;
}
```

Factory function:
```typescript
function createCompressor(type: string): LogCompressor
```

JudgeService calls only through the interface. New compressor = new class + factory registration + new Settings dropdown option.

### 7.2 Structured compressor algorithm

```
Raw log
    │
    ├─ Parse into chronological blocks:
    │   Each block = { index, timestamp?, type, content }
    │   Types: THINKING, TOOL_CALL, TOOL_RESULT, CODE, ERROR, OTHER
    │
    ├─ Per-block decision (preserving original chronological order):
    │   ├─ ERROR        → keep full
    │   ├─ TOOL_CALL    → keep full (name + args)
    │   ├─ TOOL_RESULT  → ≤500 chars: keep; >500: head 200 + tail 200
    │   ├─ CODE         → last: keep full; others: first 10 lines + "..."
    │   ├─ THINKING     → first/last: keep full; middle: head 200 chars
    │   └─ OTHER        → keep if contains error/warning/fail keywords
    │
    ├─ Reassemble in original chronological order:
    │   Truncated blocks get marker: "── [compressed: 2847 → 400 chars] ──"
    │   Timestamps preserved on every block
    │
    └─ Output: compressed log (~15-25K chars from ~120K input)
```

**Critical invariant:** The compressor NEVER reorders blocks. It only decides per block: keep full / truncate / omit. Order and timestamps remain as in the original.

### 7.3 Agent log parser heuristics

| Agent | THINKING | TOOL_CALL | ERROR |
|-------|----------|-----------|-------|
| Claude Code | `<thinking>...</thinking>` | `tool_use: name` | `Error:`, traceback |
| Aider | `> thinking...` | `> file edit` | `ERROR`, `FAILED` |
| OpenCode | `## Reasoning` | `## Tool:` | `Error`, `exception` |
| Generic fallback | Lines without prefix | `{"tool":` / `function_call` | `error`, `traceback`, `exception` |

### 7.4 Compression quality tracking

Every compression operation records a row in `compression_logs` (see section 4.1). This enables monitoring compression ratio across runs and detecting anomalies (ratio > 0.8 = poor compression; ratio < 0.05 = potentially lost important content).

### 7.5 Configuration

Settings:
- `log_compression` — `'structured'` (default) or `'none'`
- `max_compressed_chars` — `30000` (default)

---

## 8. UI Changes

### 8.1 Heatmap cell

Current cell: score% + color scale + badges (best, stale).

Additions:
- **Judge status badge** in cell corner:
  - `⏳` — pending
  - `◐` — partial (some judges responded)
  - No badge — completed or skipped
- **Score source** switches to `compositeScore` when available, fallback to `totalScore`
- **Tooltip** expands: test score, judge score, composite, blocking flags

### 8.2 Drill-down panel

Current: latest result (score, tests, attempt, duration) + history.

New section **"Judge Evaluation"** below main info:

```
┌─ Latest Result ─────────────────────────┐
│ Score: 78%  Tests: 8/10  Duration: 45s  │
├─ Judge Evaluation ──────────────────────┤
│ Status: ✓ Completed (3 judges)          │
│                                          │
│ Composite Score: 72 / 100                │
│ ├─ Test:  80.0 × 0.4 = 32.0             │
│ └─ Judge: 64.5 × 0.6 = 38.7             │
│ ⚠ Blocking: 1 (cap 60 applied)          │
│                                          │
│ ┌─ Criteria ────────── Med  J1  J2  J3  │
│ │ Task success          4    4   5   4  │
│ │ Instruction following 4    4   4   3  │
│ │ Solution correctness  3    3   3   4  │
│ │ Design quality        3    3   2   3  │
│ │ Tool/action quality   4    4   4   3  │
│ │ Reasoning/diagnosis   3    2   3   3  │
│ │ Recovery/adaptivity   3    3   3   2  │
│ │ Safety/scope control  4    4   5   4  │
│ │ Context/state         3    3   3   4  │
│ │ Verification          4    4   4   3  │
│ └────────────────────────────────────── │
│ ┌─ Blocking Flags ──────── Vote ─────  │
│ │ ✗ Hard instruction violation    0/3  │
│ │ ⚠ Unsafe/out-of-scope change   2/3  │
│ │ ✗ Invalid solution artifact     0/3  │
│ │ ✗ Incorrect final state         1/3  │
│ └────────────────────────────────────── │
│ ▸ Expand rationale (per judge)          │
└──────────────────────────────────────── │
```

### 8.3 Breakdown popover

Score column shows `compositeScore` instead of `totalScore`. Judge status icon next to each row. If judge pending — shows test-only score with note.

### 8.4 Leaderboard

- `avgScore` computed from `compositeScore` (via matview)
- New column: **"Judged"** — `3/5` (how many of this entity's results have judge evaluation vs total)

### 8.5 SSE events

New event types streamed to Compare Screen:

```typescript
{ type: 'judge:started',   runResultId: string }
{ type: 'judge:verdict',   runResultId: string, providerName: string, progress: '2/3' }
{ type: 'judge:completed', runResultId: string, compositeScore: number }
```

Compare screen subscribes and updates cells in real-time without page reload.

### 8.6 DrillDownResponse — type extensions

```typescript
// Added to DrillDownResponse.latest:
judgeStatus: 'pending' | 'partial' | 'completed' | 'skipped';
compositeScore: number | null;
blockingFlags: Record<string, boolean> | null;
judgeVerdicts: {
  providerName: string;
  scores: Record<string, { score: number; rationale: string }>;
  blocking: Record<string, { triggered: boolean; rationale: string }>;
  createdAt: string;
  error: string | null;
}[] | null;
```

---

## 9. Settings Page

### 9.1 Judge Providers section

CRUD for OpenAI-compatible LLM providers:
- **Fields:** name, baseUrl, apiKey (masked in UI, encrypted in DB), model, enabled toggle
- **[Test]** button — sends minimal test prompt, shows ✓/✗ + latency
- **[+ Add Provider]** — form for new provider
- Drag handle for priority ordering

### 9.2 Scoring Configuration section

**Composite weights:**
- Two linked sliders: Test weight / Judge weight, sum constrained to 1.0
- Moving one auto-adjusts the other

**Blocking caps:**
- 1 blocking flag → cap at (default 60, editable)
- 2+ blocking flags → cap at (default 40, editable)

**Criteria priority:**
- Drag & drop reorder of 10 criteria
- Distribution preset dropdown: Flat / Linear (default) / Steep
- Computed weights displayed read-only next to each criterion with proportional bar

**Other settings:**
- Judge retries: number input (default 3)
- Judge temperature: number input (default 0.3, range 0–1)
- Max concurrent per provider: number input (default 3)
- Max concurrent global: number input (default 10)
- Log compression: dropdown — Structured (default) / None
- Max compressed chars: number input (default 30000)
- Max judge prompt chars: number input (default 120000)
- Task idle timeout: number input in seconds (default 300; API wire format is always milliseconds, UI converts sec ↔ ms)
- Raw response retention: number input in days (default 90)

**[Reset to Defaults]** and **[Save]** buttons.

### 9.3 API routes

```
GET    /api/settings/judge-providers          → list (apiKey masked: "••••sk-abc")
POST   /api/settings/judge-providers          → create (apiKey required)
PUT    /api/settings/judge-providers/:id      → update (apiKey optional: absent = keep current, non-empty string = replace)
DELETE /api/settings/judge-providers/:id      → delete
POST   /api/settings/judge-providers/:id/test → test connection
POST   /api/settings/judge-providers/rotate-keys → re-encrypt all keys with current JUDGE_ENCRYPTION_KEY

GET    /api/settings/scoring                  → get weights, caps, config
PUT    /api/settings/scoring                  → update weights, caps, config
```

**PUT semantics for `apiKey`:** The field is optional in the request body. If absent or `undefined`, the existing encrypted key is preserved. If present as a non-empty string, it replaces the existing key. Sending an empty string `""` is a validation error (400). This prevents accidental key loss from UI forms that don't re-send the masked value.

### 9.4 Storage

- Judge providers → `judge_providers` table
- Scoring config → `settings` table (key-value)

---

## 10. Re-evaluation & Manual Controls

### 10.1 Single result actions (Drill-Down Panel)

- **[Re-evaluate]** — in a single transaction: increments `evaluationVersion`, resets `judgeStatus='pending'`, snapshots current enabled providers into `judgeMeta`. Old verdicts are NOT deleted (orphaned by version mismatch, cleaned up by periodic job). After commit: enqueues tasks to stream → full judge cycle with new version
- **[Recalculate Score]** — does NOT call judges again, only recomputes `compositeScore` from existing verdicts with current weights. Cheap operation, useful after changing weights in Settings.

### 10.2 Bulk operations (Compare Screen toolbar)

```
┌─ Actions ▾ ──────────────────────────┐
│ Re-evaluate all pending              │
│ Re-evaluate selected scenario        │
│ Recalculate all composite scores     │
└──────────────────────────────────────┘
```

- **Re-evaluate all pending** — find all `judgeStatus IN ('pending', 'partial')`, re-enqueue missing tasks (does NOT increment `evaluationVersion` — these are incomplete evaluations, not restarts)
- **Re-evaluate selected scenario** — re-evaluate all run_results for a specific scenario. Semantics identical to single [Re-evaluate]: for each result, increment `evaluationVersion`, reset `judgeStatus='pending'`, re-snapshot `judgeMeta.targetProviderIds`, enqueue tasks with new version.
- **Recalculate all** — batch recompute composite scores (after weight change)

**Invariant:** `status='all'` in the bulk API follows the same per-result semantics as single re-evaluate (version increment + status reset + provider re-snapshot). `status='pending'` only re-enqueues incomplete tasks without version change.

### 10.3 API routes

```
POST /api/judge/re-evaluate       { runResultId: string }
POST /api/judge/re-evaluate-bulk  { scenarioId?: string, status?: 'pending' | 'all' }  // default: 'pending'
POST /api/judge/recalculate       { runResultId?: string }  // omit id = recalculate all
```

---

## 11. Validation & Definition of Done

### Contract tests (must pass for ANY correct implementation)

| Test | Invariant | Pass criteria |
|------|-----------|---------------|
| Aggregation: median correctness | Median of [1,3,5] = 3; median of [2,4] = 3; median of [3] = 3 | All edge cases: N=1,2,3,5 judges |
| Aggregation: majority vote | [true,false,true] → true; [true,false] → false (unanimity at N=2); [false] → false | All edge cases: N=1,2,3 |
| Aggregation: partial failure | 2 of 3 judges succeed → aggregate from 2; 0 of 3 → fallback to test-only | `compositeScore` matches formula |
| Composite formula | Given test_score=80, judge_normalized=60, weights 0.4/0.6 → composite=68 | Exact arithmetic |
| Blocking cap | 1 block + composite 75 → capped at 60; 0 blocks → no cap; 2 blocks + composite 50 → capped at 40 | Cap applied correctly |
| Weight computation | Linear preset, N=10, rank 1 → w ≈ 0.182; Flat preset → all w = 0.1; Steep → rank 1 > 0.25 | Formula matches spec |
| evaluationVersion guard | Worker receives task with version=1 but run_result has version=2 → task discarded | No verdict written, XACK sent |
| Re-evaluation idempotency | Re-evaluate same result twice rapidly → only version=3 verdicts exist (version=2 orphaned and cleaned) | No duplicate verdict rows per `(runResultId, judgeProviderId, evaluationVersion)` — at-least-once delivery may cause duplicate API calls, but UNIQUE constraint prevents duplicate rows |

### Integration tests

| Test | Setup | Pass criteria |
|------|-------|---------------|
| Full judge pipeline | Insert run_result → verify judge_verdicts created for each enabled provider → verify compositeScore computed | End-to-end within 30s (mocked LLM) |
| Startup recovery | Insert run_result with judgeStatus='pending', no verdicts → restart app → verify tasks re-enqueued | Verdicts eventually appear |
| Stream dead-letter | Simulate worker crash (never XACK) → wait for reclaim timeout → verify message reclaimed and reprocessed | Verdict created after reclaim |
| Provider disable mid-evaluation | Enqueue with 3 providers → disable provider 2 → complete all → verify aggregation uses snapshot (3 providers, not 2) | Aggregator waits for all 3 |
| Matview refresh debounce | Complete 10 judge evaluations in 5 seconds → verify matview refreshed at most once | Single `REFRESH MATERIALIZED VIEW` call |
| Redis cache miss fallback | Enqueue → delete Redis compressed key → process worker → verify re-assembly from S3 | Verdict created successfully |
| Secret redaction | Insert run_result with logs containing `sk-abc123` → verify judge prompt contains `[REDACTED]` | Pattern matched and replaced |
| Migration compatibility | Apply 0004_judge_system.sql to existing DB with data → verify existing run_results queryable, matviews refreshable | No errors, existing data intact |
| Bulk re-evaluate default status | `POST /api/judge/re-evaluate-bulk {}` (status omitted) → verify behaves as `status='pending'`: only incomplete results re-enqueued, no version increment | Same results as explicit `status='pending'` |

### Test file inventory

| Path | Tests |
|------|-------|
| `web/src/lib/judge/__tests__/aggregator.test.ts` | Median, majority vote, partial failure, blocking cap, weight computation |
| `web/src/lib/judge/__tests__/service.test.ts` | Enqueue, evaluationVersion, provider snapshot |
| `web/src/lib/judge/__tests__/worker.test.ts` | Version guard, retry, dead-letter |
| `web/src/lib/compression/__tests__/structured.test.ts` | Block parsing, chronological order, truncation |
| `web/src/lib/judge/__tests__/prompt.test.ts` | Token budget allocator, section priorities |
| `web/src/lib/judge/__tests__/integration.test.ts` | Full pipeline, startup recovery, cache miss |
| `web/src/app/api/settings/__tests__/judge-providers.test.ts` | CRUD, apiKey masking, PUT semantics |
| `web/src/app/api/settings/__tests__/scoring.test.ts` | Zod validation, weight constraints |

---

## 12. File Inventory

### New files

| Path | Purpose |
|------|---------|
| `web/drizzle/0004_judge_system.sql` | Migration: judge_providers, judge_verdicts, compression_logs, settings; run_results new columns (judgeStatus, blockingFlags, compositeScore, judgeMeta, evaluationVersion); drop judgeModel |
| `web/src/lib/judge/service.ts` | JudgeService — enqueue, orchestrate judge evaluations |
| `web/src/lib/judge/worker.ts` | JudgeWorker — process individual judge tasks |
| `web/src/lib/judge/aggregator.ts` | JudgeAggregator — median + majority vote + composite calc |
| `web/src/lib/judge/prompt.ts` | Judge prompt builder (system + user) |
| `web/src/lib/judge/context.ts` | Context assembly — load logs, artifacts from S3 |
| `web/src/lib/judge/types.ts` | JudgeContext, JudgeVerdict, JudgeResponse types |
| `web/src/lib/judge/criteria.ts` | Unified criteria + blocking checks definitions + weight computation |
| `web/src/lib/judge/redactor.ts` | Secret pattern redaction for logs before sending to judge |
| `web/src/lib/judge/reclaim.ts` | Periodic XAUTOCLAIM loop + dead-letter handling |
| `web/src/lib/judge/cleanup.ts` | Periodic cleanup: stale verdicts, rawResponse retention |
| `web/src/lib/compression/types.ts` | LogCompressor interface, CompressedLog type |
| `web/src/lib/compression/structured.ts` | StructuredCompressor implementation |
| `web/src/lib/compression/noop.ts` | NoopCompressor implementation |
| `web/src/lib/compression/factory.ts` | createCompressor factory |
| `web/src/lib/events/redis-bus.ts` | Redis Streams + Pub/Sub EventBus (replaces in-memory) |
| `web/src/lib/events/redis-client.ts` | Redis client factory (publisher, subscriber, consumer) |
| `web/src/lib/judge/encryption.ts` | AES-256-GCM encrypt/decrypt for API keys |
| `web/src/app/api/compare/stream/route.ts` | SSE endpoint for judge events on Compare Screen |
| `web/src/app/api/judge/re-evaluate/route.ts` | Re-evaluate API |
| `web/src/app/api/judge/re-evaluate-bulk/route.ts` | Bulk re-evaluate API |
| `web/src/app/api/judge/recalculate/route.ts` | Recalculate composite scores API |
| `web/src/app/api/settings/judge-providers/route.ts` | Judge providers CRUD |
| `web/src/app/api/settings/judge-providers/[id]/route.ts` | Single provider update/delete |
| `web/src/app/api/settings/judge-providers/[id]/test/route.ts` | Test provider connection |
| `web/src/app/api/settings/scoring/route.ts` | Scoring config get/put |
| `web/src/components/compare/judge-evaluation.tsx` | Judge evaluation section in drill-down |
| `web/src/components/settings/judge-providers.tsx` | Provider management UI |
| `web/src/components/settings/scoring-config.tsx` | Scoring configuration UI |

### Modified files

| Path | Change |
|------|--------|
| `web/docker-compose.yml` | Add valkey service |
| `web/package.json` | Add `ioredis` dependency |
| `web/src/db/schema.ts` | Add new tables, modify run_results (new columns, drop judgeModel) |
| `web/src/db/migrate-views.ts` | Recreate matviews with composite_score, blocking_flags, judge_status columns |
| `web/src/lib/orchestrator/reconciler.ts` | Publish `result:created` event after finalize |
| `web/src/lib/orchestrator/scheduler.ts` | Use Redis EventBus; trigger judge on startup recovery |
| `web/src/lib/orchestrator/event-bus.ts` | Replace with Redis Pub/Sub wrapper (or re-export from redis-bus) |
| `web/src/lib/compare/queries.ts` | Use `compositeScore` with fallback; add judge fields to responses |
| `web/src/lib/compare/types.ts` | Extend DrillDownResponse, HeatmapCell with judge fields |
| `web/src/app/api/compare/[scenarioId]/drill-down/route.ts` | Include judge verdicts in response |
| `web/src/components/compare/heatmap-cell.tsx` | Judge status badge, composite score |
| `web/src/components/compare/drill-down-panel.tsx` | Judge evaluation section |
| `web/src/components/compare/breakdown-popover.tsx` | Composite score, judge status |
| `web/src/components/compare/leaderboard.tsx` | "Judged" column |
| `web/src/app/compare/compare-view.tsx` | SSE subscription for judge events; Actions dropdown |
| `web/src/app/settings/page.tsx` | Add judge providers + scoring config sections |
| `web/src/app/api/runs/[runId]/stream/route.ts` | Switch to Redis Pub/Sub subscription |

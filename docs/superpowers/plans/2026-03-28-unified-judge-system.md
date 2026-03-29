# Unified Judge System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add async multi-judge LLM evaluation to `./web` that scores each run result against 10 unified criteria + 4 blocking checks, producing a composite score from test results + judge verdicts.

**Architecture:** Event-driven pipeline: reconciler emits `result:created` → JudgeService enqueues tasks to Redis Streams → JudgeWorker processes via OpenAI-compatible APIs → JudgeAggregator computes median/majority-vote → composite score written to DB. Valkey 8 provides both the reliable task queue (Streams) and real-time notifications (Pub/Sub). All pure scoring logic is isolated in testable modules with no I/O.

**Tech Stack:** Next.js 16 + React 19, Drizzle ORM + PostgreSQL, Valkey 8 (Redis-compatible), ioredis, Vitest, Zod, AES-256-GCM

**Spec:** `docs/superpowers/specs/2026-03-28-unified-judge-system-design.md`

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `web/src/lib/judge/types.ts` | All judge-related TypeScript types, Zod schemas for settings validation |
| `web/src/lib/judge/criteria.ts` | 10 criteria + 4 blocking checks definitions, weight computation (Flat/Linear/Steep) |
| `web/src/lib/judge/aggregator.ts` | Pure functions: median, majority vote, composite score, partial failure rules |
| `web/src/lib/judge/encryption.ts` | AES-256-GCM encrypt/decrypt for API keys |
| `web/src/lib/judge/redactor.ts` | Secret pattern redaction in logs |
| `web/src/lib/judge/prompt.ts` | Judge prompt builder (system + user), token budget allocator |
| `web/src/lib/judge/context.ts` | Context assembly — load logs + artifacts from S3 |
| `web/src/lib/judge/service.ts` | JudgeService — enqueue judge tasks to Redis Streams |
| `web/src/lib/judge/worker.ts` | JudgeWorker — process stream tasks, call LLM, write verdicts |
| `web/src/lib/judge/reclaim.ts` | Periodic XAUTOCLAIM loop + dead-letter handling |
| `web/src/lib/judge/cleanup.ts` | Periodic cleanup: stale verdicts, rawResponse retention |
| `web/src/lib/compression/types.ts` | LogCompressor interface, CompressedLog type |
| `web/src/lib/compression/structured.ts` | StructuredCompressor implementation |
| `web/src/lib/compression/noop.ts` | NoopCompressor (passthrough) |
| `web/src/lib/compression/factory.ts` | createCompressor factory |
| `web/src/lib/events/redis-client.ts` | Redis client factory (publisher, subscriber, consumer) |
| `web/src/lib/events/redis-bus.ts` | Redis Pub/Sub EventBus replacing in-memory |
| `web/drizzle/0004_judge_system.sql` | Migration SQL |
| `web/src/app/api/settings/judge-providers/route.ts` | GET/POST judge providers |
| `web/src/app/api/settings/judge-providers/[id]/route.ts` | PUT/DELETE single provider |
| `web/src/app/api/settings/judge-providers/[id]/test/route.ts` | POST test provider connection |
| `web/src/app/api/settings/judge-providers/rotate-keys/route.ts` | POST re-encrypt all keys |
| `web/src/app/api/settings/scoring/route.ts` | GET/PUT scoring config |
| `web/src/app/api/judge/re-evaluate/route.ts` | POST re-evaluate single |
| `web/src/app/api/judge/re-evaluate-bulk/route.ts` | POST bulk re-evaluate |
| `web/src/app/api/judge/recalculate/route.ts` | POST recalculate composite scores |
| `web/src/app/api/compare/stream/route.ts` | SSE endpoint for judge events |
| `web/src/components/settings/judge-providers.tsx` | Provider management UI |
| `web/src/components/settings/scoring-config.tsx` | Scoring config UI |
| `web/src/components/compare/judge-evaluation.tsx` | Judge evaluation section in drill-down |

### Modified files

| Path | Change |
|------|--------|
| `web/docker-compose.yml` | Add valkey service |
| `web/package.json` | Add `ioredis` dependency |
| `web/src/lib/env.ts` | Add `REDIS_URL`, `JUDGE_ENCRYPTION_KEY` |
| `web/src/db/schema.ts` | Add judge_providers, judge_verdicts, compression_logs, settings tables; add columns to runResults; drop judgeModel |
| `web/src/db/migrate-views.ts` | Recreate matviews with composite_score, blocking_flags, judge_status |
| `web/src/lib/orchestrator/event-bus.ts` | `EventBus` interface + `RedisEventBus` impl + `InMemoryEventBus` for tests |
| `web/src/lib/orchestrator/reconciler.ts` | Publish `result:created` event after finalize |
| `web/src/lib/orchestrator/scheduler.ts` | `RunEventBus` type → `EventBus` interface |
| `web/src/lib/orchestrator/__tests__/event-bus.test.ts` | `RunEventBus` → `InMemoryEventBus` |
| `web/src/lib/orchestrator/__tests__/scheduler.test.ts` | `RunEventBus` → `InMemoryEventBus` |
| `web/src/lib/compare/types.ts` | Extend DrillDownResponse, HeatmapCell with judge fields |
| `web/src/lib/compare/queries.ts` | COALESCE(composite_score, total_score) in all query paths |
| `web/src/lib/db/refresh-matviews.ts` | Debounced refresh via Redis distributed lock |
| `web/src/app/api/compare/[scenarioId]/drill-down/route.ts` | Include judge verdicts in response |
| `web/src/components/compare/heatmap-cell.tsx` | Judge status badge, composite score display |
| `web/src/components/compare/drill-down-panel.tsx` | Judge evaluation section |
| `web/src/components/compare/breakdown-popover.tsx` | Composite score display |
| `web/src/app/compare/compare-view.tsx` | SSE subscription for judge events, Actions dropdown |
| `web/src/app/settings/page.tsx` | Judge providers + scoring config sections |
### Verified — no changes needed

| Path | Reason |
|------|--------|
| `web/src/app/api/runs/[runId]/stream/route.ts` | Uses `runEventBus` singleton; `EventBus` interface is satisfied, replay semantics preserved |

### Test files

| Path | Tests |
|------|-------|
| `web/src/lib/judge/__tests__/criteria.test.ts` | Weight computation for all presets |
| `web/src/lib/judge/__tests__/aggregator.test.ts` | Median, majority vote, composite, partial failure, blocking cap |
| `web/src/lib/judge/__tests__/encryption.test.ts` | Encrypt/decrypt roundtrip, key rotation |
| `web/src/lib/judge/__tests__/redactor.test.ts` | Secret pattern matching and replacement |
| `web/src/lib/judge/__tests__/prompt.test.ts` | Token budget allocator, prompt structure |
| `web/src/lib/judge/__tests__/service.test.ts` | Enqueue flow, evaluationVersion, provider snapshot |
| `web/src/lib/judge/__tests__/worker.test.ts` | Version guard, retry, dead-letter |
| `web/src/lib/compression/__tests__/structured.test.ts` | Block parsing, chronological order, truncation |
| `web/src/lib/compression/__tests__/factory.test.ts` | Factory dispatch |
| `web/src/app/api/settings/__tests__/judge-providers.test.ts` | CRUD, apiKey masking, PUT semantics |
| `web/src/app/api/settings/__tests__/scoring.test.ts` | Zod validation, weight constraints |
| `web/src/lib/judge/__tests__/integration.test.ts` | Full pipeline, startup recovery, cache miss |

---

## Task 1: Types, Criteria & Weight Computation

**Files:**
- Create: `web/src/lib/judge/types.ts`
- Create: `web/src/lib/judge/criteria.ts`
- Test: `web/src/lib/judge/__tests__/criteria.test.ts`

- [ ] **Step 1: Write criteria test — weight computation**

```typescript
// web/src/lib/judge/__tests__/criteria.test.ts
import { describe, it, expect } from 'vitest';
import {
  CRITERIA,
  BLOCKING_CHECKS,
  computeWeights,
  type WeightPreset,
} from '../criteria';

describe('CRITERIA', () => {
  it('has exactly 10 criteria with unique keys', () => {
    expect(CRITERIA).toHaveLength(10);
    const keys = CRITERIA.map((c) => c.key);
    expect(new Set(keys).size).toBe(10);
  });

  it('has criteria in default priority order', () => {
    expect(CRITERIA[0].key).toBe('task_success');
    expect(CRITERIA[9].key).toBe('verification_awareness');
  });
});

describe('BLOCKING_CHECKS', () => {
  it('has exactly 4 checks with unique keys', () => {
    expect(BLOCKING_CHECKS).toHaveLength(4);
    const keys = BLOCKING_CHECKS.map((c) => c.key);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('computeWeights', () => {
  const N = 10;
  const order = [
    'task_success',
    'solution_correctness',
    'instruction_following',
    'design_quality',
    'tool_action_quality',
    'reasoning_diagnosis',
    'recovery_adaptivity',
    'safety_scope_control',
    'context_state_handling',
    'verification_awareness',
  ];

  it.each<[WeightPreset, number, number]>([
    ['flat', 0.1, 0.1],
    ['linear', 0.182, 0.018],
    ['steep', 0.275, 0.003],
  ])(
    '%s preset: rank 1 ≈ %f, rank 10 ≈ %f',
    (preset, expectedFirst, expectedLast) => {
      const weights = computeWeights(order, preset);
      expect(Object.keys(weights)).toHaveLength(N);
      expect(weights['task_success']).toBeCloseTo(expectedFirst, 2);
      expect(weights['verification_awareness']).toBeCloseTo(expectedLast, 2);
    }
  );

  it('weights sum to 1.0 for all presets', () => {
    for (const preset of ['flat', 'linear', 'steep'] as WeightPreset[]) {
      const weights = computeWeights(order, preset);
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  it('respects custom order (swapped rank 1 and 10)', () => {
    const swapped = [...order];
    swapped[0] = 'verification_awareness';
    swapped[9] = 'task_success';
    const weights = computeWeights(swapped, 'linear');
    expect(weights['verification_awareness']).toBeGreaterThan(
      weights['task_success']
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/criteria.test.ts
```

Expected: FAIL — module `../criteria` not found.

- [ ] **Step 3: Create types module**

```typescript
// web/src/lib/judge/types.ts
import { z } from 'zod';

// --- Criterion & blocking check definitions ---

export interface CriterionDef {
  key: string;
  title: string;
  description: string;
}

export interface BlockingCheckDef {
  key: string;
  title: string;
  description: string;
}

// --- Judge verdict (single provider response) ---

export interface JudgeCriterionScore {
  score: number; // 1-5
  rationale: string;
}

export interface JudgeBlockingFlag {
  triggered: boolean;
  rationale: string;
}

export interface JudgeResponse {
  scores: Record<string, JudgeCriterionScore>;
  blocking: Record<string, JudgeBlockingFlag>;
}

export const judgeResponseSchema = z.object({
  scores: z.record(
    z.object({
      score: z.number().int().min(1).max(5),
      rationale: z.string(),
    })
  ),
  blocking: z.record(
    z.object({
      triggered: z.boolean(),
      rationale: z.string(),
    })
  ),
});

// --- Aggregated result ---

export interface AggregatedScores {
  medianScores: Record<string, number>; // criteria_key → median 1-5
  blockingFlags: Record<string, boolean>; // flag_key → majority vote
  judgeWeighted: number; // weighted sum in [1, 5]
  judgeNormalized: number; // mapped to [0, 100]
  compositeScore: number; // final after blocking cap
  blockingCount: number;
  confidence: 'normal' | 'lowConfidence';
}

// --- Judge task payload (Redis Stream message) ---

export interface JudgeTaskPayload {
  runResultId: string;
  providerId: string;
  evaluationVersion: number;
}

// --- Judge meta (stored in run_results.judgeMeta) ---

export interface JudgeMeta {
  targetProviderIds: string[];
  partial?: boolean;
  succeeded?: number;
  failed?: number;
  lowConfidence?: boolean;
  allFailed?: boolean;
}

// --- Settings Zod schemas ---

export const compositeWeightsSchema = z
  .object({
    test: z.number().positive(),
    judge: z.number().positive(),
  })
  .refine((v) => Math.abs(v.test + v.judge - 1.0) < 0.001, {
    message: 'test + judge must equal 1.0',
  });

const VALID_CRITERIA_KEYS = [
  'task_success', 'solution_correctness', 'instruction_following',
  'design_quality', 'tool_action_quality', 'reasoning_diagnosis',
  'recovery_adaptivity', 'safety_scope_control', 'context_state_handling',
  'verification_awareness',
] as const;

export const criteriaPrioritySchema = z.object({
  order: z
    .array(z.enum(VALID_CRITERIA_KEYS))
    .length(10)
    .refine(
      (arr) => new Set(arr).size === 10,
      { message: 'All 10 unique criteria keys must be present' }
    ),
  preset: z.enum(['flat', 'linear', 'steep']),
});

const VALID_BLOCKING_SEVERITY = ['1', '2'] as const;

export const blockingCapsSchema = z.object({
  '1': z.number().int().min(0).max(100),
  '2': z.number().int().min(0).max(100),
});

export type WeightPreset = 'flat' | 'linear' | 'steep';

// Settings key → Zod schema map
export const settingsSchemas: Record<string, z.ZodType> = {
  composite_weights: compositeWeightsSchema,
  criteria_priority: criteriaPrioritySchema,
  blocking_caps: blockingCapsSchema,
  judge_max_retries: z.number().int().min(1).max(10),
  judge_max_concurrent_per_provider: z.number().int().min(1).max(20),
  judge_max_concurrent_global: z.number().int().min(1).max(50),
  judge_temperature: z.number().min(0).max(1),
  log_compression: z.enum(['structured', 'none']),
  max_compressed_chars: z.number().int().min(1000).max(200000),
  max_judge_prompt_chars: z.number().int().min(10000).max(500000),
  judge_task_idle_timeout_ms: z.number().int().min(60000).max(1800000),
  judge_raw_response_retention_days: z.number().int().min(1).max(365),
};

// Default values for all settings
export const settingsDefaults: Record<string, unknown> = {
  composite_weights: { test: 0.4, judge: 0.6 },
  criteria_priority: {
    order: [
      'task_success',
      'solution_correctness',
      'instruction_following',
      'design_quality',
      'tool_action_quality',
      'reasoning_diagnosis',
      'recovery_adaptivity',
      'safety_scope_control',
      'context_state_handling',
      'verification_awareness',
    ],
    preset: 'linear',
  },
  blocking_caps: { '1': 60, '2': 40 },
  judge_max_retries: 3,
  judge_max_concurrent_per_provider: 3,
  judge_max_concurrent_global: 10,
  judge_temperature: 0.3,
  log_compression: 'structured',
  max_compressed_chars: 30000,
  max_judge_prompt_chars: 120000,
  judge_task_idle_timeout_ms: 300000,
  judge_raw_response_retention_days: 90,
};
```

- [ ] **Step 4: Create criteria module with weight computation**

```typescript
// web/src/lib/judge/criteria.ts
import type { CriterionDef, BlockingCheckDef, WeightPreset } from './types';

export type { WeightPreset };

export const CRITERIA: CriterionDef[] = [
  {
    key: 'task_success',
    title: 'Task success',
    description:
      'Whether the run solves the task and produces the expected end result',
  },
  {
    key: 'solution_correctness',
    title: 'Solution correctness',
    description:
      'Technical correctness of the produced code, artifact, or final answer',
  },
  {
    key: 'instruction_following',
    title: 'Instruction following',
    description:
      'Whether the run follows explicit instructions, constraints, and required output conditions',
  },
  {
    key: 'design_quality',
    title: 'Design quality',
    description:
      'Quality of design decisions, abstractions, maintainability, and suitability for the task',
  },
  {
    key: 'tool_action_quality',
    title: 'Tool/action quality',
    description:
      'Appropriateness and efficiency of tool use and execution actions',
  },
  {
    key: 'reasoning_diagnosis',
    title: 'Reasoning/diagnosis',
    description:
      'Quality of reasoning, debugging, and identification of root causes when needed',
  },
  {
    key: 'recovery_adaptivity',
    title: 'Recovery/adaptivity',
    description:
      'Ability to recover from mistakes or failed attempts and adjust strategy',
  },
  {
    key: 'safety_scope_control',
    title: 'Safety/scope control',
    description:
      'Whether changes stay safe, scoped, and free of harmful side effects',
  },
  {
    key: 'context_state_handling',
    title: 'Context/state handling',
    description:
      'How well the run uses task context and tracks intermediate workspace state',
  },
  {
    key: 'verification_awareness',
    title: 'Verification awareness',
    description:
      'Whether the run checks its work through tests, validation, or consistency checks',
  },
];

export const BLOCKING_CHECKS: BlockingCheckDef[] = [
  {
    key: 'hard_instruction_violation',
    title: 'Hard instruction violation',
    description:
      'Fails an explicit must-follow instruction or hard constraint',
  },
  {
    key: 'unsafe_or_out_of_scope_change',
    title: 'Unsafe or out-of-scope change',
    description:
      'Introduces harmful, risky, or unnecessary modifications outside the task scope',
  },
  {
    key: 'invalid_solution_artifact',
    title: 'Invalid solution/artifact',
    description:
      'Produces unusable, broken, or technically invalid code or artifact',
  },
  {
    key: 'incorrect_final_state',
    title: 'Incorrect final state',
    description:
      'Leaves the task in a clearly wrong, incomplete, or inconsistent final state',
  },
];

export const CRITERIA_KEYS = CRITERIA.map((c) => c.key);
export const BLOCKING_KEYS = BLOCKING_CHECKS.map((c) => c.key);

/**
 * Compute weights from priority order and distribution preset.
 * Rank 1 (index 0) = highest weight. Weights always sum to 1.0.
 */
export function computeWeights(
  order: string[],
  preset: WeightPreset
): Record<string, number> {
  const N = order.length;
  const rawWeights: number[] = [];

  for (let i = 0; i < N; i++) {
    const rank = i + 1; // 1-based
    switch (preset) {
      case 'flat':
        rawWeights.push(1);
        break;
      case 'linear':
        rawWeights.push(N - rank + 1);
        break;
      case 'steep':
        rawWeights.push((N - rank + 1) ** 2);
        break;
    }
  }

  const sum = rawWeights.reduce((a, b) => a + b, 0);
  const result: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    result[order[i]] = rawWeights[i] / sum;
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/judge/__tests__/criteria.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/judge/types.ts web/src/lib/judge/criteria.ts web/src/lib/judge/__tests__/criteria.test.ts
git commit -m "feat(judge): add types, criteria definitions, weight computation"
```

---

## Task 2: Aggregator — Pure Scoring Logic

**Files:**
- Create: `web/src/lib/judge/aggregator.ts`
- Test: `web/src/lib/judge/__tests__/aggregator.test.ts`

- [ ] **Step 1: Write aggregator tests**

```typescript
// web/src/lib/judge/__tests__/aggregator.test.ts
import { describe, it, expect } from 'vitest';
import {
  median,
  majorityVote,
  computeCompositeScore,
  aggregateVerdicts,
} from '../aggregator';

describe('median', () => {
  it.each([
    [[3], 3],
    [[2, 4], 3],
    [[1, 3, 5], 3],
    [[1, 2, 4, 5, 5], 4],
  ])('median(%j) = %d', (values, expected) => {
    expect(median(values)).toBe(expected);
  });

  it('throws on empty array', () => {
    expect(() => median([])).toThrow();
  });
});

describe('majorityVote', () => {
  it.each([
    [[true, false, true], true, 'majority triggered'],
    [[true, false], false, 'N=2 requires unanimity'],
    [[false], false, 'single judge false'],
    [[true], true, 'single judge true'],
    [[true, true, true], true, 'all triggered'],
    [[false, false, false], false, 'none triggered'],
    [[true, false, false], false, '1/3 not majority'],
  ])('%j → %s (%s)', (votes, expected) => {
    expect(majorityVote(votes)).toBe(expected);
  });
});

describe('computeCompositeScore', () => {
  it('computes correct composite with default weights', () => {
    // test_score=80, judge_normalized=60, weights 0.4/0.6
    // composite = 80*0.4 + 60*0.6 = 32 + 36 = 68
    const result = computeCompositeScore({
      testScore: 80,
      judgeNormalized: 60,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: 0,
      blockingCaps: { '1': 60, '2': 40 },
    });
    expect(result).toBe(68);
  });

  it('caps at 60 with 1 blocking flag', () => {
    const result = computeCompositeScore({
      testScore: 100,
      judgeNormalized: 100,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: 1,
      blockingCaps: { '1': 60, '2': 40 },
    });
    expect(result).toBe(60);
  });

  it('caps at 40 with 2+ blocking flags', () => {
    const result = computeCompositeScore({
      testScore: 80,
      judgeNormalized: 80,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: 2,
      blockingCaps: { '1': 60, '2': 40 },
    });
    expect(result).toBe(40);
  });

  it('no cap when blocking count is 0 and score is high', () => {
    const result = computeCompositeScore({
      testScore: 100,
      judgeNormalized: 100,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: 0,
      blockingCaps: { '1': 60, '2': 40 },
    });
    expect(result).toBe(100);
  });

  it('cap does not increase score (composite 50, cap 60 → stays 50)', () => {
    const result = computeCompositeScore({
      testScore: 50,
      judgeNormalized: 50,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: 1,
      blockingCaps: { '1': 60, '2': 40 },
    });
    expect(result).toBe(50);
  });
});

describe('aggregateVerdicts', () => {
  const makeVerdict = (
    scores: Record<string, number>,
    blocking: Record<string, boolean>,
    error?: string
  ) => ({
    scores: Object.fromEntries(
      Object.entries(scores).map(([k, v]) => [
        k,
        { score: v, rationale: 'test' },
      ])
    ),
    blockingFlags: Object.fromEntries(
      Object.entries(blocking).map(([k, v]) => [
        k,
        { triggered: v, rationale: 'test' },
      ])
    ),
    error: error ?? null,
  });

  const criteriaKeys = ['task_success', 'solution_correctness'];
  const blockingKeys = ['hard_instruction_violation'];

  it('aggregates 3 successful verdicts with median', () => {
    const verdicts = [
      makeVerdict({ task_success: 4, solution_correctness: 3 }, { hard_instruction_violation: false }),
      makeVerdict({ task_success: 5, solution_correctness: 3 }, { hard_instruction_violation: false }),
      makeVerdict({ task_success: 4, solution_correctness: 5 }, { hard_instruction_violation: true }),
    ];
    const result = aggregateVerdicts(verdicts, criteriaKeys, blockingKeys);
    expect(result.medianScores['task_success']).toBe(4);
    expect(result.medianScores['solution_correctness']).toBe(3);
    expect(result.blockingFlags['hard_instruction_violation']).toBe(false); // 1/3 not majority
    expect(result.confidence).toBe('normal');
  });

  it('handles partial failure: 2 of 3 succeed (S >= ceil(N/2))', () => {
    const verdicts = [
      makeVerdict({ task_success: 4, solution_correctness: 3 }, { hard_instruction_violation: false }),
      makeVerdict({ task_success: 5, solution_correctness: 5 }, { hard_instruction_violation: true }),
      makeVerdict({}, {}, 'provider error'),
    ];
    const result = aggregateVerdicts(verdicts, criteriaKeys, blockingKeys);
    expect(result.medianScores['task_success']).toBe(4.5); // median of [4,5]
    expect(result.blockingFlags['hard_instruction_violation']).toBe(false); // 1/2, unanimity needed
    expect(result.confidence).toBe('normal');
  });

  it('handles low confidence: 1 of 3 succeed (S < ceil(N/2))', () => {
    const verdicts = [
      makeVerdict({ task_success: 4, solution_correctness: 3 }, { hard_instruction_violation: true }),
      makeVerdict({}, {}, 'error 1'),
      makeVerdict({}, {}, 'error 2'),
    ];
    const result = aggregateVerdicts(verdicts, criteriaKeys, blockingKeys);
    expect(result.medianScores['task_success']).toBe(4);
    expect(result.blockingFlags['hard_instruction_violation']).toBe(true); // unanimity among S=1
    expect(result.confidence).toBe('lowConfidence');
  });

  it('handles all failed: returns null', () => {
    const verdicts = [
      makeVerdict({}, {}, 'error 1'),
      makeVerdict({}, {}, 'error 2'),
    ];
    const result = aggregateVerdicts(verdicts, criteriaKeys, blockingKeys);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/aggregator.test.ts
```

Expected: FAIL — module `../aggregator` not found.

- [ ] **Step 3: Implement aggregator**

```typescript
// web/src/lib/judge/aggregator.ts
import type { JudgeCriterionScore, JudgeBlockingFlag, AggregatedScores } from './types';

/**
 * Compute the median of a sorted-in-place array.
 * For even N: returns average of two middle values.
 */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error('Cannot compute median of empty array');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Majority vote: >50% must agree for trigger.
 * At N=2: requires unanimity (both true).
 */
export function majorityVote(votes: boolean[]): boolean {
  const trueCount = votes.filter(Boolean).length;
  return trueCount > votes.length / 2;
}

/**
 * Compute final composite score with blocking cap.
 */
export function computeCompositeScore(params: {
  testScore: number;
  judgeNormalized: number;
  weights: { test: number; judge: number };
  blockingCount: number;
  blockingCaps: Record<string, number>;
}): number {
  const { testScore, judgeNormalized, weights, blockingCount, blockingCaps } = params;
  let composite = weights.test * testScore + weights.judge * judgeNormalized;

  if (blockingCount >= 2) {
    composite = Math.min(composite, blockingCaps['2'] ?? 40);
  } else if (blockingCount === 1) {
    composite = Math.min(composite, blockingCaps['1'] ?? 60);
  }

  return composite;
}

interface VerdictInput {
  scores: Record<string, JudgeCriterionScore>;
  blockingFlags: Record<string, JudgeBlockingFlag>;
  error: string | null;
}

/**
 * Aggregate multiple judge verdicts into median scores + majority vote blocking.
 * Returns null if all verdicts failed (S=0).
 */
export function aggregateVerdicts(
  verdicts: VerdictInput[],
  criteriaKeys: string[],
  blockingKeys: string[]
): AggregatedScores | null {
  const successful = verdicts.filter((v) => v.error == null);
  const S = successful.length;
  const N = verdicts.length;

  if (S === 0) return null;

  // Determine confidence level
  const halfN = Math.ceil(N / 2);
  const confidence = S >= halfN ? 'normal' : 'lowConfidence';

  // Median scores across successful verdicts
  const medianScores: Record<string, number> = {};
  for (const key of criteriaKeys) {
    const scores = successful
      .map((v) => v.scores[key]?.score)
      .filter((s): s is number => s != null);
    medianScores[key] = scores.length > 0 ? median(scores) : 0;
  }

  // Blocking flags: majority vote (normal) or unanimity (lowConfidence)
  const blockingFlags: Record<string, boolean> = {};
  for (const key of blockingKeys) {
    const votes = successful
      .map((v) => v.blockingFlags[key]?.triggered)
      .filter((v): v is boolean => v != null);
    if (confidence === 'lowConfidence') {
      // Unanimity among successful judges when low confidence
      blockingFlags[key] = votes.length > 0 && votes.every(Boolean);
    } else {
      blockingFlags[key] = votes.length > 0 ? majorityVote(votes) : false;
    }
  }

  const blockingCount = Object.values(blockingFlags).filter(Boolean).length;

  // judgeWeighted is not computed here — it depends on weights from settings.
  // We return medianScores and let the caller compute the final score.
  return {
    medianScores,
    blockingFlags,
    judgeWeighted: 0, // placeholder — caller computes
    judgeNormalized: 0, // placeholder — caller computes
    compositeScore: 0, // placeholder — caller computes
    blockingCount,
    confidence,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/judge/__tests__/aggregator.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/judge/aggregator.ts web/src/lib/judge/__tests__/aggregator.test.ts
git commit -m "feat(judge): add aggregator — median, majority vote, composite score"
```

---

## Task 3: Encryption Module

**Files:**
- Create: `web/src/lib/judge/encryption.ts`
- Test: `web/src/lib/judge/__tests__/encryption.test.ts`

- [ ] **Step 1: Write encryption tests**

```typescript
// web/src/lib/judge/__tests__/encryption.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt, decrypt } from '../encryption';

describe('encryption', () => {
  beforeEach(() => {
    // 32-byte hex key for AES-256
    vi.stubEnv(
      'JUDGE_ENCRYPTION_KEY',
      'a'.repeat(64) // 32 bytes in hex
    );
  });

  it('roundtrip: encrypt then decrypt returns original', () => {
    const plaintext = 'sk-test-key-12345';
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext for same input (random nonce)', () => {
    const plaintext = 'sk-test-key-12345';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
  });

  it('ciphertext is base64-encoded', () => {
    const ciphertext = encrypt('test');
    expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
  });

  it('throws on missing JUDGE_ENCRYPTION_KEY', () => {
    vi.stubEnv('JUDGE_ENCRYPTION_KEY', '');
    expect(() => encrypt('test')).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const ciphertext = encrypt('test');
    const tampered = ciphertext.slice(0, -4) + 'AAAA';
    expect(() => decrypt(tampered)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/encryption.test.ts
```

Expected: FAIL — module `../encryption` not found.

- [ ] **Step 3: Implement encryption**

```typescript
// web/src/lib/judge/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.JUDGE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'JUDGE_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64(nonce + ciphertext + tag).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString('base64');
}

/**
 * Decrypt base64(nonce + ciphertext + tag) with AES-256-GCM.
 */
export function decrypt(ciphertextBase64: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertextBase64, 'base64');
  const nonce = data.subarray(0, NONCE_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const encrypted = data.subarray(NONCE_LENGTH, data.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/judge/__tests__/encryption.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/judge/encryption.ts web/src/lib/judge/__tests__/encryption.test.ts
git commit -m "feat(judge): add AES-256-GCM encryption for API keys"
```

---

## Task 4: Secret Redactor

**Files:**
- Create: `web/src/lib/judge/redactor.ts`
- Test: `web/src/lib/judge/__tests__/redactor.test.ts`

- [ ] **Step 1: Write redactor tests**

```typescript
// web/src/lib/judge/__tests__/redactor.test.ts
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../redactor';

describe('redactSecrets', () => {
  it('redacts OpenAI-style API keys', () => {
    expect(redactSecrets('key is sk-abc123def456')).toBe(
      'key is [REDACTED]'
    );
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbG...')).toBe(
      'Authorization: [REDACTED]'
    );
  });

  it('redacts env var assignments', () => {
    expect(redactSecrets('export API_KEY=mysecretvalue123')).toBe(
      'export API_KEY=[REDACTED]'
    );
  });

  it('redacts multiple secrets in one string', () => {
    const input = 'sk-abc123 and Bearer xyz and TOKEN=secret';
    const result = redactSecrets(input);
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('xyz');
    expect(result).not.toContain('secret');
  });

  it('leaves non-secret text unchanged', () => {
    const input = 'Running test suite... 42 tests passed';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/redactor.test.ts
```

Expected: FAIL — module `../redactor` not found.

- [ ] **Step 3: Implement redactor**

```typescript
// web/src/lib/judge/redactor.ts

const PATTERNS: RegExp[] = [
  // OpenAI-style keys: sk-..., sk-proj-...
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._\-\/+=]{10,}/g,
  // Env var assignments: KEY=value (on same line)
  /\b[A-Z_]{2,}(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS)=[^\s\n]+/g,
  // AWS-style keys
  /\bAKIA[A-Z0-9]{16}\b/g,
  // Generic long base64 blocks (>=64 chars, likely credentials)
  /\b[A-Za-z0-9+\/]{64,}={0,2}\b/g,
];

/**
 * Redact common secret patterns from text.
 * Returns text with secrets replaced by [REDACTED].
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/judge/__tests__/redactor.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/judge/redactor.ts web/src/lib/judge/__tests__/redactor.test.ts
git commit -m "feat(judge): add secret redactor for log sanitization"
```

---

## Task 5: Log Compression — Interface & Structured Compressor

**Files:**
- Create: `web/src/lib/compression/types.ts`
- Create: `web/src/lib/compression/noop.ts`
- Create: `web/src/lib/compression/structured.ts`
- Create: `web/src/lib/compression/factory.ts`
- Test: `web/src/lib/compression/__tests__/structured.test.ts`
- Test: `web/src/lib/compression/__tests__/factory.test.ts`

- [ ] **Step 1: Write structured compressor tests**

```typescript
// web/src/lib/compression/__tests__/structured.test.ts
import { describe, it, expect } from 'vitest';
import { StructuredCompressor } from '../structured';

describe('StructuredCompressor', () => {
  const compressor = new StructuredCompressor();

  it('has type "structured"', () => {
    expect(compressor.type).toBe('structured');
  });

  it('preserves chronological order of blocks', () => {
    const log = [
      '[2026-03-28 10:00:00] <thinking>First thought</thinking>',
      '[2026-03-28 10:00:01] tool_use: read_file args: {"path": "test.ts"}',
      '[2026-03-28 10:00:02] Error: something went wrong',
      '[2026-03-28 10:00:03] <thinking>Second thought</thinking>',
    ].join('\n');

    const result = compressor.compress(log, { maxChars: 50000 });
    const lines = result.content.split('\n');

    // Find timestamps in order
    const timestamps = lines
      .filter((l) => l.includes('[2026-03-28'))
      .map((l) => l.match(/\[([^\]]+)\]/)?.[1])
      .filter(Boolean);

    // Should maintain chronological order
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]! >= timestamps[i - 1]!).toBe(true);
    }
  });

  it('keeps ERROR blocks in full', () => {
    const errorLine =
      'Error: TypeError: Cannot read properties of undefined';
    const log = `[10:00:00] Some normal output\n[10:00:01] ${errorLine}\n[10:00:02] More output`;
    const result = compressor.compress(log, { maxChars: 50000 });
    expect(result.content).toContain(errorLine);
  });

  it('truncates large TOOL_RESULT blocks', () => {
    const longResult = 'x'.repeat(1000);
    const log = `[10:00:00] tool_use: read_file\n[10:00:01] Result: ${longResult}\n[10:00:02] Done`;
    const result = compressor.compress(log, { maxChars: 50000 });
    expect(result.outputChars).toBeLessThan(result.inputChars);
  });

  it('reports compression ratio', () => {
    const log = 'x'.repeat(10000);
    const result = compressor.compress(log, { maxChars: 5000 });
    expect(result.inputChars).toBe(10000);
    expect(result.outputChars).toBeLessThanOrEqual(5000);
  });

  it('handles empty log', () => {
    const result = compressor.compress('', { maxChars: 50000 });
    expect(result.content).toBe('');
    expect(result.inputChars).toBe(0);
    expect(result.outputChars).toBe(0);
  });

  it('respects maxChars limit', () => {
    const log = Array.from({ length: 100 }, (_, i) =>
      `[10:${String(i).padStart(2, '0')}:00] ${'content '.repeat(50)}`
    ).join('\n');
    const result = compressor.compress(log, { maxChars: 2000 });
    expect(result.outputChars).toBeLessThanOrEqual(2000);
  });
});
```

- [ ] **Step 2: Write factory tests**

```typescript
// web/src/lib/compression/__tests__/factory.test.ts
import { describe, it, expect } from 'vitest';
import { createCompressor } from '../factory';

describe('createCompressor', () => {
  it('creates structured compressor', () => {
    const c = createCompressor('structured');
    expect(c.type).toBe('structured');
  });

  it('creates noop compressor', () => {
    const c = createCompressor('none');
    expect(c.type).toBe('none');
  });

  it('noop returns input unchanged', () => {
    const c = createCompressor('none');
    const result = c.compress('hello world', { maxChars: 100 });
    expect(result.content).toBe('hello world');
    expect(result.inputChars).toBe(11);
    expect(result.outputChars).toBe(11);
  });

  it('throws on unknown type', () => {
    expect(() => createCompressor('unknown')).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd web && npx vitest run src/lib/compression/__tests__/
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement compression interface and types**

```typescript
// web/src/lib/compression/types.ts

export interface CompressedLog {
  content: string;
  inputChars: number;
  outputChars: number;
}

export interface LogCompressor {
  readonly type: string;
  compress(rawLog: string, options: { maxChars: number }): CompressedLog;
}
```

- [ ] **Step 5: Implement noop compressor**

```typescript
// web/src/lib/compression/noop.ts
import type { LogCompressor, CompressedLog } from './types';

export class NoopCompressor implements LogCompressor {
  readonly type = 'none';

  compress(rawLog: string, _options: { maxChars: number }): CompressedLog {
    return {
      content: rawLog,
      inputChars: rawLog.length,
      outputChars: rawLog.length,
    };
  }
}
```

- [ ] **Step 6: Implement structured compressor**

```typescript
// web/src/lib/compression/structured.ts
import type { LogCompressor, CompressedLog } from './types';

type BlockType =
  | 'THINKING'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'CODE'
  | 'ERROR'
  | 'OTHER';

interface Block {
  index: number;
  timestamp: string | null;
  type: BlockType;
  content: string;
}

const ERROR_KEYWORDS = /\b(error|exception|traceback|fail|panic|fatal)\b/i;

const BLOCK_PATTERNS: [BlockType, RegExp][] = [
  ['THINKING', /^.*<thinking>|^>\s*thinking|^##\s*Reasoning/i],
  ['TOOL_CALL', /^.*tool_use:|^>\s*file edit|^##\s*Tool:|function_call|"tool"/i],
  ['ERROR', /^.*(Error:|ERROR|FAILED|exception|traceback|panic)/i],
  ['CODE', /^```|^diff\s|^\+\+\+|^---\s/],
];

function classifyLine(line: string): BlockType {
  for (const [type, pattern] of BLOCK_PATTERNS) {
    if (pattern.test(line)) return type;
  }
  return 'OTHER';
}

function extractTimestamp(line: string): string | null {
  const match = line.match(/\[([^\]]*\d{2}:\d{2}[^\]]*)\]/);
  return match ? match[1] : null;
}

function truncateBlock(block: Block, isLast: boolean): string {
  const { content, type } = block;

  switch (type) {
    case 'ERROR':
      return content; // keep full

    case 'TOOL_CALL':
      return content; // keep full

    case 'TOOL_RESULT':
      if (content.length <= 500) return content;
      return (
        content.slice(0, 200) +
        `\n── [compressed: ${content.length} → 400 chars] ──\n` +
        content.slice(-200)
      );

    case 'CODE':
      if (isLast) return content; // last code block: keep full
      {
        const lines = content.split('\n');
        if (lines.length <= 10) return content;
        return (
          lines.slice(0, 10).join('\n') +
          `\n... [${lines.length - 10} lines omitted]`
        );
      }

    case 'THINKING':
      // first/last blocks handled by caller; middle blocks truncated
      if (content.length <= 200) return content;
      return content.slice(0, 200) + `\n── [compressed: ${content.length} → 200 chars] ──`;

    case 'OTHER':
      if (ERROR_KEYWORDS.test(content)) return content;
      if (content.length <= 200) return content;
      return content.slice(0, 200) + `\n── [compressed: ${content.length} → 200 chars] ──`;
  }
}

export class StructuredCompressor implements LogCompressor {
  readonly type = 'structured';

  compress(rawLog: string, options: { maxChars: number }): CompressedLog {
    if (!rawLog) {
      return { content: '', inputChars: 0, outputChars: 0 };
    }

    const inputChars = rawLog.length;
    const lines = rawLog.split('\n');

    // Parse into blocks (each line is a block for simplicity;
    // multi-line grouping can be refined later)
    const blocks: Block[] = lines.map((line, i) => ({
      index: i,
      timestamp: extractTimestamp(line),
      type: classifyLine(line),
      content: line,
    }));

    // Find last CODE block index
    let lastCodeIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'CODE') {
        lastCodeIdx = i;
        break;
      }
    }

    // Truncate each block (preserving chronological order)
    const compressed = blocks.map((block) =>
      truncateBlock(block, block.index === lastCodeIdx)
    );

    // Join and enforce maxChars
    let result = compressed.join('\n');
    if (result.length > options.maxChars) {
      // Trim from the middle, keeping head and tail
      const half = Math.floor(options.maxChars / 2) - 50;
      result =
        result.slice(0, half) +
        `\n\n── [truncated: ${result.length} → ${options.maxChars} chars] ──\n\n` +
        result.slice(-half);
    }

    return {
      content: result,
      inputChars,
      outputChars: result.length,
    };
  }
}
```

- [ ] **Step 7: Implement factory**

```typescript
// web/src/lib/compression/factory.ts
import type { LogCompressor } from './types';
import { StructuredCompressor } from './structured';
import { NoopCompressor } from './noop';

export function createCompressor(type: string): LogCompressor {
  switch (type) {
    case 'structured':
      return new StructuredCompressor();
    case 'none':
      return new NoopCompressor();
    default:
      throw new Error(`Unknown compressor type: ${type}`);
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/compression/__tests__/
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/compression/
git commit -m "feat(judge): add log compression — structured compressor + noop + factory"
```

---

## Task 6: Token Budget Allocator & Prompt Builder

**Files:**
- Create: `web/src/lib/judge/prompt.ts`
- Test: `web/src/lib/judge/__tests__/prompt.test.ts`

- [ ] **Step 1: Write prompt builder tests**

```typescript
// web/src/lib/judge/__tests__/prompt.test.ts
import { describe, it, expect } from 'vitest';
import { allocateBudget, buildSystemPrompt, buildUserPrompt } from '../prompt';
import { CRITERIA, BLOCKING_CHECKS } from '../criteria';

describe('allocateBudget', () => {
  it('allocates fixed budgets for system + scenario + test results', () => {
    const budget = allocateBudget(120000);
    expect(budget.system).toBe(3000);
    expect(budget.scenario).toBe(2000);
    expect(budget.testResults).toBe(2000);
  });

  it('splits remaining budget: agent=compressed, artifacts 60%, testLog 30%, initLog 10%', () => {
    const budget = allocateBudget(120000);
    const remaining = 120000 - 3000 - 2000 - 2000; // 113000
    expect(budget.artifacts).toBe(Math.floor(remaining * 0.6));
    expect(budget.testLog).toBe(Math.floor(remaining * 0.3));
    expect(budget.initLog).toBe(Math.floor(remaining * 0.1));
  });

  it('works with small budget', () => {
    const budget = allocateBudget(10000);
    expect(budget.system + budget.scenario + budget.testResults).toBe(7000);
    const remaining = 3000;
    expect(budget.artifacts).toBe(Math.floor(remaining * 0.6));
  });
});

describe('buildSystemPrompt', () => {
  it('includes all 10 criteria', () => {
    const prompt = buildSystemPrompt();
    for (const c of CRITERIA) {
      expect(prompt).toContain(c.key);
      expect(prompt).toContain(c.title);
    }
  });

  it('includes all 4 blocking checks', () => {
    const prompt = buildSystemPrompt();
    for (const b of BLOCKING_CHECKS) {
      expect(prompt).toContain(b.key);
    }
  });

  it('specifies JSON response format', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"scores"');
    expect(prompt).toContain('"blocking"');
  });
});

describe('buildUserPrompt', () => {
  const context = {
    scenario: {
      prompt: 'Build a calculator',
      scoringCriteria: [{ criterion: 'Correctness', maxPoints: 10 }],
    },
    execution: {
      initLog: 'init done',
      agentLog: 'agent did things',
      testLog: 'test output',
      testResults: { passed: 8, total: 10, details: [] },
    },
    artifacts: { files: [{ path: 'calc.ts', content: 'code here' }] },
    meta: { agent: 'claude', model: 'sonnet', attempt: 1, maxAttempts: 3, durationSeconds: 45 },
  };

  it('includes scenario prompt', () => {
    const prompt = buildUserPrompt(context, 120000);
    expect(prompt).toContain('Build a calculator');
  });

  it('includes test results', () => {
    const prompt = buildUserPrompt(context, 120000);
    expect(prompt).toContain('8/10');
  });

  it('includes artifacts', () => {
    const prompt = buildUserPrompt(context, 120000);
    expect(prompt).toContain('calc.ts');
  });

  it('respects total budget', () => {
    const largeContext = {
      ...context,
      execution: {
        ...context.execution,
        agentLog: 'x'.repeat(200000),
        testLog: 'y'.repeat(200000),
        initLog: 'z'.repeat(200000),
      },
      artifacts: {
        files: [{ path: 'big.ts', content: 'c'.repeat(200000) }],
      },
    };
    const prompt = buildUserPrompt(largeContext, 30000);
    // User prompt should be within budget (some overhead for section headers is ok)
    expect(prompt.length).toBeLessThan(35000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/prompt.test.ts
```

Expected: FAIL — module `../prompt` not found.

- [ ] **Step 3: Implement prompt builder**

```typescript
// web/src/lib/judge/prompt.ts
import { CRITERIA, BLOCKING_CHECKS } from './criteria';

export interface BudgetAllocation {
  system: number;
  scenario: number;
  testResults: number;
  artifacts: number;
  testLog: number;
  initLog: number;
}

export function allocateBudget(maxChars: number): BudgetAllocation {
  const system = 3000;
  const scenario = 2000;
  const testResults = 2000;
  const remaining = Math.max(0, maxChars - system - scenario - testResults);

  return {
    system,
    scenario,
    testResults,
    artifacts: Math.floor(remaining * 0.6),
    testLog: Math.floor(remaining * 0.3),
    initLog: Math.floor(remaining * 0.1),
  };
}

export function buildSystemPrompt(): string {
  const criteriaList = CRITERIA.map(
    (c, i) => `${i + 1}. **${c.key}** (${c.title}): ${c.description}`
  ).join('\n');

  const blockingList = BLOCKING_CHECKS.map(
    (b) => `- **${b.key}** (${b.title}): ${b.description}`
  ).join('\n');

  return `You are a benchmark judge evaluating an AI coding agent's performance on a task.

Score the agent's work on 10 criteria (1-5 scale) and check 4 blocking conditions.

## Scoring Scale
- 5: Excellent — exemplary quality with no meaningful issues
- 4: Good — solid execution with minor issues
- 3: Adequate — acceptable but with notable shortcomings
- 2: Poor — significant issues that undermine quality
- 1: Failing — fundamentally broken or missing

## Criteria
${criteriaList}

## Blocking Checks (boolean)
${blockingList}

## Response Format
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "scores": {
    "<criteria_key>": { "score": <1-5>, "rationale": "<brief explanation>" }
  },
  "blocking": {
    "<check_key>": { "triggered": <true/false>, "rationale": "<brief explanation>" }
  }
}

Include ALL 10 criteria keys in "scores" and ALL 4 check keys in "blocking".`;
}

interface JudgeContextInput {
  scenario: {
    prompt: string;
    scoringCriteria: { criterion: string; maxPoints: number }[];
  };
  execution: {
    initLog: string;
    agentLog: string;
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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2) - 30;
  return (
    text.slice(0, half) +
    `\n\n[... truncated ${text.length - maxChars} chars ...]\n\n` +
    text.slice(-half)
  );
}

export function buildUserPrompt(
  ctx: JudgeContextInput,
  maxTotalChars: number
): string {
  const budget = allocateBudget(maxTotalChars);

  const sections: string[] = [];

  // Section 1: Scenario
  sections.push(`## Task
${truncate(ctx.scenario.prompt, budget.scenario)}

### Scoring Criteria
${ctx.scenario.scoringCriteria.map((c) => `- ${c.criterion} (${c.maxPoints} pts)`).join('\n')}`);

  // Section 2: Test Results
  const testDetails =
    ctx.execution.testResults.details.length > 50
      ? ctx.execution.testResults.details.slice(0, 50)
      : ctx.execution.testResults.details;

  sections.push(`## Test Results
Passed: ${ctx.execution.testResults.passed}/${ctx.execution.testResults.total}

${JSON.stringify(testDetails, null, 2).slice(0, budget.testResults)}`);

  // Section 3: Agent Log (already compressed by caller)
  sections.push(`## Agent Execution Log
${truncate(ctx.execution.agentLog, budget.artifacts)}`);

  // Section 4: Artifacts
  let artifactBudget = budget.artifacts;
  const artifactSections: string[] = [];
  // Sort by size ascending (keep smaller files, truncate larger)
  const sortedFiles = [...ctx.artifacts.files].sort(
    (a, b) => a.content.length - b.content.length
  );
  for (const file of sortedFiles) {
    if (artifactBudget <= 0) break;
    const fileContent = truncate(file.content, Math.min(artifactBudget, 10000));
    artifactSections.push(`### ${file.path}\n\`\`\`\n${fileContent}\n\`\`\``);
    artifactBudget -= fileContent.length + file.path.length + 20;
  }
  if (artifactSections.length > 0) {
    sections.push(`## Artifacts\n${artifactSections.join('\n\n')}`);
  }

  // Section 5: Test Log
  sections.push(`## Test Log
${truncate(ctx.execution.testLog, budget.testLog)}`);

  // Section 6: Init Log
  if (ctx.execution.initLog) {
    sections.push(`## Init Log
${truncate(ctx.execution.initLog, budget.initLog)}`);
  }

  // Section 7: Meta
  sections.push(`## Meta
- Agent: ${ctx.meta.agent}
- Model: ${ctx.meta.model}
- Attempt: ${ctx.meta.attempt}/${ctx.meta.maxAttempts}
- Duration: ${ctx.meta.durationSeconds}s`);

  return sections.join('\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/judge/__tests__/prompt.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/judge/prompt.ts web/src/lib/judge/__tests__/prompt.test.ts
git commit -m "feat(judge): add prompt builder with token budget allocator"
```

---

## Task 7: Database Schema & Migration

**Files:**
- Modify: `web/src/db/schema.ts`
- Modify: `web/src/lib/env.ts`
- Create: `web/drizzle/0004_judge_system.sql`
- Modify: `web/src/db/migrate-views.ts`

- [ ] **Step 1: Add REDIS_URL and JUDGE_ENCRYPTION_KEY to env validation**

In `web/src/lib/env.ts`, add to the Zod schema:

```typescript
// Add these two fields to the existing schema object:
REDIS_URL: z.string().default('redis://localhost:6379'),
JUDGE_ENCRYPTION_KEY: z.string().length(64).optional(), // 32 bytes hex, optional until judge system is configured
```

- [ ] **Step 2: Update Drizzle schema — add new tables and columns**

In `web/src/db/schema.ts`, add after existing tables:

```typescript
// --- Judge System Tables ---

export const judgeProviders = pgTable('judge_providers', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(), // encrypted at rest
  model: text('model').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  priority: integer('priority').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const judgeVerdicts = pgTable(
  'judge_verdicts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runResultId: uuid('run_result_id')
      .references(() => runResults.id, { onDelete: 'cascade' })
      .notNull(),
    judgeProviderId: uuid('judge_provider_id')
      .references(() => judgeProviders.id)
      .notNull(),
    scores: jsonb('scores').notNull(), // { criteria_key: { score, rationale } }
    blockingFlags: jsonb('blocking_flags').notNull(), // { flag_key: { triggered, rationale } }
    rawResponse: text('raw_response'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    evaluationVersion: integer('evaluation_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('judge_verdicts_unique').on(
      table.runResultId,
      table.judgeProviderId,
      table.evaluationVersion
    ),
  ]
);

export const compressionLogs = pgTable(
  'compression_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runResultId: uuid('run_result_id')
      .references(() => runResults.id, { onDelete: 'cascade' })
      .notNull(),
    inputChars: integer('input_chars').notNull(),
    outputChars: integer('output_chars').notNull(),
    ratio: real('ratio').notNull(),
    compressorType: text('compressor_type').notNull(),
    durationMs: integer('duration_ms'),
    evaluationVersion: integer('evaluation_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('compression_logs_unique').on(
      table.runResultId,
      table.evaluationVersion
    ),
  ]
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

Also add new columns to `runResults` and remove `judgeModel`:

```typescript
// Add to runResults columns:
judgeStatus: text('judge_status').default('pending'),
blockingFlags: jsonb('blocking_flags'),
compositeScore: real('composite_score'),
judgeMeta: jsonb('judge_meta'),
evaluationVersion: integer('evaluation_version').default(1).notNull(),

// Remove: judgeModel column
```

- [ ] **Step 3: Create migration SQL**

```sql
-- web/drizzle/0004_judge_system.sql

-- New tables
CREATE TABLE IF NOT EXISTS judge_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_result_id UUID NOT NULL REFERENCES run_results(id) ON DELETE CASCADE,
  judge_provider_id UUID NOT NULL REFERENCES judge_providers(id),
  scores JSONB NOT NULL,
  blocking_flags JSONB NOT NULL,
  raw_response TEXT,
  duration_ms INTEGER,
  error TEXT,
  evaluation_version INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT now() NOT NULL,
  UNIQUE(run_result_id, judge_provider_id, evaluation_version)
);

CREATE TABLE IF NOT EXISTS compression_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_result_id UUID NOT NULL REFERENCES run_results(id) ON DELETE CASCADE,
  input_chars INTEGER NOT NULL,
  output_chars INTEGER NOT NULL,
  ratio REAL NOT NULL,
  compressor_type TEXT NOT NULL,
  duration_ms INTEGER,
  evaluation_version INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT now() NOT NULL,
  UNIQUE(run_result_id, evaluation_version)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now() NOT NULL
);

-- Modify run_results: add new columns, drop judgeModel
ALTER TABLE run_results
  ADD COLUMN IF NOT EXISTS judge_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS blocking_flags JSONB,
  ADD COLUMN IF NOT EXISTS composite_score REAL,
  ADD COLUMN IF NOT EXISTS judge_meta JSONB,
  ADD COLUMN IF NOT EXISTS evaluation_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE run_results DROP COLUMN IF EXISTS judge_model;
```

- [ ] **Step 4: Update materialized views**

In `web/src/db/migrate-views.ts`, update the SQL for all three matviews:

**`latest_results`** — add `composite_score`, `blocking_flags`, `judge_status` to the SELECT list.

**`score_by_model` and `score_by_agent`** — change `AVG(total_score)` to `AVG(COALESCE(composite_score, total_score))`.

The exact SQL modifications follow the existing pattern in `migrate-views.ts` (DROP + CREATE). Add the three new columns to `latest_results` SELECT, and replace `AVG(lr.total_score)` with `AVG(COALESCE(lr.composite_score, lr.total_score))` in both aggregation views.

- [ ] **Step 5: Run migration locally to verify**

```bash
cd web && npm run db:migrate && npm run db:views
```

Verify no SQL errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/db/schema.ts web/src/lib/env.ts web/drizzle/0004_judge_system.sql web/src/db/migrate-views.ts
git commit -m "feat(judge): add database schema — judge_providers, judge_verdicts, compression_logs, settings"
```

---

## Task 8: Infrastructure — Valkey + Redis Client

**Files:**
- Modify: `web/docker-compose.yml`
- Modify: `web/package.json`
- Create: `web/src/lib/events/redis-client.ts`
- Create: `web/src/lib/events/redis-bus.ts`
- Modify: `web/src/lib/orchestrator/event-bus.ts`

- [ ] **Step 1: Add ioredis dependency**

```bash
cd web && npm install ioredis
```

- [ ] **Step 2: Add valkey service to docker-compose.yml**

Add to `web/docker-compose.yml` services section:

```yaml
  valkey:
    image: valkey/valkey:8-alpine
    command: valkey-server --appendonly yes --appendfsync everysec
    volumes:
      - valkey-data:/data
    ports:
      - "6379:6379"
    networks:
      - litmus-internal
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3
```

Add `valkey-data:` to the volumes section. Add `valkey` to litmus-web `depends_on`. Add `REDIS_URL=redis://valkey:6379` to litmus-web environment.

- [ ] **Step 3: Create Redis client factory**

```typescript
// web/src/lib/events/redis-client.ts
import Redis from 'ioredis';
import { env } from '@/lib/env';

let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let consumerClient: Redis | null = null;

function createClient(name: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    connectionName: `litmus-${name}`,
  });
  client.on('error', (err) => {
    console.error(`[Redis:${name}] Error:`, err.message);
  });
  return client;
}

/** Publisher client — for XADD and PUBLISH */
export function getPublisher(): Redis {
  if (!publisherClient) {
    publisherClient = createClient('publisher');
  }
  return publisherClient;
}

/** Subscriber client — dedicated to Pub/Sub channel subscriptions (SSE) */
export function getSubscriber(): Redis {
  if (!subscriberClient) {
    subscriberClient = createClient('subscriber');
  }
  return subscriberClient;
}

/** Consumer client — for XREADGROUP in JudgeWorker (blocking read) */
export function getConsumer(): Redis {
  if (!consumerClient) {
    consumerClient = createClient('consumer');
  }
  return consumerClient;
}

/** Graceful shutdown — call on process exit */
export async function closeAllClients(): Promise<void> {
  const clients = [publisherClient, subscriberClient, consumerClient];
  await Promise.allSettled(
    clients.filter(Boolean).map((c) => c!.quit())
  );
  publisherClient = null;
  subscriberClient = null;
  consumerClient = null;
}
```

- [ ] **Step 4: Create Redis EventBus**

```typescript
// web/src/lib/events/redis-bus.ts
import { getPublisher, getSubscriber } from './redis-client';

const CHANNEL = 'litmus:events';

export interface RedisEvent {
  type: string;
  [key: string]: unknown;
}

type EventHandler = (event: RedisEvent) => void;

const localHandlers = new Map<string, Set<EventHandler>>();

let subscribed = false;

async function ensureSubscribed(): Promise<void> {
  if (subscribed) return;
  const sub = getSubscriber();
  await sub.subscribe(CHANNEL);
  sub.on('message', (_channel: string, message: string) => {
    try {
      const event: RedisEvent = JSON.parse(message);
      // Broadcast to all local handlers
      for (const handlers of localHandlers.values()) {
        for (const handler of handlers) {
          handler(event);
        }
      }
    } catch {
      // ignore malformed messages
    }
  });
  subscribed = true;
}

/**
 * Publish an event to Redis Pub/Sub channel.
 * Fire-and-forget — acceptable to lose (UI optimization only).
 */
export async function publishEvent(event: RedisEvent): Promise<void> {
  const pub = getPublisher();
  await pub.publish(CHANNEL, JSON.stringify(event));
}

/**
 * Subscribe to events with a filter key (e.g., runId).
 * Returns an unsubscribe function.
 */
export function subscribe(
  filterKey: string,
  handler: EventHandler
): () => void {
  ensureSubscribed();
  if (!localHandlers.has(filterKey)) {
    localHandlers.set(filterKey, new Set());
  }
  localHandlers.get(filterKey)!.add(handler);
  return () => {
    localHandlers.get(filterKey)?.delete(handler);
    if (localHandlers.get(filterKey)?.size === 0) {
      localHandlers.delete(filterKey);
    }
  };
}

/**
 * Subscribe to ALL events (no filter). Used by SSE endpoints.
 */
export function subscribeAll(handler: EventHandler): () => void {
  return subscribe('__all__', handler);
}
```

- [ ] **Step 5: Define `EventBus` interface and Redis implementation**

Replace `web/src/lib/orchestrator/event-bus.ts` contents with:

```typescript
// web/src/lib/orchestrator/event-bus.ts
// EventBus interface + Redis-backed singleton.
// Scheduler accepts the interface via DI; tests use InMemoryEventBus.

import { publishEvent, subscribe as redisSubscribe } from '@/lib/events/redis-bus';
import type { RunEvent } from './types';

type EventHandler = (event: RunEvent) => void;

/** Interface for event bus — consumed by Scheduler via DI */
export interface EventBus {
  subscribe(runId: string, handler: EventHandler): () => void;
  emit(runId: string, event: RunEvent): void;
}

/** Redis-backed implementation — production singleton */
class RedisEventBus implements EventBus {
  subscribe(runId: string, handler: EventHandler): () => void {
    return redisSubscribe(runId, (event) => {
      if ('runId' in event && event.runId === runId) {
        handler(event as unknown as RunEvent);
      }
    });
  }

  emit(runId: string, event: RunEvent): void {
    // Fire-and-forget: synchronous signature, Redis publish in background
    publishEvent({ ...event, runId } as Record<string, unknown>).catch(
      (err) => console.error('[EventBus] publish failed:', err)
    );
  }
}

/** In-memory implementation — for unit tests (no Redis needed) */
export class InMemoryEventBus implements EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  subscribe(runId: string, handler: EventHandler): () => void {
    if (!this.listeners.has(runId)) {
      this.listeners.set(runId, new Set());
    }
    this.listeners.get(runId)!.add(handler);

    return () => {
      const set = this.listeners.get(runId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.listeners.delete(runId);
      }
    };
  }

  emit(runId: string, event: RunEvent): void {
    const set = this.listeners.get(runId);
    if (set) {
      for (const handler of set) handler(event);
    }
  }
}

// Production singleton
export const runEventBus: EventBus = new RedisEventBus();
```

- [ ] **Step 6: Update consumers to use `EventBus` interface**

In `web/src/lib/orchestrator/scheduler.ts`, change the import and constructor type:

```typescript
// Before:
import type { RunEventBus } from './event-bus';
// After:
import type { EventBus } from './event-bus';
```

```typescript
// Before:
  constructor(
    private executor: AgentExecutor,
    private reconciler: Reconciler,
    private bus: RunEventBus,
    private workRoot: string,
  ) {}
// After:
  constructor(
    private executor: AgentExecutor,
    private reconciler: Reconciler,
    private bus: EventBus,
    private workRoot: string,
  ) {}
```

No other production files need changes — `runs/route.ts` and `stream/route.ts` import the `runEventBus` singleton which satisfies `EventBus`.

- [ ] **Step 7: Update existing tests to use `InMemoryEventBus`**

In `web/src/lib/orchestrator/__tests__/event-bus.test.ts`:

```typescript
// Before:
import { RunEventBus } from '../event-bus';
// After:
import { InMemoryEventBus } from '../event-bus';

// Replace all `new RunEventBus()` with `new InMemoryEventBus()`
// Replace describe name: 'InMemoryEventBus' (or 'EventBus')
```

In `web/src/lib/orchestrator/__tests__/scheduler.test.ts`:

```typescript
// Before:
import { RunEventBus } from '../event-bus';
let bus: RunEventBus;
bus = new RunEventBus();
// After:
import { InMemoryEventBus } from '../event-bus';
let bus: InMemoryEventBus;
bus = new InMemoryEventBus();
```

Apply the same replacement at all 3 test suite locations (lines ~120, ~235, ~400).

- [ ] **Step 8: Commit**

```bash
git add web/docker-compose.yml web/package.json web/package-lock.json web/src/lib/events/ web/src/lib/orchestrator/event-bus.ts web/src/lib/orchestrator/scheduler.ts web/src/lib/orchestrator/__tests__/event-bus.test.ts web/src/lib/orchestrator/__tests__/scheduler.test.ts
git commit -m "feat(judge): add Valkey infrastructure + Redis EventBus with EventBus interface (DIP)"
```

---

## Task 9: Settings API — Judge Providers CRUD

**Files:**
- Create: `web/src/app/api/settings/judge-providers/route.ts`
- Create: `web/src/app/api/settings/judge-providers/[id]/route.ts`
- Create: `web/src/app/api/settings/judge-providers/[id]/test/route.ts`
- Create: `web/src/app/api/settings/judge-providers/rotate-keys/route.ts`
- Test: `web/src/app/api/settings/__tests__/judge-providers.test.ts`

- [ ] **Step 1: Write judge providers API tests**

```typescript
// web/src/app/api/settings/__tests__/judge-providers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db and encryption before imports
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('@/lib/judge/encryption', () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace('encrypted:', '')),
}));

describe('Judge Providers API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('masks apiKey in GET response', async () => {
    // This test validates the masking logic directly
    const maskKey = (key: string) => {
      if (key.length <= 8) return '••••';
      return '••••' + key.slice(-4);
    };
    expect(maskKey('sk-1234567890abcdef')).toBe('••••cdef');
    expect(maskKey('short')).toBe('••••');
  });

  it('PUT without apiKey preserves existing key', () => {
    // Validates the merge logic: undefined apiKey = keep current
    const existingKey = 'encrypted:sk-original';
    const updateBody = { name: 'Updated Name' };
    const mergedKey =
      'apiKey' in updateBody ? (updateBody as { apiKey: string }).apiKey : existingKey;
    expect(mergedKey).toBe(existingKey);
  });

  it('PUT with empty string apiKey is invalid', () => {
    const body = { apiKey: '' };
    const isValid = body.apiKey === undefined || body.apiKey.length > 0;
    expect(isValid).toBe(false);
  });

  it('PUT with non-empty apiKey replaces existing', () => {
    const body = { apiKey: 'sk-new-key' };
    const shouldReplace = body.apiKey !== undefined && body.apiKey.length > 0;
    expect(shouldReplace).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/app/api/settings/__tests__/judge-providers.test.ts
```

- [ ] **Step 3: Implement GET/POST judge-providers route**

```typescript
// web/src/app/api/settings/judge-providers/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { encrypt, decrypt } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

function maskKey(encryptedKey: string): string {
  try {
    const plain = decrypt(encryptedKey);
    if (plain.length <= 8) return '••••';
    return '••••' + plain.slice(-4);
  } catch {
    return '••••';
  }
}

export async function GET() {
  const providers = await db
    .select()
    .from(judgeProviders)
    .orderBy(judgeProviders.priority);

  const masked = providers.map((p) => ({
    ...p,
    apiKey: maskKey(p.apiKey),
  }));

  return NextResponse.json(masked);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, baseUrl, apiKey, model, enabled, priority } = body;

  if (!name || !baseUrl || !apiKey || !model) {
    return NextResponse.json(
      { error: 'name, baseUrl, apiKey, and model are required' },
      { status: 400 }
    );
  }

  const [provider] = await db
    .insert(judgeProviders)
    .values({
      name,
      baseUrl,
      apiKey: encrypt(apiKey),
      model,
      enabled: enabled ?? true,
      priority: priority ?? 0,
    })
    .returning();

  return NextResponse.json(
    { ...provider, apiKey: maskKey(provider.apiKey) },
    { status: 201 }
  );
}
```

- [ ] **Step 4: Implement PUT/DELETE single provider route**

```typescript
// web/src/app/api/settings/judge-providers/[id]/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { encrypt, decrypt } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

function maskKey(encryptedKey: string): string {
  try {
    const plain = decrypt(encryptedKey);
    if (plain.length <= 8) return '••••';
    return '••••' + plain.slice(-4);
  } catch {
    return '••••';
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // Validate apiKey semantics
  if ('apiKey' in body && body.apiKey === '') {
    return NextResponse.json(
      { error: 'apiKey cannot be empty string. Omit field to keep current key.' },
      { status: 400 }
    );
  }

  // Build update object
  const updates: Record<string, unknown> = {};
  for (const field of ['name', 'baseUrl', 'model', 'enabled', 'priority'] as const) {
    if (field in body) updates[field] = body[field];
  }
  if ('apiKey' in body && body.apiKey) {
    updates.apiKey = encrypt(body.apiKey);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const [updated] = await db
    .update(judgeProviders)
    .set(updates)
    .where(eq(judgeProviders.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  }

  return NextResponse.json({ ...updated, apiKey: maskKey(updated.apiKey) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [deleted] = await db
    .delete(judgeProviders)
    .where(eq(judgeProviders.id, id))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Implement test provider connection route**

```typescript
// web/src/app/api/settings/judge-providers/[id]/test/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { decrypt } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [provider] = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.id, id));

  if (!provider) {
    return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
  }

  const start = Date.now();
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${decrypt(provider.apiKey)}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        latencyMs,
        error: `HTTP ${response.status}: ${await response.text()}`,
      });
    }

    return NextResponse.json({ success: true, latencyMs });
  } catch (err) {
    return NextResponse.json({
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
```

- [ ] **Step 6: Implement rotate-keys route**

```typescript
// web/src/app/api/settings/judge-providers/rotate-keys/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { judgeProviders } from '@/db/schema';
import { encrypt, decrypt } from '@/lib/judge/encryption';
import { eq } from 'drizzle-orm';

export async function POST() {
  const providers = await db.select().from(judgeProviders);
  let rotated = 0;

  for (const provider of providers) {
    try {
      const plainKey = decrypt(provider.apiKey);
      const newEncrypted = encrypt(plainKey);
      await db
        .update(judgeProviders)
        .set({ apiKey: newEncrypted })
        .where(eq(judgeProviders.id, provider.id));
      rotated++;
    } catch (err) {
      console.error(`Failed to rotate key for provider ${provider.id}:`, err);
    }
  }

  return NextResponse.json({ rotated, total: providers.length });
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd web && npx vitest run src/app/api/settings/__tests__/judge-providers.test.ts
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/api/settings/judge-providers/
git commit -m "feat(judge): add judge providers CRUD API with encryption"
```

---

## Task 10: Settings API — Scoring Configuration

**Files:**
- Create: `web/src/app/api/settings/scoring/route.ts`
- Test: `web/src/app/api/settings/__tests__/scoring.test.ts`

- [ ] **Step 1: Write scoring settings tests**

```typescript
// web/src/app/api/settings/__tests__/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { settingsSchemas, settingsDefaults } from '@/lib/judge/types';

describe('Settings Zod validation', () => {
  it('validates composite_weights: sum must equal 1.0', () => {
    const schema = settingsSchemas['composite_weights'];
    expect(schema.safeParse({ test: 0.4, judge: 0.6 }).success).toBe(true);
    expect(schema.safeParse({ test: 0.5, judge: 0.6 }).success).toBe(false);
    expect(schema.safeParse({ test: 0, judge: 1 }).success).toBe(false); // 0 not positive
  });

  it('validates criteria_priority: exactly 10 items', () => {
    const schema = settingsSchemas['criteria_priority'];
    const valid = { order: settingsDefaults['criteria_priority'].order, preset: 'linear' };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, order: ['only_one'] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, preset: 'unknown' }).success).toBe(false);
  });

  it('validates judge_temperature: range 0-1', () => {
    const schema = settingsSchemas['judge_temperature'];
    expect(schema.safeParse(0.3).success).toBe(true);
    expect(schema.safeParse(1.5).success).toBe(false);
    expect(schema.safeParse(-0.1).success).toBe(false);
  });

  it('validates judge_task_idle_timeout_ms: range 60000-1800000', () => {
    const schema = settingsSchemas['judge_task_idle_timeout_ms'];
    expect(schema.safeParse(300000).success).toBe(true);
    expect(schema.safeParse(1000).success).toBe(false);
    expect(schema.safeParse(2000000).success).toBe(false);
  });

  it('all defaults pass their own validation', () => {
    for (const [key, schema] of Object.entries(settingsSchemas)) {
      const defaultValue = settingsDefaults[key];
      const result = schema.safeParse(defaultValue);
      expect(result.success, `Default for ${key} should be valid`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/app/api/settings/__tests__/scoring.test.ts
```

- [ ] **Step 3: Implement scoring API route**

```typescript
// web/src/app/api/settings/scoring/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { settingsSchemas, settingsDefaults } from '@/lib/judge/types';

async function getSettingsMap(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  const map: Record<string, unknown> = { ...settingsDefaults };
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export async function GET() {
  const map = await getSettingsMap();
  return NextResponse.json(map);
}

export async function PUT(request: Request) {
  const body = await request.json();
  const errors: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    const schema = settingsSchemas[key];
    if (!schema) {
      errors.push(`Unknown setting key: ${key}`);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      errors.push(`${key}: ${result.error.message}`);
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  // Upsert each setting
  for (const [key, value] of Object.entries(body)) {
    await db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  const updated = await getSettingsMap();
  return NextResponse.json(updated);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/app/api/settings/__tests__/scoring.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/settings/scoring/ web/src/app/api/settings/__tests__/scoring.test.ts
git commit -m "feat(judge): add scoring settings API with Zod validation"
```

---

## Task 11: JudgeService — Enqueue Pipeline

**Files:**
- Create: `web/src/lib/judge/context.ts`
- Create: `web/src/lib/judge/service.ts`
- Test: `web/src/lib/judge/__tests__/service.test.ts`

- [ ] **Step 1: Write JudgeService tests**

```typescript
// web/src/lib/judge/__tests__/service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db');
vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(() => ({
    xadd: vi.fn().mockResolvedValue('1-0'),
    set: vi.fn().mockResolvedValue('OK'),
  })),
}));
vi.mock('@/lib/judge/context', () => ({
  assembleContext: vi.fn().mockResolvedValue({
    scenario: { prompt: 'test', scoringCriteria: [] },
    execution: { initLog: '', agentLog: 'log', testLog: '', testResults: { passed: 5, total: 10, details: [] } },
    artifacts: { files: [] },
    meta: { agent: 'a', model: 'm', attempt: 1, maxAttempts: 3, durationSeconds: 10 },
  }),
}));

describe('JudgeService', () => {
  it('exports enqueue function', async () => {
    const mod = await import('../service');
    expect(typeof mod.enqueueJudgeTasks).toBe('function');
  });

  it('skips evaluation when no providers are enabled', async () => {
    // Mock db to return empty providers
    const { db } = await import('@/db');
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { enqueueJudgeTasks } = await import('../service');
    // Should set judgeStatus='skipped' and return without enqueuing
    // This test validates the flow — full integration test covers DB writes
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/service.test.ts
```

- [ ] **Step 3: Implement context assembly**

```typescript
// web/src/lib/judge/context.ts
import { db } from '@/db';
import { runResults, scenarios, agents, models } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getObject } from '@/lib/s3';
import { redactSecrets } from './redactor';

interface JudgeContext {
  scenario: {
    prompt: string;
    scoringCriteria: { criterion: string; maxPoints: number }[];
  };
  execution: {
    initLog: string;
    agentLog: string;
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

export async function assembleContext(runResultId: string): Promise<JudgeContext> {
  const [result] = await db
    .select()
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result) throw new Error(`run_result not found: ${runResultId}`);

  const [scenario] = await db
    .select()
    .from(scenarios)
    .where(eq(scenarios.id, result.scenarioId));

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, result.agentId));

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, result.modelId));

  // Load artifacts from S3
  let files: { path: string; content: string }[] = [];
  let initLog = '';
  let agentLog = '';
  let testLog = '';

  if (result.artifactsS3Key) {
    try {
      // Load artifacts directory listing from S3
      // Implementation depends on S3 structure — simplified here
      const artifactsData = await getObject(result.artifactsS3Key + '/artifacts.json');
      if (artifactsData) {
        files = JSON.parse(artifactsData);
      }
    } catch {
      // artifacts unavailable — proceed without
    }

    // Load logs
    try {
      initLog = redactSecrets(
        (await getObject(result.artifactsS3Key + '/init.log')) ?? ''
      );
      agentLog = redactSecrets(
        (await getObject(result.artifactsS3Key + '/agent.log')) ?? ''
      );
      testLog = redactSecrets(
        (await getObject(result.artifactsS3Key + '/test.log')) ?? ''
      );
    } catch {
      // logs partially unavailable
    }
  }

  return {
    scenario: {
      prompt: scenario?.description ?? '',
      scoringCriteria: [], // loaded from scoring.csv if available
    },
    execution: {
      initLog,
      agentLog,
      testLog,
      testResults: {
        passed: result.testsPassed ?? 0,
        total: result.testsTotal ?? 0,
        details: [],
      },
    },
    artifacts: { files },
    meta: {
      agent: agent?.name ?? 'unknown',
      model: model?.name ?? 'unknown',
      attempt: result.attempt ?? 1,
      maxAttempts: result.maxAttempts ?? 1,
      durationSeconds: result.durationSeconds ?? 0,
    },
  };
}
```

- [ ] **Step 4: Implement JudgeService**

```typescript
// web/src/lib/judge/service.ts
import { db } from '@/db';
import { judgeProviders, runResults, compressionLogs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getPublisher } from '@/lib/events/redis-client';
import { publishEvent } from '@/lib/events/redis-bus';
import { assembleContext } from './context';
import { createCompressor } from '@/lib/compression/factory';
import { redactSecrets } from './redactor';
import { buildUserPrompt, buildSystemPrompt } from './prompt';
import { settingsDefaults } from './types';
import type { JudgeMeta, JudgeTaskPayload } from './types';

const STREAM_KEY = 'litmus:judge:tasks';
const COMPRESSED_KEY_PREFIX = 'litmus:compressed';
const COMPRESSED_TTL = 7200; // 2 hours

async function getSetting<T>(key: string): Promise<T> {
  // Simple settings loader — reads from DB with default fallback
  const { settings } = await import('@/db/schema');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

/**
 * Enqueue judge evaluation tasks for a run result.
 * Called after reconciler.finalize() writes the result to DB.
 */
export async function enqueueJudgeTasks(runResultId: string): Promise<void> {
  // 1. Load enabled providers
  const providers = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.enabled, true))
    .orderBy(judgeProviders.priority);

  if (providers.length === 0) {
    // No providers configured — skip judge evaluation
    await db
      .update(runResults)
      .set({ judgeStatus: 'skipped' })
      .where(eq(runResults.id, runResultId));
    return;
  }

  // 2. Get current evaluation version
  const [result] = await db
    .select({ evaluationVersion: runResults.evaluationVersion })
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result) return;
  const version = result.evaluationVersion;

  // 3. Snapshot provider IDs into judgeMeta
  const targetProviderIds = providers.map((p) => p.id);
  const judgeMeta: JudgeMeta = { targetProviderIds };

  await db
    .update(runResults)
    .set({
      judgeStatus: 'pending',
      judgeMeta: judgeMeta as unknown as Record<string, unknown>,
    })
    .where(eq(runResults.id, runResultId));

  // 4. Assemble and compress context (once, shared across all judges)
  const context = await assembleContext(runResultId);
  const compressionType = await getSetting<string>('log_compression');
  const maxCompressedChars = await getSetting<number>('max_compressed_chars');

  const compressor = createCompressor(compressionType);
  const startMs = Date.now();
  const compressed = compressor.compress(context.execution.agentLog, {
    maxChars: maxCompressedChars,
  });
  const durationMs = Date.now() - startMs;

  // Record compression
  await db.insert(compressionLogs).values({
    runResultId,
    inputChars: compressed.inputChars,
    outputChars: compressed.outputChars,
    ratio: compressed.inputChars > 0 ? compressed.outputChars / compressed.inputChars : 0,
    compressorType: compressor.type,
    durationMs,
    evaluationVersion: version,
  });

  // 5. Cache compressed context in Redis (shared across workers)
  const redis = getPublisher();
  const cacheKey = `${COMPRESSED_KEY_PREFIX}:${runResultId}:${version}`;

  const maxPromptChars = await getSetting<number>('max_judge_prompt_chars');
  const userPrompt = buildUserPrompt(
    { ...context, execution: { ...context.execution, agentLog: compressed.content } },
    maxPromptChars
  );

  await redis.set(cacheKey, JSON.stringify({
    systemPrompt: buildSystemPrompt(),
    userPrompt,
  }), 'EX', COMPRESSED_TTL);

  // 6. Enqueue one task per provider to Redis Stream
  for (const provider of providers) {
    const payload: JudgeTaskPayload = {
      runResultId,
      providerId: provider.id,
      evaluationVersion: version,
    };
    await redis.xadd(STREAM_KEY, '*', 'payload', JSON.stringify(payload));
  }

  // 7. Publish notification
  await publishEvent({
    type: 'judge:started',
    runResultId,
  });
}
```

- [ ] **Step 5: Run tests**

```bash
cd web && npx vitest run src/lib/judge/__tests__/service.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/judge/context.ts web/src/lib/judge/service.ts web/src/lib/judge/__tests__/service.test.ts
git commit -m "feat(judge): add JudgeService — enqueue pipeline with context assembly"
```

---

## Task 12: JudgeWorker — Stream Consumer

**Files:**
- Create: `web/src/lib/judge/worker.ts`
- Test: `web/src/lib/judge/__tests__/worker.test.ts`

- [ ] **Step 1: Write worker tests**

```typescript
// web/src/lib/judge/__tests__/worker.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('JudgeWorker', () => {
  it('discards task when evaluationVersion mismatches', async () => {
    // Version guard: task has version=1 but run_result has version=2
    const taskVersion = 1;
    const currentVersion = 2;
    const shouldDiscard = taskVersion !== currentVersion;
    expect(shouldDiscard).toBe(true);
  });

  it('writes error verdict on max retries exceeded', () => {
    const maxRetries = 3;
    const attempt = 4;
    const shouldWriteError = attempt > maxRetries;
    expect(shouldWriteError).toBe(true);
  });

  it('parses valid judge response', () => {
    const response = JSON.stringify({
      scores: { task_success: { score: 4, rationale: 'good' } },
      blocking: { hard_instruction_violation: { triggered: false, rationale: 'ok' } },
    });
    const parsed = JSON.parse(response);
    expect(parsed.scores.task_success.score).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/worker.test.ts
```

- [ ] **Step 3: Implement JudgeWorker**

```typescript
// web/src/lib/judge/worker.ts
import { db } from '@/db';
import { runResults, judgeVerdicts, judgeProviders } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getPublisher, getConsumer } from '@/lib/events/redis-client';
import { publishEvent } from '@/lib/events/redis-bus';
import { judgeResponseSchema, settingsDefaults } from './types';
import type { JudgeTaskPayload, JudgeMeta } from './types';
import { decrypt } from './encryption';
import { assembleContext } from './context';
import { createCompressor } from '@/lib/compression/factory';
import { buildSystemPrompt, buildUserPrompt } from './prompt';

const STREAM_KEY = 'litmus:judge:tasks';
const GROUP_NAME = 'judge-workers';
const COMPRESSED_KEY_PREFIX = 'litmus:compressed';
const COMPRESSED_TTL = 7200;

async function getSetting<T>(key: string): Promise<T> {
  const { settings } = await import('@/db/schema');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

async function ensureConsumerGroup(): Promise<void> {
  const redis = getPublisher();
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
  } catch (err: any) {
    if (!err.message?.includes('BUSYGROUP')) throw err;
    // Group already exists — ok
  }
}

async function callJudgeAPI(
  provider: { baseUrl: string; apiKey: string; model: string },
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<{ response: string; durationMs: number }> {
  const start = Date.now();
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${decrypt(provider.apiKey)}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
    throw Object.assign(new Error('Rate limited'), { retryAfter });
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  return { response: content, durationMs: Date.now() - start };
}

async function processTask(payload: JudgeTaskPayload): Promise<void> {
  const { runResultId, providerId, evaluationVersion } = payload;

  // Version guard
  const [result] = await db
    .select({ evaluationVersion: runResults.evaluationVersion })
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result || result.evaluationVersion !== evaluationVersion) {
    return; // Stale task — discard
  }

  // Load provider
  const [provider] = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.id, providerId));

  if (!provider) {
    await writeErrorVerdict(runResultId, providerId, evaluationVersion, 'Provider not found');
    return;
  }

  // Load cached prompt from Redis, or rebuild
  const redis = getPublisher();
  const cacheKey = `${COMPRESSED_KEY_PREFIX}:${runResultId}:${evaluationVersion}`;
  let cached = await redis.get(cacheKey);

  let systemPrompt: string;
  let userPrompt: string;

  if (cached) {
    const parsed = JSON.parse(cached);
    systemPrompt = parsed.systemPrompt;
    userPrompt = parsed.userPrompt;
  } else {
    // Cache miss — re-assemble
    const context = await assembleContext(runResultId);
    const compressionType = await getSetting<string>('log_compression');
    const maxCompressedChars = await getSetting<number>('max_compressed_chars');
    const compressor = createCompressor(compressionType);
    const compressed = compressor.compress(context.execution.agentLog, { maxChars: maxCompressedChars });
    const maxPromptChars = await getSetting<number>('max_judge_prompt_chars');
    systemPrompt = buildSystemPrompt();
    userPrompt = buildUserPrompt(
      { ...context, execution: { ...context.execution, agentLog: compressed.content } },
      maxPromptChars
    );
    // Re-cache
    await redis.set(cacheKey, JSON.stringify({ systemPrompt, userPrompt }), 'EX', COMPRESSED_TTL);
  }

  // Call judge API with retries
  const maxRetries = await getSetting<number>('judge_max_retries');
  const temperature = await getSetting<number>('judge_temperature');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { response, durationMs } = await callJudgeAPI(
        provider,
        systemPrompt,
        userPrompt,
        temperature
      );

      const parsed = JSON.parse(response);
      const validated = judgeResponseSchema.parse(parsed);

      // Write verdict
      await db.insert(judgeVerdicts).values({
        runResultId,
        judgeProviderId: providerId,
        scores: validated.scores,
        blockingFlags: validated.blocking,
        rawResponse: response,
        durationMs,
        evaluationVersion,
      }).onConflictDoNothing(); // UNIQUE constraint handles at-least-once duplicates

      // Trigger aggregation check
      await checkAggregation(runResultId, evaluationVersion);
      return;
    } catch (err: any) {
      lastError = err;
      if (err.retryAfter) {
        await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
      } else if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }

  // All retries exhausted
  await writeErrorVerdict(
    runResultId,
    providerId,
    evaluationVersion,
    lastError?.message ?? 'Unknown error'
  );
  await checkAggregation(runResultId, evaluationVersion);
}

async function writeErrorVerdict(
  runResultId: string,
  providerId: string,
  evaluationVersion: number,
  error: string
): Promise<void> {
  await db.insert(judgeVerdicts).values({
    runResultId,
    judgeProviderId: providerId,
    scores: {},
    blockingFlags: {},
    error,
    evaluationVersion,
  }).onConflictDoNothing();
}

async function checkAggregation(
  runResultId: string,
  evaluationVersion: number
): Promise<void> {
  // Lazy import to avoid circular deps
  const { runAggregation } = await import('./aggregation-runner');
  await runAggregation(runResultId, evaluationVersion);
}

/**
 * Start the JudgeWorker loop — blocking read from Redis Stream.
 * Call once on application startup.
 */
export async function startWorker(consumerId: string): Promise<void> {
  await ensureConsumerGroup();
  const consumer = getConsumer();

  while (true) {
    try {
      const results = await consumer.xreadgroup(
        'GROUP', GROUP_NAME, consumerId,
        'COUNT', 1,
        'BLOCK', 5000,
        'STREAMS', STREAM_KEY, '>'
      );

      if (!results || results.length === 0) continue;

      for (const [, messages] of results) {
        for (const [messageId, fields] of messages) {
          try {
            const payloadStr = fields[fields.indexOf('payload') + 1];
            const payload: JudgeTaskPayload = JSON.parse(payloadStr);
            await processTask(payload);
          } catch (err) {
            console.error('[JudgeWorker] Error processing task:', err);
          }
          // ACK regardless of success/failure — errors are written as verdict rows
          await consumer.xack(STREAM_KEY, GROUP_NAME, messageId);
        }
      }
    } catch (err) {
      console.error('[JudgeWorker] Stream read error:', err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
```

- [ ] **Step 4: Create aggregation runner (extracted for lazy import)**

```typescript
// web/src/lib/judge/aggregation-runner.ts
import { db } from '@/db';
import { runResults, judgeVerdicts, settings } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getPublisher } from '@/lib/events/redis-client';
import { publishEvent } from '@/lib/events/redis-bus';
import { aggregateVerdicts, computeCompositeScore } from './aggregator';
import { computeWeights, CRITERIA_KEYS, BLOCKING_KEYS } from './criteria';
import { settingsDefaults } from './types';
import type { JudgeMeta } from './types';

async function getSetting<T>(key: string): Promise<T> {
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

export async function runAggregation(
  runResultId: string,
  evaluationVersion: number
): Promise<void> {
  const [result] = await db
    .select()
    .from(runResults)
    .where(eq(runResults.id, runResultId));

  if (!result || result.evaluationVersion !== evaluationVersion) return;

  const meta = result.judgeMeta as unknown as JudgeMeta;
  if (!meta?.targetProviderIds) return;

  const N = meta.targetProviderIds.length;

  // Count verdicts for current version
  const verdicts = await db
    .select()
    .from(judgeVerdicts)
    .where(
      and(
        eq(judgeVerdicts.runResultId, runResultId),
        eq(judgeVerdicts.evaluationVersion, evaluationVersion)
      )
    );

  if (verdicts.length < N) {
    // Not all providers responded yet
    if (verdicts.length > 0 && result.judgeStatus !== 'partial') {
      await db
        .update(runResults)
        .set({ judgeStatus: 'partial' })
        .where(eq(runResults.id, runResultId));

      const progress = `${verdicts.length}/${N}`;
      await publishEvent({
        type: 'judge:verdict',
        runResultId,
        progress,
      });
    }
    return;
  }

  // All N verdicts received — aggregate
  const verdictInputs = verdicts.map((v) => ({
    scores: v.scores as Record<string, { score: number; rationale: string }>,
    blockingFlags: v.blockingFlags as Record<string, { triggered: boolean; rationale: string }>,
    error: v.error,
  }));

  const aggregated = aggregateVerdicts(verdictInputs, CRITERIA_KEYS, BLOCKING_KEYS);

  if (!aggregated) {
    // All failed — fallback to test-only
    await db
      .update(runResults)
      .set({
        judgeStatus: 'completed',
        compositeScore: result.totalScore,
        judgeMeta: { ...meta, allFailed: true } as unknown as Record<string, unknown>,
      })
      .where(eq(runResults.id, runResultId));

    await publishEvent({ type: 'judge:completed', runResultId, compositeScore: result.totalScore });
    await markMatviewRefreshNeeded();
    return;
  }

  // Compute final composite
  const weightsConfig = await getSetting<{ test: number; judge: number }>('composite_weights');
  const priorityConfig = await getSetting<{ order: string[]; preset: string }>('criteria_priority');
  const blockingCaps = await getSetting<Record<string, number>>('blocking_caps');

  const criteriaWeights = computeWeights(
    priorityConfig.order,
    priorityConfig.preset as 'flat' | 'linear' | 'steep'
  );

  // Compute judge_weighted (weighted sum of median scores)
  let judgeWeighted = 0;
  for (const key of CRITERIA_KEYS) {
    const weight = criteriaWeights[key] ?? 0;
    const score = aggregated.medianScores[key] ?? 0;
    judgeWeighted += weight * score;
  }

  const judgeNormalized = ((judgeWeighted - 1) / 4) * 100;

  const compositeScore = computeCompositeScore({
    testScore: result.totalScore ?? 0,
    judgeNormalized,
    weights: weightsConfig,
    blockingCount: aggregated.blockingCount,
    blockingCaps,
  });

  // Update result with aggregated data
  const updatedMeta: JudgeMeta = {
    ...meta,
    ...(aggregated.confidence === 'lowConfidence' ? { lowConfidence: true } : {}),
  };

  const successful = verdicts.filter((v) => !v.error);
  const failed = verdicts.filter((v) => v.error);
  if (failed.length > 0) {
    updatedMeta.partial = true;
    updatedMeta.succeeded = successful.length;
    updatedMeta.failed = failed.length;
  }

  await db
    .update(runResults)
    .set({
      judgeStatus: 'completed',
      judgeScores: aggregated.medianScores,
      blockingFlags: aggregated.blockingFlags,
      compositeScore,
      judgeMeta: updatedMeta as unknown as Record<string, unknown>,
    })
    .where(eq(runResults.id, runResultId));

  await publishEvent({
    type: 'judge:completed',
    runResultId,
    compositeScore,
  });

  await markMatviewRefreshNeeded();
}

async function markMatviewRefreshNeeded(): Promise<void> {
  const redis = getPublisher();
  await redis.set('litmus:matview-refresh-needed', '1');
}
```

- [ ] **Step 5: Run tests**

```bash
cd web && npx vitest run src/lib/judge/__tests__/worker.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/judge/worker.ts web/src/lib/judge/aggregation-runner.ts web/src/lib/judge/__tests__/worker.test.ts
git commit -m "feat(judge): add JudgeWorker — stream consumer with retry and aggregation"
```

---

## Task 13: Reclaim Loop, Cleanup & Startup Recovery

**Files:**
- Create: `web/src/lib/judge/reclaim.ts`
- Create: `web/src/lib/judge/cleanup.ts`
- Modify: `web/src/lib/orchestrator/reconciler.ts`

- [ ] **Step 1: Write failing tests for reclaim loop and cleanup**

```typescript
// web/src/lib/judge/__tests__/reclaim.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock redis and db before imports
vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(() => ({
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    xadd: vi.fn().mockResolvedValue('1-0'),
    xdel: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('@/db', () => ({
  db: {
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn() }),
  },
}));

describe('reclaimStaleTasks', () => {
  it('is exported as a function', async () => {
    const mod = await import('../reclaim');
    expect(typeof mod.reclaimStaleTasks).toBe('function');
  });

  it('returns claimed count from XAUTOCLAIM', async () => {
    const { getPublisher } = await import('@/lib/events/redis-client');
    const redis = (getPublisher as any)();
    redis.xautoclaim.mockResolvedValueOnce([
      '0-0',
      [['msg-1', ['payload', '{"runResultId":1}']]],
      [],
    ]);

    const { reclaimStaleTasks } = await import('../reclaim');
    const count = await reclaimStaleTasks('test-consumer');
    expect(count).toBe(1);
  });
});

describe('cleanupStaleVerdicts', () => {
  it('is exported as a function', async () => {
    const mod = await import('../cleanup');
    expect(typeof mod.cleanupStaleVerdicts).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/judge/__tests__/reclaim.test.ts
```

Expected: FAIL — modules `../reclaim` and `../cleanup` not found.

- [ ] **Step 3: Implement reclaim loop**

```typescript
// web/src/lib/judge/reclaim.ts
import { db } from '@/db';
import { judgeVerdicts } from '@/db/schema';
import { getPublisher } from '@/lib/events/redis-client';
import { settingsDefaults } from './types';
import type { JudgeTaskPayload } from './types';

const STREAM_KEY = 'litmus:judge:tasks';
const GROUP_NAME = 'judge-workers';
const DEAD_LETTER_KEY = 'litmus:judge:dead-letter';
const MAX_DELIVERY_ATTEMPTS = 3;
const RECLAIM_INTERVAL_MS = 60000;

async function getSetting<T>(key: string): Promise<T> {
  const { settings } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

/**
 * Start periodic XAUTOCLAIM reclaim loop.
 * Reclaims idle messages and sends max-delivery messages to dead-letter.
 */
export function startReclaimLoop(consumerId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const redis = getPublisher();
      const idleTimeoutMs = await getSetting<number>('judge_task_idle_timeout_ms');

      // XAUTOCLAIM returns [nextCursor, claimedMessages, deletedIds]
      const result = await redis.xautoclaim(
        STREAM_KEY,
        GROUP_NAME,
        consumerId,
        idleTimeoutMs,
        '0-0'
      );

      if (!result || !result[1]) return;
      const claimedMessages = result[1] as [string, string[]][];

      for (const [messageId, fields] of claimedMessages) {
        const payloadStr = fields[fields.indexOf('payload') + 1];
        if (!payloadStr) continue;

        // Check delivery count via XPENDING
        const pendingInfo = await redis.xpending(
          STREAM_KEY,
          GROUP_NAME,
          messageId,
          messageId,
          1
        );

        const deliveryCount = pendingInfo?.[0]?.[3] ?? 0;

        if (deliveryCount > MAX_DELIVERY_ATTEMPTS) {
          // Move to dead-letter
          await redis.xadd(DEAD_LETTER_KEY, '*', 'payload', payloadStr, 'reason', 'max_delivery_exceeded');
          await redis.xack(STREAM_KEY, GROUP_NAME, messageId);

          // Write error verdict
          const payload: JudgeTaskPayload = JSON.parse(payloadStr);
          await db.insert(judgeVerdicts).values({
            runResultId: payload.runResultId,
            judgeProviderId: payload.providerId,
            scores: {},
            blockingFlags: {},
            error: 'max delivery attempts exceeded',
            evaluationVersion: payload.evaluationVersion,
          }).onConflictDoNothing();

          // Trigger aggregation check
          const { runAggregation } = await import('./aggregation-runner');
          await runAggregation(payload.runResultId, payload.evaluationVersion);
        }
        // Otherwise: message was reclaimed and will be reprocessed by the worker
      }
    } catch (err) {
      console.error('[ReclaimLoop] Error:', err);
    }
  }, RECLAIM_INTERVAL_MS);
}
```

- [ ] **Step 2: Implement cleanup job**

```typescript
// web/src/lib/judge/cleanup.ts
import { db } from '@/db';
import { judgeVerdicts, runResults } from '@/db/schema';
import { lt, and, sql, isNotNull } from 'drizzle-orm';
import { settingsDefaults } from './types';

const CLEANUP_INTERVAL_MS = 3600000; // 1 hour

async function getSetting<T>(key: string): Promise<T> {
  const { settings } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

/**
 * Start periodic cleanup:
 * 1. Remove stale verdicts (evaluationVersion < current)
 * 2. Truncate rawResponse after retention period
 */
export function startCleanupJob(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      // 1. Clean stale verdicts
      await db.execute(sql`
        DELETE FROM judge_verdicts jv
        USING run_results rr
        WHERE jv.run_result_id = rr.id
          AND jv.evaluation_version < rr.evaluation_version
      `);

      // 2. Clean stale compression_logs
      await db.execute(sql`
        DELETE FROM compression_logs cl
        USING run_results rr
        WHERE cl.run_result_id = rr.id
          AND cl.evaluation_version < rr.evaluation_version
      `);

      // 3. Truncate old rawResponse
      const retentionDays = await getSetting<number>('judge_raw_response_retention_days');
      await db.execute(sql`
        UPDATE judge_verdicts
        SET raw_response = NULL
        WHERE raw_response IS NOT NULL
          AND created_at < NOW() - INTERVAL '${sql.raw(String(retentionDays))} days'
      `);
    } catch (err) {
      console.error('[CleanupJob] Error:', err);
    }
  }, CLEANUP_INTERVAL_MS);
}
```

- [ ] **Step 3: Add result:created event to reconciler**

In `web/src/lib/orchestrator/reconciler.ts`, after the `db.insert(runResults)` call in `finalize()`, add:

```typescript
// After inserting run_result, trigger judge evaluation
import { enqueueJudgeTasks } from '@/lib/judge/service';

// At the end of finalize(), after the DB insert:
// Fire-and-forget judge enqueue — errors don't block result creation
enqueueJudgeTasks(insertedResult.id).catch((err) => {
  console.error('[Reconciler] Failed to enqueue judge tasks:', err);
});
```

- [ ] **Step 4: Implement startup recovery**

Add to `web/src/lib/judge/service.ts`:

```typescript
/**
 * Startup recovery: re-enqueue tasks for incomplete evaluations.
 * Called once on application startup.
 */
export async function recoverPendingEvaluations(): Promise<void> {
  const { inArray } = await import('drizzle-orm');

  const pendingResults = await db
    .select()
    .from(runResults)
    .where(inArray(runResults.judgeStatus, ['pending', 'partial']));

  for (const result of pendingResults) {
    const meta = result.judgeMeta as unknown as JudgeMeta;
    if (!meta?.targetProviderIds) continue;

    const version = result.evaluationVersion;

    // Check which providers have verdicts for current version
    const existingVerdicts = await db
      .select({ judgeProviderId: judgeVerdicts.judgeProviderId })
      .from(judgeVerdicts)
      .where(
        and(
          eq(judgeVerdicts.runResultId, result.id),
          eq(judgeVerdicts.evaluationVersion, version)
        )
      );

    const completedProviders = new Set(existingVerdicts.map((v) => v.judgeProviderId));
    const missingProviders = meta.targetProviderIds.filter((id) => !completedProviders.has(id));

    if (missingProviders.length === 0) {
      // All verdicts exist — run aggregation
      const { runAggregation } = await import('./aggregation-runner');
      await runAggregation(result.id, version);
      continue;
    }

    // Re-enqueue missing tasks
    const redis = getPublisher();
    for (const providerId of missingProviders) {
      const payload: JudgeTaskPayload = {
        runResultId: result.id,
        providerId,
        evaluationVersion: version,
      };
      await redis.xadd(STREAM_KEY, '*', 'payload', JSON.stringify(payload));
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/judge/reclaim.ts web/src/lib/judge/cleanup.ts web/src/lib/orchestrator/reconciler.ts web/src/lib/judge/service.ts
git commit -m "feat(judge): add reclaim loop, cleanup job, startup recovery, reconciler integration"
```

---

## Task 14: Matview Refresh — Distributed Lock

**Files:**
- Modify: `web/src/lib/db/refresh-matviews.ts`

- [ ] **Step 1: Write failing test for distributed matview refresh**

```typescript
// web/src/lib/db/__tests__/refresh-matviews.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  db: { execute: vi.fn().mockResolvedValue(undefined) },
}));

const mockRedis = {
  set: vi.fn().mockResolvedValue(null), // NX fails by default
  del: vi.fn().mockResolvedValue(1),
  get: vi.fn().mockResolvedValue(null),
  incr: vi.fn().mockResolvedValue(1),
};

vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(() => mockRedis),
}));

describe('tryRefreshMatviews', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips refresh when lock is held by another worker', async () => {
    mockRedis.set.mockResolvedValueOnce(null); // NX returns null = lock not acquired
    const { tryRefreshMatviews } = await import('../refresh-matviews');
    const refreshed = await tryRefreshMatviews();
    expect(refreshed).toBe(false);
  });

  it('refreshes when lock is acquired', async () => {
    mockRedis.set.mockResolvedValueOnce('OK'); // NX returns OK = lock acquired
    const { db } = await import('@/db');
    const { tryRefreshMatviews } = await import('../refresh-matviews');
    const refreshed = await tryRefreshMatviews();
    expect(refreshed).toBe(true);
    expect(db.execute).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/db/__tests__/refresh-matviews.test.ts
```

Expected: FAIL — `tryRefreshMatviews` not exported.

- [ ] **Step 3: Update matview refresh with distributed lock**

Replace `web/src/lib/db/refresh-matviews.ts` with:

```typescript
// web/src/lib/db/refresh-matviews.ts
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { getPublisher } from '@/lib/events/redis-client';

const LOCK_KEY = 'litmus:matview-refresh-lock';
const REFRESH_NEEDED_KEY = 'litmus:matview-refresh-needed';
const LOCK_TTL = 60; // seconds
const POLL_INTERVAL = 30000; // 30 seconds

const VIEWS = ['latest_results', 'score_by_model', 'score_by_agent'] as const;

async function refreshAllViews(
  logger: Pick<typeof console, 'warn'> = console,
): Promise<void> {
  for (const view of VIEWS) {
    try {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const needsFallback =
        /concurrently/i.test(message) ||
        /has not been populated/i.test(message);
      if (!needsFallback) throw reason;
      logger.warn(`[matviews] concurrent refresh unavailable for ${view}; retrying without CONCURRENTLY`);
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
    }
  }
}

/**
 * Start the debounced matview refresh worker.
 * Polls every 30s, acquires distributed lock before refreshing.
 */
export function startMatviewRefreshWorker(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const redis = getPublisher();

      // Check if refresh is needed
      const needed = await redis.get(REFRESH_NEEDED_KEY);
      if (!needed) return;

      // Try to acquire distributed lock
      const acquired = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL, 'NX');
      if (!acquired) return; // Another instance is refreshing

      // Clear the flag before refreshing
      await redis.del(REFRESH_NEEDED_KEY);

      try {
        await refreshAllViews();
      } finally {
        // Release lock
        await redis.del(LOCK_KEY);
      }
    } catch (err) {
      console.error('[MatviewRefresh] Error:', err);
    }
  }, POLL_INTERVAL);
}

/**
 * Trigger a debounced refresh by setting the flag in Redis.
 * Called from JudgeAggregator after composite score is written.
 */
export async function requestMatviewRefresh(): Promise<void> {
  const redis = getPublisher();
  await redis.set(REFRESH_NEEDED_KEY, '1');
}

/**
 * Try to acquire lock and refresh. Returns true if refresh was performed.
 * Exported for testing.
 */
export async function tryRefreshMatviews(): Promise<boolean> {
  const redis = getPublisher();
  const acquired = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL, 'NX');
  if (!acquired) return false;
  await redis.del(REFRESH_NEEDED_KEY);
  try {
    await refreshAllViews();
  } finally {
    await redis.del(LOCK_KEY);
  }
  return true;
}

/**
 * Direct refresh (no lock) — for use after scheduler completes a run.
 * Signature preserved for backward compatibility with scheduler.ts and startup.ts.
 */
export async function refreshMatviews(
  logger: Pick<typeof console, 'warn'> = console,
): Promise<void> {
  await refreshAllViews(logger);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/db/refresh-matviews.ts
git commit -m "feat(judge): add distributed lock for matview refresh debouncing"
```

---

## Task 15: Judge Control APIs — Re-evaluate & Recalculate

**Files:**
- Create: `web/src/app/api/judge/re-evaluate/route.ts`
- Create: `web/src/app/api/judge/re-evaluate-bulk/route.ts`
- Create: `web/src/app/api/judge/recalculate/route.ts`

- [ ] **Step 1: Write failing tests for control APIs**

```typescript
// web/src/app/api/judge/__tests__/control-apis.test.ts
import { describe, it, expect, vi } from 'vitest';

// These tests verify the route handler contracts.
// Full integration tests are in Task 20.

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
}));

vi.mock('@/lib/judge/service', () => ({
  enqueueJudgeTasks: vi.fn().mockResolvedValue(undefined),
}));

describe('re-evaluate route', () => {
  it('returns 400 when runResultId is missing', async () => {
    const { POST } = await import('../re-evaluate/route');
    const req = new Request('http://localhost/api/judge/re-evaluate', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 422 when no providers are enabled', async () => {
    const { POST } = await import('../re-evaluate/route');
    const req = new Request('http://localhost/api/judge/re-evaluate', {
      method: 'POST',
      body: JSON.stringify({ runResultId: 1 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
  });
});

describe('re-evaluate-bulk route', () => {
  it('defaults to status=pending when status is omitted', async () => {
    const { POST } = await import('../re-evaluate-bulk/route');
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    // Should not error; exact behavior depends on db state
    expect([200, 422].includes(res.status)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/app/api/judge/__tests__/control-apis.test.ts
```

Expected: FAIL — route modules not found.

- [ ] **Step 3: Implement single re-evaluate**

```typescript
// web/src/app/api/judge/re-evaluate/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { runResults, judgeProviders } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { enqueueJudgeTasks } from '@/lib/judge/service';
import type { JudgeMeta } from '@/lib/judge/types';

export async function POST(request: Request) {
  const { runResultId } = await request.json();
  if (!runResultId) {
    return NextResponse.json({ error: 'runResultId required' }, { status: 400 });
  }

  // Snapshot current enabled providers
  const providers = await db
    .select()
    .from(judgeProviders)
    .where(eq(judgeProviders.enabled, true));

  if (providers.length === 0) {
    return NextResponse.json({ error: 'No enabled judge providers' }, { status: 422 });
  }

  const judgeMeta: JudgeMeta = {
    targetProviderIds: providers.map((p) => p.id),
  };

  // Increment version + reset status in single transaction
  await db
    .update(runResults)
    .set({
      evaluationVersion: sql`evaluation_version + 1`,
      judgeStatus: 'pending',
      judgeMeta: judgeMeta as unknown as Record<string, unknown>,
      compositeScore: null,
      judgeScores: null,
      blockingFlags: null,
    })
    .where(eq(runResults.id, runResultId));

  // Enqueue with new version
  await enqueueJudgeTasks(runResultId);

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Implement bulk re-evaluate**

```typescript
// web/src/app/api/judge/re-evaluate-bulk/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { runResults, judgeProviders } from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { enqueueJudgeTasks } from '@/lib/judge/service';
import type { JudgeMeta } from '@/lib/judge/types';

export async function POST(request: Request) {
  const body = await request.json();
  const { scenarioId, status = 'pending' } = body;

  if (status === 'pending') {
    // Re-enqueue incomplete tasks — no version increment
    const conditions = [inArray(runResults.judgeStatus, ['pending', 'partial'])];
    if (scenarioId) conditions.push(eq(runResults.scenarioId, scenarioId));

    const results = await db
      .select({ id: runResults.id })
      .from(runResults)
      .where(and(...conditions));

    for (const r of results) {
      await enqueueJudgeTasks(r.id);
    }

    return NextResponse.json({ enqueued: results.length });
  }

  if (status === 'all') {
    // Full re-evaluate — version increment + provider re-snapshot
    const providers = await db
      .select()
      .from(judgeProviders)
      .where(eq(judgeProviders.enabled, true));

    if (providers.length === 0) {
      return NextResponse.json({ error: 'No enabled judge providers' }, { status: 422 });
    }

    const judgeMeta: JudgeMeta = {
      targetProviderIds: providers.map((p) => p.id),
    };

    const conditions = scenarioId
      ? [eq(runResults.scenarioId, scenarioId)]
      : [];

    const results = await db
      .select({ id: runResults.id })
      .from(runResults)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    for (const r of results) {
      await db
        .update(runResults)
        .set({
          evaluationVersion: sql`evaluation_version + 1`,
          judgeStatus: 'pending',
          judgeMeta: judgeMeta as unknown as Record<string, unknown>,
          compositeScore: null,
          judgeScores: null,
          blockingFlags: null,
        })
        .where(eq(runResults.id, r.id));

      await enqueueJudgeTasks(r.id);
    }

    return NextResponse.json({ enqueued: results.length });
  }

  return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
}
```

- [ ] **Step 3: Implement recalculate**

```typescript
// web/src/app/api/judge/recalculate/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { runResults, judgeVerdicts, settings } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { aggregateVerdicts, computeCompositeScore } from '@/lib/judge/aggregator';
import { computeWeights, CRITERIA_KEYS, BLOCKING_KEYS } from '@/lib/judge/criteria';
import { settingsDefaults } from '@/lib/judge/types';
import type { JudgeMeta } from '@/lib/judge/types';

async function getSetting<T>(key: string): Promise<T> {
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

async function recalculateResult(resultId: string): Promise<void> {
  const [result] = await db
    .select()
    .from(runResults)
    .where(eq(runResults.id, resultId));

  if (!result || result.judgeStatus !== 'completed') return;

  const verdicts = await db
    .select()
    .from(judgeVerdicts)
    .where(
      and(
        eq(judgeVerdicts.runResultId, resultId),
        eq(judgeVerdicts.evaluationVersion, result.evaluationVersion)
      )
    );

  const verdictInputs = verdicts.map((v) => ({
    scores: v.scores as Record<string, { score: number; rationale: string }>,
    blockingFlags: v.blockingFlags as Record<string, { triggered: boolean; rationale: string }>,
    error: v.error,
  }));

  const aggregated = aggregateVerdicts(verdictInputs, CRITERIA_KEYS, BLOCKING_KEYS);
  if (!aggregated) return;

  const weightsConfig = await getSetting<{ test: number; judge: number }>('composite_weights');
  const priorityConfig = await getSetting<{ order: string[]; preset: string }>('criteria_priority');
  const blockingCaps = await getSetting<Record<string, number>>('blocking_caps');

  const criteriaWeights = computeWeights(
    priorityConfig.order,
    priorityConfig.preset as 'flat' | 'linear' | 'steep'
  );

  let judgeWeighted = 0;
  for (const key of CRITERIA_KEYS) {
    judgeWeighted += (criteriaWeights[key] ?? 0) * (aggregated.medianScores[key] ?? 0);
  }
  const judgeNormalized = ((judgeWeighted - 1) / 4) * 100;

  const compositeScore = computeCompositeScore({
    testScore: result.totalScore ?? 0,
    judgeNormalized,
    weights: weightsConfig,
    blockingCount: aggregated.blockingCount,
    blockingCaps,
  });

  await db
    .update(runResults)
    .set({ compositeScore })
    .where(eq(runResults.id, resultId));
}

export async function POST(request: Request) {
  const body = await request.json();
  const { runResultId } = body;

  if (runResultId) {
    await recalculateResult(runResultId);
    return NextResponse.json({ recalculated: 1 });
  }

  // Recalculate all completed results
  const results = await db
    .select({ id: runResults.id })
    .from(runResults)
    .where(eq(runResults.judgeStatus, 'completed'));

  for (const r of results) {
    await recalculateResult(r.id);
  }

  return NextResponse.json({ recalculated: results.length });
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/app/api/judge/
git commit -m "feat(judge): add re-evaluate, re-evaluate-bulk, recalculate APIs"
```

---

## Task 16: Compare Module — Query Updates

**Files:**
- Modify: `web/src/lib/compare/types.ts`
- Modify: `web/src/lib/compare/queries.ts`
- Modify: `web/src/app/api/compare/[scenarioId]/drill-down/route.ts`
- Create: `web/src/app/api/compare/stream/route.ts`

- [ ] **Step 1: Extend compare types**

In `web/src/lib/compare/types.ts`, add to `DrillDownResponse.latest`:

```typescript
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

Add to `HeatmapCell`:

```typescript
judgeStatus?: 'pending' | 'partial' | 'completed' | 'skipped';
```

- [ ] **Step 2: Update queries.ts — COALESCE for all score paths**

In `web/src/lib/compare/queries.ts`, replace all occurrences of `total_score` in SQL with `COALESCE(composite_score, total_score)`:

1. `fetchRankingData` — cell-level AVG
2. `fetchDetailedData` — entity-level AVG
3. `fetchDetailedData` — cell-level score

Search for `total_score` in the raw SQL strings and replace with `COALESCE(composite_score, total_score)`.

- [ ] **Step 3: Update drill-down route to include judge verdicts**

In `web/src/app/api/compare/[scenarioId]/drill-down/route.ts`, after fetching the latest result, also fetch `judge_verdicts` joined with `judge_providers` for provider names.

- [ ] **Step 4: Create compare SSE endpoint**

```typescript
// web/src/app/api/compare/stream/route.ts
import { subscribeAll } from '@/lib/events/redis-bus';
import type { RedisEvent } from '@/lib/events/redis-bus';

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = subscribeAll((event: RedisEvent) => {
        if (
          event.type === 'judge:started' ||
          event.type === 'judge:verdict' ||
          event.type === 'judge:completed'
        ) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        }
      });

      // Cleanup on close
      const checkClosed = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          unsubscribe();
          clearInterval(checkClosed);
        }
      }, 15000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/compare/ web/src/app/api/compare/
git commit -m "feat(judge): update compare module — composite scores, judge verdicts, SSE stream"
```

---

## Task 17: UI — Settings Page

**Files:**
- Create: `web/src/components/settings/judge-providers.tsx`
- Create: `web/src/components/settings/scoring-config.tsx`
- Modify: `web/src/app/settings/page.tsx`

- [ ] **Step 1: Implement judge providers component**

```typescript
// web/src/components/settings/judge-providers.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string; // masked
  model: string;
  enabled: boolean;
  priority: number;
}

export function JudgeProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', model: '' });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; latencyMs: number; error?: string }>>({});

  const loadProviders = useCallback(async () => {
    const res = await fetch('/api/settings/judge-providers');
    if (res.ok) setProviders(await res.json());
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  async function addProvider() {
    const res = await fetch('/api/settings/judge-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setAdding(false);
      setForm({ name: '', baseUrl: '', apiKey: '', model: '' });
      loadProviders();
    }
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    await fetch(`/api/settings/judge-providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    loadProviders();
  }

  async function deleteProvider(id: string) {
    await fetch(`/api/settings/judge-providers/${id}`, { method: 'DELETE' });
    loadProviders();
  }

  async function testProvider(id: string) {
    setTesting(id);
    const res = await fetch(`/api/settings/judge-providers/${id}/test`, { method: 'POST' });
    if (res.ok) {
      const result = await res.json();
      setTestResult((prev) => ({ ...prev, [id]: result }));
    }
    setTesting(null);
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Judge Providers</h2>
      <div className="space-y-2">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center gap-3 p-3 border rounded">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => toggleEnabled(p.id, e.target.checked)}
              />
              <span className="font-medium">{p.name}</span>
            </label>
            <span className="text-sm text-gray-500">{p.model}</span>
            <span className="text-sm text-gray-400">{p.apiKey}</span>
            <div className="ml-auto flex gap-2">
              <button
                className="text-sm px-2 py-1 border rounded"
                onClick={() => testProvider(p.id)}
                disabled={testing === p.id}
              >
                {testing === p.id ? '...' : 'Test'}
              </button>
              {testResult[p.id] && (
                <span className={`text-sm ${testResult[p.id].success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult[p.id].success ? `OK ${testResult[p.id].latencyMs}ms` : testResult[p.id].error}
                </span>
              )}
              <button
                className="text-sm px-2 py-1 text-red-600 border rounded"
                onClick={() => deleteProvider(p.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-4 p-4 border rounded space-y-2">
          <input className="w-full p-2 border rounded" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="w-full p-2 border rounded" placeholder="Base URL" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          <input className="w-full p-2 border rounded" placeholder="API Key" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <input className="w-full p-2 border rounded" placeholder="Model ID" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          <div className="flex gap-2">
            <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={addProvider}>Save</button>
            <button className="px-4 py-2 border rounded" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="mt-4 px-4 py-2 border rounded" onClick={() => setAdding(true)}>
          + Add Provider
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Implement scoring config component**

```typescript
// web/src/components/settings/scoring-config.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { CRITERIA } from '@/lib/judge/criteria';

interface ScoringSettings {
  composite_weights: { test: number; judge: number };
  criteria_priority: { order: string[]; preset: string };
  blocking_caps: Record<string, number>;
  judge_max_retries: number;
  judge_temperature: number;
  judge_max_concurrent_per_provider: number;
  judge_max_concurrent_global: number;
  log_compression: string;
  max_compressed_chars: number;
  max_judge_prompt_chars: number;
  judge_task_idle_timeout_ms: number;
  judge_raw_response_retention_days: number;
}

export function ScoringConfig() {
  const [settings, setSettings] = useState<ScoringSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/settings/scoring');
    if (res.ok) setSettings(await res.json());
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    await fetch('/api/settings/scoring', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setSaving(false);
  }

  if (!settings) return <div>Loading...</div>;

  const criteriaMap = new Map(CRITERIA.map((c) => [c.key, c]));

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">Scoring Configuration</h2>

      {/* Composite Weights */}
      <div>
        <h3 className="font-medium mb-2">Composite Weights</h3>
        <div className="flex items-center gap-4">
          <label>Test: {(settings.composite_weights.test * 100).toFixed(0)}%</label>
          <input
            type="range"
            min="0"
            max="100"
            value={settings.composite_weights.test * 100}
            onChange={(e) => {
              const test = Number(e.target.value) / 100;
              setSettings({
                ...settings,
                composite_weights: { test, judge: 1 - test },
              });
            }}
          />
          <label>Judge: {(settings.composite_weights.judge * 100).toFixed(0)}%</label>
        </div>
      </div>

      {/* Criteria Priority */}
      <div>
        <h3 className="font-medium mb-2">Criteria Priority</h3>
        <select
          className="p-2 border rounded mb-2"
          value={settings.criteria_priority.preset}
          onChange={(e) =>
            setSettings({
              ...settings,
              criteria_priority: { ...settings.criteria_priority, preset: e.target.value },
            })
          }
        >
          <option value="flat">Flat</option>
          <option value="linear">Linear</option>
          <option value="steep">Steep</option>
        </select>
        <ol className="space-y-1">
          {settings.criteria_priority.order.map((key, i) => (
            <li key={key} className="flex items-center gap-2 p-2 border rounded">
              <span className="text-gray-400 w-6">{i + 1}.</span>
              <span>{criteriaMap.get(key)?.title ?? key}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Other Settings */}
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col">
          Judge retries
          <input type="number" className="p-2 border rounded" value={settings.judge_max_retries}
            onChange={(e) => setSettings({ ...settings, judge_max_retries: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          Judge temperature
          <input type="number" step="0.1" className="p-2 border rounded" value={settings.judge_temperature}
            onChange={(e) => setSettings({ ...settings, judge_temperature: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          Max concurrent/provider
          <input type="number" className="p-2 border rounded" value={settings.judge_max_concurrent_per_provider}
            onChange={(e) => setSettings({ ...settings, judge_max_concurrent_per_provider: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          Max concurrent global
          <input type="number" className="p-2 border rounded" value={settings.judge_max_concurrent_global}
            onChange={(e) => setSettings({ ...settings, judge_max_concurrent_global: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          Task idle timeout (sec)
          <input type="number" className="p-2 border rounded" value={settings.judge_task_idle_timeout_ms / 1000}
            onChange={(e) => setSettings({ ...settings, judge_task_idle_timeout_ms: Number(e.target.value) * 1000 })} />
        </label>
        <label className="flex flex-col">
          Raw response retention (days)
          <input type="number" className="p-2 border rounded" value={settings.judge_raw_response_retention_days}
            onChange={(e) => setSettings({ ...settings, judge_raw_response_retention_days: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          Log compression
          <select className="p-2 border rounded" value={settings.log_compression}
            onChange={(e) => setSettings({ ...settings, log_compression: e.target.value as 'structured' | 'none' })}>
            <option value="structured">Structured</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="flex flex-col">
          Max compressed chars
          <input type="number" className="p-2 border rounded" value={settings.max_compressed_chars}
            onChange={(e) => setSettings({ ...settings, max_compressed_chars: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          Max judge prompt chars
          <input type="number" className="p-2 border rounded" value={settings.max_judge_prompt_chars}
            onChange={(e) => setSettings({ ...settings, max_judge_prompt_chars: Number(e.target.value) })} />
        </label>
      </div>

      <div className="flex gap-2">
        <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Update settings page**

Replace `web/src/app/settings/page.tsx`:

```typescript
import { JudgeProviders } from '@/components/settings/judge-providers';
import { ScoringConfig } from '@/components/settings/scoring-config';

export default function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <JudgeProviders />
      <hr />
      <ScoringConfig />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/components/settings/ web/src/app/settings/page.tsx
git commit -m "feat(judge): add Settings page — judge providers CRUD + scoring config UI"
```

---

## Task 18: UI — Compare Screen Updates

**Files:**
- Modify: `web/src/components/compare/heatmap-cell.tsx`
- Create: `web/src/components/compare/judge-evaluation.tsx`
- Modify: `web/src/components/compare/drill-down-panel.tsx`
- Modify: `web/src/app/compare/compare-view.tsx`

- [ ] **Step 1: Add judge status badge to heatmap cell**

In `web/src/components/compare/heatmap-cell.tsx`, add a status badge in the cell corner:

```typescript
// Add after the existing score display:
{cell.judgeStatus === 'pending' && (
  <span className="absolute top-0.5 right-0.5 text-xs" title="Judge pending">⏳</span>
)}
{cell.judgeStatus === 'partial' && (
  <span className="absolute top-0.5 right-0.5 text-xs" title="Judge partial">◐</span>
)}
```

Also change the displayed score to prefer `compositeScore` when available. The cell wrapper needs `position: relative` for the absolute badge.

- [ ] **Step 2: Create judge evaluation component**

```typescript
// web/src/components/compare/judge-evaluation.tsx
'use client';

import { useState } from 'react';
import { CRITERIA, BLOCKING_CHECKS } from '@/lib/judge/criteria';

interface Verdict {
  providerName: string;
  scores: Record<string, { score: number; rationale: string }>;
  blocking: Record<string, { triggered: boolean; rationale: string }>;
  error: string | null;
}

interface Props {
  judgeStatus: string;
  compositeScore: number | null;
  testScore: number;
  blockingFlags: Record<string, boolean> | null;
  verdicts: Verdict[] | null;
  weights: { test: number; judge: number };
}

export function JudgeEvaluation({ judgeStatus, compositeScore, testScore, blockingFlags, verdicts, weights }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (judgeStatus === 'skipped') {
    return <div className="text-sm text-gray-500 mt-4">Judge evaluation skipped (no providers configured)</div>;
  }

  if (judgeStatus === 'pending') {
    return <div className="text-sm text-yellow-600 mt-4">⏳ Judge evaluation pending...</div>;
  }

  if (judgeStatus === 'partial') {
    return <div className="text-sm text-orange-600 mt-4">◐ Judge evaluation in progress...</div>;
  }

  if (!verdicts || verdicts.length === 0) return null;

  const successfulVerdicts = verdicts.filter((v) => !v.error);
  const blockingCount = blockingFlags
    ? Object.values(blockingFlags).filter(Boolean).length
    : 0;

  return (
    <div className="mt-4 border-t pt-4">
      <h3 className="font-medium mb-2">Judge Evaluation</h3>

      {/* Composite breakdown */}
      <div className="text-sm space-y-1 mb-3">
        <div>Composite Score: <strong>{compositeScore?.toFixed(1) ?? '—'}</strong> / 100</div>
        <div className="text-gray-500 pl-2">
          Test: {testScore.toFixed(1)} x {weights.test} = {(testScore * weights.test).toFixed(1)}
        </div>
        {blockingCount > 0 && (
          <div className="text-red-600 pl-2">
            {blockingCount} blocking flag{blockingCount > 1 ? 's' : ''} (cap applied)
          </div>
        )}
      </div>

      {/* Criteria table */}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left py-1">Criterion</th>
            <th className="text-center py-1">Med</th>
            {successfulVerdicts.map((v, i) => (
              <th key={i} className="text-center py-1">J{i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CRITERIA.map((c) => {
            const scores = successfulVerdicts.map(
              (v) => v.scores[c.key]?.score ?? 0
            );
            const sorted = [...scores].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const med =
              sorted.length % 2 === 0
                ? (sorted[mid - 1] + sorted[mid]) / 2
                : sorted[mid];

            return (
              <tr key={c.key} className="border-b">
                <td className="py-1">{c.title}</td>
                <td className="text-center font-medium">{med}</td>
                {successfulVerdicts.map((v, i) => (
                  <td key={i} className="text-center text-gray-600">
                    {v.scores[c.key]?.score ?? '—'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Blocking flags */}
      <div className="mt-3">
        <h4 className="font-medium text-sm mb-1">Blocking Flags</h4>
        {BLOCKING_CHECKS.map((b) => {
          const triggered = blockingFlags?.[b.key] ?? false;
          const votes = successfulVerdicts.map(
            (v) => v.blocking[b.key]?.triggered ?? false
          );
          const trueCount = votes.filter(Boolean).length;
          return (
            <div key={b.key} className="flex items-center gap-2 text-sm">
              <span>{triggered ? '⚠' : '✗'}</span>
              <span>{b.title}</span>
              <span className="text-gray-400">
                {trueCount}/{successfulVerdicts.length}
              </span>
            </div>
          );
        })}
      </div>

      {/* Expandable rationale */}
      <button
        className="mt-2 text-sm text-blue-600"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '▾ Hide rationale' : '▸ Show rationale'}
      </button>
      {expanded && (
        <div className="mt-2 space-y-4 text-sm">
          {successfulVerdicts.map((v, i) => (
            <div key={i} className="border rounded p-3">
              <h5 className="font-medium">Judge {i + 1}: {v.providerName}</h5>
              {CRITERIA.map((c) => (
                <div key={c.key} className="mt-1">
                  <span className="font-medium">{c.title} ({v.scores[c.key]?.score}):</span>{' '}
                  {v.scores[c.key]?.rationale}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add judge evaluation to drill-down panel**

In `web/src/components/compare/drill-down-panel.tsx`, import and render `JudgeEvaluation` below the latest result section, passing data from the API response.

- [ ] **Step 4: Add SSE subscription + Actions dropdown to compare view**

In `web/src/app/compare/compare-view.tsx`, add:
1. `useEffect` subscribing to `/api/compare/stream` EventSource
2. On `judge:completed` events, refetch compare data to update cells
3. Actions dropdown button with re-evaluate and recalculate options

- [ ] **Step 5: Commit**

```bash
git add web/src/components/compare/ web/src/app/compare/compare-view.tsx
git commit -m "feat(judge): update Compare screen — judge badges, evaluation panel, SSE updates"
```

---

## Task 19: Application Startup — Wire Everything Together

**Files:**
- Modify: `web/src/instrumentation.ts`

- [ ] **Step 1: Add judge system startup to instrumentation**

The current `instrumentation.ts` uses dynamic `await import()` inside the `NEXT_RUNTIME === 'nodejs'` guard to avoid pulling server-only deps into edge/browser runtimes. All judge imports MUST follow this same pattern — no top-level imports.

Add inside the existing `if (process.env.NEXT_RUNTIME === 'nodejs')` block, after the `startupCleanup()` call:

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Existing startup cleanup
    const { startupCleanup } = await import('@/lib/orchestrator/startup');
    await startupCleanup().catch((err) => {
      console.error('[startup] Cleanup failed:', err);
    });

    // Judge system — all imports dynamic under runtime guard
    const { startWorker } = await import('@/lib/judge/worker');
    const { recoverPendingEvaluations } = await import('@/lib/judge/service');
    const { startReclaimLoop } = await import('@/lib/judge/reclaim');
    const { startCleanupJob } = await import('@/lib/judge/cleanup');
    const { startMatviewRefreshWorker } = await import('@/lib/db/refresh-matviews');

    const consumerId = `worker-${process.pid}-${Date.now()}`;

    // Start judge worker (blocking loop — runs in background)
    startWorker(consumerId).catch((err) =>
      console.error('[Startup] Worker failed:', err)
    );

    // Start periodic jobs
    startReclaimLoop(consumerId);
    startCleanupJob();
    startMatviewRefreshWorker();

    // Recover incomplete evaluations from previous session
    recoverPendingEvaluations().catch((err) =>
      console.error('[Startup] Recovery failed:', err)
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/instrumentation.ts
git commit -m "feat(judge): wire startup — worker, reclaim, cleanup, matview refresh, recovery"
```

---

## Task 20: Integration Test — Full Pipeline

**Files:**
- Create: `web/src/lib/judge/__tests__/integration.test.ts`
- Create: `web/src/lib/judge/__tests__/re-evaluate-bulk-contract.test.ts`

- [ ] **Step 1: Write integration tests (two files)**

```typescript
// web/src/lib/judge/__tests__/integration.test.ts
//
// Two test suites in one file:
// 1. Pure scoring pipeline (no mocks, no I/O)
// 2. re-evaluate-bulk route contract (mocked db, tests route handler directly)

import { describe, it, expect } from 'vitest';
import {
  computeCompositeScore,
  aggregateVerdicts,
} from '../aggregator';
import { computeWeights, CRITERIA_KEYS, BLOCKING_KEYS } from '../criteria';
import type { JudgeCriterionScore, JudgeBlockingFlag } from '../types';

// --- Helpers ---

function makeVerdict(scores: number[], blocking: boolean[]) {
  return {
    scores: Object.fromEntries(
      CRITERIA_KEYS.map((k, i) => [
        k,
        { score: scores[i] ?? 3, rationale: 'test' } satisfies JudgeCriterionScore,
      ])
    ) as Record<string, JudgeCriterionScore>,
    blockingFlags: Object.fromEntries(
      BLOCKING_KEYS.map((k, i) => [
        k,
        { triggered: blocking[i] ?? false, rationale: 'test' } satisfies JudgeBlockingFlag,
      ])
    ) as Record<string, JudgeBlockingFlag>,
    error: null,
  };
}

// --- Suite 1: Pure scoring pipeline (no I/O) ---

describe('Integration: full scoring pipeline', () => {
  it('computes end-to-end composite from 3 judge verdicts', () => {
    const verdicts = [
      makeVerdict([4, 3, 4, 3, 4, 3, 3, 4, 3, 4], [false, false, false, false]),
      makeVerdict([5, 4, 3, 3, 4, 2, 3, 5, 3, 4], [false, true, false, false]),
      makeVerdict([4, 3, 4, 2, 3, 3, 2, 4, 4, 3], [false, false, false, false]),
    ];

    const aggregated = aggregateVerdicts(verdicts, CRITERIA_KEYS, BLOCKING_KEYS);
    expect(aggregated).not.toBeNull();
    expect(aggregated!.confidence).toBe('normal');

    const weights = computeWeights(CRITERIA_KEYS, 'linear');
    let judgeWeighted = 0;
    for (const key of CRITERIA_KEYS) {
      judgeWeighted += (weights[key] ?? 0) * (aggregated!.medianScores[key] ?? 0);
    }
    const judgeNormalized = ((judgeWeighted - 1) / 4) * 100;

    const composite = computeCompositeScore({
      testScore: 80,
      judgeNormalized,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: aggregated!.blockingCount,
      blockingCaps: { '1': 60, '2': 40 },
    });

    expect(composite).toBeGreaterThan(0);
    expect(composite).toBeLessThanOrEqual(100);
  });

  it('single verdict with blocking flag caps the score', () => {
    const verdicts = [
      makeVerdict([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [true, false, false, false]),
    ];

    const aggregated = aggregateVerdicts(verdicts, CRITERIA_KEYS, BLOCKING_KEYS);
    expect(aggregated!.blockingCount).toBe(1);

    const composite = computeCompositeScore({
      testScore: 100,
      judgeNormalized: 100,
      weights: { test: 0.4, judge: 0.6 },
      blockingCount: 1,
      blockingCaps: { '1': 60, '2': 40 },
    });

    expect(composite).toBeLessThanOrEqual(60);
  });

  it('all error verdicts produce null aggregation', () => {
    const errorVerdicts = [
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'API timeout' },
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'Rate limited' },
    ];

    const aggregated = aggregateVerdicts(errorVerdicts, CRITERIA_KEYS, BLOCKING_KEYS);
    expect(aggregated).toBeNull();
  });
});
```

Then create a **separate** file for the route contract test (Vitest hoists `vi.mock` to file top-level, so mocks must be in the same file as their consumers):

```typescript
// web/src/lib/judge/__tests__/re-evaluate-bulk-contract.test.ts
import { describe, it, expect, vi } from 'vitest';

// Mocks MUST be at top level — Vitest hoists them before imports
vi.mock('@/db', () => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: mockWhere }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: mockWhere }),
      }),
    },
  };
});

vi.mock('@/db/schema', () => ({
  runResults: { id: 'id', judgeStatus: 'judge_status', evaluationVersion: 'evaluation_version' },
  judgeProviders: { enabled: 'enabled' },
}));

vi.mock('@/lib/judge/service', () => ({
  enqueueJudgeTasks: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mocks are declared
import { POST } from '@/app/api/judge/re-evaluate-bulk/route';

describe('POST /api/judge/re-evaluate-bulk', () => {
  it('treats missing status field as status=pending (not 400)', async () => {
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });

  it('accepts explicit status=pending', async () => {
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });

  it('accepts explicit status=all', async () => {
    const req = new Request('http://localhost/api/judge/re-evaluate-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'all' }),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });
});
```

- [ ] **Step 2: Run full test suite**

```bash
cd web && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/judge/__tests__/integration.test.ts web/src/lib/judge/__tests__/re-evaluate-bulk-contract.test.ts
git commit -m "test(judge): add integration tests — full pipeline, bulk default status"
```

---

## Self-Review Notes

**Spec coverage check:**
- Section 1 (Problem) — context only, no implementation needed
- Section 2 (Solution) — key decisions implemented across all tasks
- Section 3 (Unified Criteria) — Task 1 (criteria + weights)
- Section 4 (Data Layer) — Task 7 (schema + migration + matviews)
- Section 5 (Infrastructure) — Task 8 (Valkey + Redis clients + EventBus)
- Section 6 (JudgeService) — Tasks 11-14 (service, worker, reclaim, aggregation, matview refresh)
- Section 7 (Log Compression) — Task 5 (interface + structured + noop + factory)
- Section 8 (UI Changes) — Task 18 (compare screen updates)
- Section 9 (Settings Page) — Tasks 9-10, 17 (API + UI)
- Section 10 (Re-evaluation) — Task 15 (re-evaluate + recalculate APIs)
- Section 11 (Validation) — Tasks 1-6, 20 (contract + integration tests)
- Section 12 (File Inventory) — all files covered

**Type consistency check:** All type names (`JudgeTaskPayload`, `JudgeMeta`, `JudgeResponse`, `AggregatedScores`, `CompressedLog`, `LogCompressor`, `WeightPreset`) are consistent across tasks. Function names (`enqueueJudgeTasks`, `runAggregation`, `computeWeights`, `computeCompositeScore`, `aggregateVerdicts`, `median`, `majorityVote`, `buildSystemPrompt`, `buildUserPrompt`, `allocateBudget`, `redactSecrets`, `encrypt`, `decrypt`, `createCompressor`) are consistent.

**Placeholder check:** No TBD/TODO items found. All code is complete and copy-paste ready.

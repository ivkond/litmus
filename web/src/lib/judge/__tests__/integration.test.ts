import { describe, it, expect } from 'vitest';
import { computeCompositeScore, aggregateVerdicts } from '../aggregator';
import { computeWeights, CRITERIA_KEYS, BLOCKING_KEYS } from '../criteria';
import { judgeResponseSchema } from '../types';
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
    error: null as string | null,
  };
}

function computeFullPipeline(
  verdicts: ReturnType<typeof makeVerdict>[],
  preset: 'flat' | 'linear' | 'steep',
  testScore: number,
  compositeWeights = { test: 0.4, judge: 0.6 },
  blockingCaps = { '1': 60, '2': 40 }
) {
  const aggregated = aggregateVerdicts(verdicts, CRITERIA_KEYS, BLOCKING_KEYS);
  if (!aggregated) return null;

  const weights = computeWeights(CRITERIA_KEYS, preset);
  let judgeWeighted = 0;
  for (const key of CRITERIA_KEYS) {
    judgeWeighted += (weights[key] ?? 0) * (aggregated.medianScores[key] ?? 0);
  }
  const judgeNormalized = ((judgeWeighted - 1) / 4) * 100;

  const composite = computeCompositeScore({
    testScore,
    judgeNormalized,
    weights: compositeWeights,
    blockingCount: aggregated.blockingCount,
    blockingCaps,
  });

  return { aggregated, judgeWeighted, judgeNormalized, composite };
}

// --- Suite 1: Full end-to-end scoring pipeline ---

describe('Integration: full scoring pipeline', () => {
  it('computes end-to-end composite from 3 judge verdicts', () => {
    const verdicts = [
      makeVerdict([4, 3, 4, 3, 4, 3, 3, 4, 3, 4], [false, false, false, false]),
      makeVerdict([5, 4, 3, 3, 4, 2, 3, 5, 3, 4], [false, true, false, false]),
      makeVerdict([4, 3, 4, 2, 3, 3, 2, 4, 4, 3], [false, false, false, false]),
    ];

    const result = computeFullPipeline(verdicts, 'linear', 80);
    expect(result).not.toBeNull();
    expect(result!.composite).toBeGreaterThan(0);
    expect(result!.composite).toBeLessThanOrEqual(100);
    expect(result!.aggregated.confidence).toBe('normal');
    expect(result!.aggregated.blockingCount).toBe(0); // 1/3 not majority
  });

  it('single verdict with blocking flag caps the score', () => {
    const verdicts = [
      makeVerdict([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [true, false, false, false]),
    ];

    const result = computeFullPipeline(verdicts, 'linear', 100);
    expect(result!.aggregated.blockingCount).toBe(1);
    expect(result!.composite).toBeLessThanOrEqual(60);
  });

  it('2+ blocking flags use stricter cap', () => {
    const verdicts = [
      makeVerdict([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [true, true, false, false]),
      makeVerdict([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [true, true, false, false]),
      makeVerdict([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [true, true, false, false]),
    ];

    const result = computeFullPipeline(verdicts, 'linear', 100);
    expect(result!.aggregated.blockingCount).toBe(2);
    expect(result!.composite).toBeLessThanOrEqual(40);
  });

  it('all error verdicts produce null aggregation', () => {
    const errorVerdicts = [
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'API timeout' },
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'Rate limited' },
    ];

    const result = aggregateVerdicts(errorVerdicts, CRITERIA_KEYS, BLOCKING_KEYS);
    expect(result).toBeNull();
  });

  it('partial failure (2 of 3 succeed) still aggregates with normal confidence', () => {
    const verdicts = [
      makeVerdict([4, 4, 4, 4, 4, 4, 4, 4, 4, 4], [false, false, false, false]),
      makeVerdict([3, 3, 3, 3, 3, 3, 3, 3, 3, 3], [false, false, false, false]),
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'timeout' },
    ];

    const result = computeFullPipeline(verdicts, 'linear', 80);
    expect(result).not.toBeNull();
    expect(result!.aggregated.confidence).toBe('normal'); // 2/3 >= ceil(3/2)
  });

  it('low confidence (1 of 3 succeed) marks lowConfidence', () => {
    const verdicts = [
      makeVerdict([4, 4, 4, 4, 4, 4, 4, 4, 4, 4], [false, false, false, false]),
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'error1' },
      { scores: {} as Record<string, JudgeCriterionScore>, blockingFlags: {} as Record<string, JudgeBlockingFlag>, error: 'error2' },
    ];

    const result = computeFullPipeline(verdicts, 'linear', 80);
    expect(result).not.toBeNull();
    expect(result!.aggregated.confidence).toBe('lowConfidence');
  });

  it.each([
    ['flat', 'linear'],
    ['flat', 'steep'],
    ['linear', 'steep'],
  ] as const)('preset %s produces different weights than %s', (a, b) => {
    const wA = computeWeights(CRITERIA_KEYS, a);
    const wB = computeWeights(CRITERIA_KEYS, b);
    // At least the first criterion weight should differ
    expect(wA[CRITERIA_KEYS[0]]).not.toBeCloseTo(wB[CRITERIA_KEYS[0]], 4);
  });

  it('composite respects custom weights (90/10 test-heavy)', () => {
    const verdicts = [
      makeVerdict([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [false, false, false, false]),
    ];

    const result = computeFullPipeline(verdicts, 'linear', 100, { test: 0.9, judge: 0.1 });
    expect(result).not.toBeNull();
    // test=100 dominates, judge is low → composite should be high
    expect(result!.composite).toBeGreaterThan(85);
  });
});

// --- Suite 2: Schema validation (used by worker) ---

describe('Integration: judgeResponseSchema validation', () => {
  it('accepts valid response with all required keys', () => {
    const valid = {
      scores: {
        task_success: { score: 4, rationale: 'good' },
        solution_correctness: { score: 3, rationale: 'ok' },
        instruction_following: { score: 4, rationale: 'ok' },
        design_quality: { score: 3, rationale: 'ok' },
        tool_action_quality: { score: 4, rationale: 'ok' },
        reasoning_diagnosis: { score: 3, rationale: 'ok' },
        recovery_adaptivity: { score: 3, rationale: 'ok' },
        safety_scope_control: { score: 4, rationale: 'ok' },
        context_state_handling: { score: 3, rationale: 'ok' },
        verification_awareness: { score: 3, rationale: 'ok' },
      },
      blocking: {
        hard_instruction_violation: { triggered: false, rationale: 'ok' },
        unsafe_or_out_of_scope_change: { triggered: false, rationale: 'ok' },
        invalid_solution_artifact: { triggered: false, rationale: 'ok' },
        incorrect_final_state: { triggered: false, rationale: 'ok' },
      },
    };
    const result = judgeResponseSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects response with only partial criteria keys', () => {
    const partial = {
      scores: {
        task_success: { score: 4, rationale: 'good' },
      },
      blocking: {
        hard_instruction_violation: { triggered: false, rationale: 'ok' },
        unsafe_or_out_of_scope_change: { triggered: false, rationale: 'ok' },
        invalid_solution_artifact: { triggered: false, rationale: 'ok' },
        incorrect_final_state: { triggered: false, rationale: 'ok' },
      },
    };
    const result = judgeResponseSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects score outside 1-5 range', () => {
    const invalid = {
      scores: {
        task_success: { score: 6, rationale: 'too high' },
      },
      blocking: {},
    };
    const result = judgeResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects score=0', () => {
    const invalid = {
      scores: {
        task_success: { score: 0, rationale: 'zero' },
      },
      blocking: {},
    };
    const result = judgeResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects missing rationale in score', () => {
    const invalid = {
      scores: {
        task_success: { score: 3 },
      },
      blocking: {},
    };
    const result = judgeResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean triggered in blocking', () => {
    const invalid = {
      scores: {},
      blocking: {
        hard_instruction_violation: { triggered: 'yes', rationale: 'bad type' },
      },
    };
    const result = judgeResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects completely malformed response', () => {
    expect(judgeResponseSchema.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(judgeResponseSchema.safeParse('string').success).toBe(false);
    expect(judgeResponseSchema.safeParse(null).success).toBe(false);
  });

  it('rejects empty scores and blocking (missing required keys)', () => {
    const minimal = { scores: {}, blocking: {} };
    const result = judgeResponseSchema.safeParse(minimal);
    expect(result.success).toBe(false);
  });
});

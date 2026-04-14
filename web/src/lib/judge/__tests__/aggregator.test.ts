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
    expect(result).not.toBeNull();
    expect(result!.medianScores['task_success']).toBe(4);
    expect(result!.medianScores['solution_correctness']).toBe(3);
    expect(result!.blockingFlags['hard_instruction_violation']).toBe(false);
    expect(result!.confidence).toBe('normal');
  });

  it('handles partial failure: 2 of 3 succeed (S >= ceil(N/2))', () => {
    const verdicts = [
      makeVerdict({ task_success: 4, solution_correctness: 3 }, { hard_instruction_violation: false }),
      makeVerdict({ task_success: 5, solution_correctness: 5 }, { hard_instruction_violation: true }),
      makeVerdict({}, {}, 'provider error'),
    ];
    const result = aggregateVerdicts(verdicts, criteriaKeys, blockingKeys);
    expect(result).not.toBeNull();
    expect(result!.medianScores['task_success']).toBe(4.5);
    expect(result!.blockingFlags['hard_instruction_violation']).toBe(false);
    expect(result!.confidence).toBe('normal');
  });

  it('handles low confidence: 1 of 3 succeed (S < ceil(N/2))', () => {
    const verdicts = [
      makeVerdict({ task_success: 4, solution_correctness: 3 }, { hard_instruction_violation: true }),
      makeVerdict({}, {}, 'error 1'),
      makeVerdict({}, {}, 'error 2'),
    ];
    const result = aggregateVerdicts(verdicts, criteriaKeys, blockingKeys);
    expect(result).not.toBeNull();
    expect(result!.medianScores['task_success']).toBe(4);
    expect(result!.blockingFlags['hard_instruction_violation']).toBe(true);
    expect(result!.confidence).toBe('lowConfidence');
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

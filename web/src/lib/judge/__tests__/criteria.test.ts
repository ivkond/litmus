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

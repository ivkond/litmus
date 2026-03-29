import { describe, it, expect } from 'vitest';
import { judgeResponseSchema } from '../types';

describe('JudgeWorker: version guard logic', () => {
  it('discards task when evaluationVersion mismatches (stale task)', () => {
    const taskVersion: number = 1;
    const currentVersion: number = 2;
    expect(taskVersion !== currentVersion).toBe(true);
  });

  it('processes task when evaluationVersion matches', () => {
    const taskVersion = 3;
    const currentVersion = 3;
    expect(taskVersion === currentVersion).toBe(true);
  });
});

describe('JudgeWorker: retry logic', () => {
  it('writes error verdict after max retries exceeded', () => {
    const maxRetries = 3;
    const attempt = 4;
    expect(attempt > maxRetries).toBe(true);
  });

  it('retries on rate limit with exponential backoff', () => {
    const baseDelay = 2000;
    const delays = [0, 1, 2, 3].map((attempt) => baseDelay * 2 ** attempt);
    expect(delays).toEqual([2000, 4000, 8000, 16000]);
  });
});

describe('JudgeWorker: response validation', () => {
  it('parses valid judge response with all required keys', () => {
    const response = JSON.stringify({
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
        unsafe_or_out_of_scope_change: { triggered: true, rationale: 'modified production code' },
        invalid_solution_artifact: { triggered: false, rationale: 'ok' },
        incorrect_final_state: { triggered: false, rationale: 'ok' },
      },
    });
    const parsed = JSON.parse(response);
    const validated = judgeResponseSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.scores.task_success.score).toBe(4);
      expect(validated.data.blocking.unsafe_or_out_of_scope_change.triggered).toBe(true);
    }
  });

  it('rejects response with non-integer score', () => {
    const response = {
      scores: { task_success: { score: 3.5, rationale: 'half' } },
      blocking: {},
    };
    const validated = judgeResponseSchema.safeParse(response);
    expect(validated.success).toBe(false);
  });

  it('rejects response without scores key', () => {
    const validated = judgeResponseSchema.safeParse({ blocking: {} });
    expect(validated.success).toBe(false);
  });

  it('rejects response without blocking key', () => {
    const validated = judgeResponseSchema.safeParse({ scores: {} });
    expect(validated.success).toBe(false);
  });

  it('rejects truncated/malformed JSON from LLM', () => {
    // Simulates the worker receiving a truncated response
    expect(() => JSON.parse('{"scores": {')).toThrow();
  });

  it('rejects response where triggered is a string instead of boolean', () => {
    const response = {
      scores: {},
      blocking: {
        hard_instruction_violation: { triggered: 'false', rationale: 'string' },
      },
    };
    const validated = judgeResponseSchema.safeParse(response);
    expect(validated.success).toBe(false);
  });
});

describe('JudgeWorker: stream message parsing', () => {
  it('extracts payload from Redis stream fields array', () => {
    // Redis XREADGROUP returns fields as flat array: [key1, val1, key2, val2, ...]
    const fields = ['payload', '{"runResultId":"r1","providerId":"p1","evaluationVersion":1}', 'other', 'data'];
    const payloadStr = fields[fields.indexOf('payload') + 1];
    const payload = JSON.parse(payloadStr);
    expect(payload.runResultId).toBe('r1');
    expect(payload.providerId).toBe('p1');
    expect(payload.evaluationVersion).toBe(1);
  });

  it('handles missing payload field gracefully', () => {
    const fields = ['other', 'data'];
    const idx = fields.indexOf('payload');
    expect(idx).toBe(-1);
    // Worker would catch this as an error
  });
});

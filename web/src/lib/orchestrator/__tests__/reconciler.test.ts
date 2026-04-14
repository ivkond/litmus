import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Reconciler } from '../reconciler';
import * as fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { EvalResult, TaskMeta } from '../types';

const { mockDbInsertValues, mockDbUpdateSetWhere } = vi.hoisted(() => {
  const mockDbInsertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-run-result-id' }]) });
  const mockDbUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
  return { mockDbInsertValues, mockDbUpdateSetWhere };
});

vi.mock('@/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: mockDbInsertValues }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: mockDbUpdateSetWhere,
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  runResults: { id: 'run_results.id' },
  runTasks: { id: 'run_tasks.id' },
}));

vi.mock('@/lib/judge/service', () => ({
  enqueueJudgeTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/s3', () => ({
  uploadFile: vi.fn().mockResolvedValue(undefined),
  BUCKETS: { scenarios: 'litmus-scenarios', artifacts: 'litmus-artifacts' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
}));

describe('Reconciler.evaluate', () => {
  let tmpDir: string;
  let reconciler: Reconciler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'litmus-test-'));
    reconciler = new Reconciler();
  });

  it('parses test-results.json and returns EvalResult for all-pass', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'test-results.json'),
      JSON.stringify({
        tests_passed: 3,
        tests_total: 3,
        framework: 'pytest',
        details: [
          { name: 'test_a', status: 'passed', duration_ms: 10, message: '' },
          { name: 'test_b', status: 'passed', duration_ms: 20, message: '' },
          { name: 'test_c', status: 'passed', duration_ms: 15, message: '' },
        ],
      }),
    );

    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(true);
    expect(result.testsPassed).toBe(3);
    expect(result.testsTotal).toBe(3);
    expect(result.totalScore).toBeCloseTo(100);
    expect(result.details).toHaveLength(3);
  });

  it('parses partial failure correctly', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'test-results.json'),
      JSON.stringify({
        tests_passed: 2,
        tests_total: 5,
        framework: 'pytest',
        details: [
          { name: 'test_a', status: 'passed', duration_ms: 10, message: '' },
          { name: 'test_b', status: 'failed', duration_ms: 20, message: 'AssertionError' },
          { name: 'test_c', status: 'failed', duration_ms: 5, message: 'KeyError' },
          { name: 'test_d', status: 'passed', duration_ms: 12, message: '' },
          { name: 'test_e', status: 'failed', duration_ms: 8, message: 'TypeError' },
        ],
      }),
    );

    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(false);
    expect(result.testsPassed).toBe(2);
    expect(result.testsTotal).toBe(5);
    expect(result.totalScore).toBeCloseTo(40);
  });

  it('returns zero score when test-results.json is missing', async () => {
    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(false);
    expect(result.testsPassed).toBe(0);
    expect(result.testsTotal).toBe(0);
    expect(result.totalScore).toBe(0);
  });

  it('returns zero score for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'test-results.json'), 'not-json');

    const result = await reconciler.evaluate(tmpDir);

    expect(result.allPassed).toBe(false);
    expect(result.totalScore).toBe(0);
  });
});

describe('Reconciler.finalize', () => {
  let tmpDir: string;
  let reconciler: Reconciler;

  const meta: TaskMeta = {
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'a1',
    modelId: 'm1',
    scenarioId: 's1',
    agentSlug: 'mock',
    modelSlug: 'gpt-4o',
    scenarioSlug: '1-trivial',
    attempt: 1,
    maxAttempts: 3,
    startedAt: new Date('2026-03-27T10:00:00Z'),
  };

  const passedEval: EvalResult = {
    allPassed: true,
    testsPassed: 3,
    testsTotal: 3,
    totalScore: 100,
    testOutput: '{}',
    details: [],
  };

  const failedEval: EvalResult = {
    allPassed: false,
    testsPassed: 1,
    testsTotal: 3,
    totalScore: 33.33,
    testOutput: '{}',
    details: [],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'litmus-finalize-'));
    reconciler = new Reconciler();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('inserts run_results with correct status and scores for passed run', async () => {
    const { db } = await import('@/db');

    await reconciler.finalize(tmpDir, meta, passedEval);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        agentId: 'a1',
        modelId: 'm1',
        scenarioId: 's1',
        status: 'completed',
        testsPassed: 3,
        testsTotal: 3,
        totalScore: 100,
        attempt: 1,
        maxAttempts: 3,
      }),
    );
  });

  it('inserts run_results with failed status for failed run', async () => {
    const { db } = await import('@/db');

    await reconciler.finalize(tmpDir, meta, failedEval);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        testsPassed: 1,
        testsTotal: 3,
        totalScore: 33.33,
      }),
    );
  });

  it('updates run_tasks status and finishedAt', async () => {
    const { db } = await import('@/db');

    await reconciler.finalize(tmpDir, meta, passedEval);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(mockDbUpdateSetWhere).toHaveBeenCalledTimes(1);
  });

  it('uploads workspace files to S3 with correct prefix', async () => {
    const { uploadFile } = await import('@/lib/s3');

    await fs.writeFile(path.join(tmpDir, 'output.txt'), 'hello');
    await fs.writeFile(path.join(tmpDir, 'result.json'), '{}');

    await reconciler.finalize(tmpDir, meta, passedEval);

    expect(uploadFile).toHaveBeenCalledTimes(2);

    const expectedPrefix = 'artifacts/run-1/mock/gpt-4o/1-trivial/';
    const calls = vi.mocked(uploadFile).mock.calls;
    const keys = calls.map((c) => c[1] as string).sort();

    expect(keys).toEqual([
      expectedPrefix + 'output.txt',
      expectedPrefix + 'result.json',
    ]);

    for (const call of calls) {
      expect(call[0]).toBe('litmus-artifacts');
    }
  });
});

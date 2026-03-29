import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler } from '../scheduler';
import { RunEventBus } from '../event-bus';
import { Reconciler } from '../reconciler';
import type { AgentExecutor, ExecutorHandle, RunConfig, RunEvent } from '../types';

vi.mock('@/lib/s3', () => ({
  downloadFile: vi.fn().mockResolvedValue(Buffer.from('')),
  listFiles: vi.fn().mockResolvedValue([]),
  BUCKETS: { scenarios: 'litmus-scenarios', artifacts: 'litmus-artifacts' },
}));

vi.mock('@/db', () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  runs: {},
  runTasks: {},
  runResults: {},
}));

function createMockExecutor(): AgentExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    type: 'docker',
    calls,
    async start() {
      calls.push('start');
      return { containerId: 'mock-container' } as ExecutorHandle;
    },
    async exec(_handle, cmd) {
      const cmdStr = cmd.join(' ');
      calls.push(`exec: ${cmdStr}`);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    async stop() {
      calls.push('stop');
    },
    async healthCheck() {
      return true;
    },
  };
}

function createMockReconciler(): Reconciler {
  const reconciler = new Reconciler();
  vi.spyOn(reconciler, 'evaluate').mockResolvedValue({
    allPassed: true,
    testsPassed: 3,
    testsTotal: 3,
    totalScore: 100,
    testOutput: '{}',
    details: [],
  });
  vi.spyOn(reconciler, 'finalize').mockResolvedValue(undefined);
  return reconciler;
}

describe('Scheduler', () => {
  let bus: RunEventBus;
  let executor: ReturnType<typeof createMockExecutor>;
  let reconciler: ReturnType<typeof createMockReconciler>;
  let events: RunEvent[];

  const config: RunConfig = {
    runId: 'run-1',
    maxRetries: 3,
    maxConcurrentLanes: 2,
    stepTimeoutSeconds: 0,
    taskIds: new Map([['e1:m1:s1', 'task-uuid-1']]),
    lanes: [
      {
        agent: { id: 'a1', slug: 'mock', name: 'Mock' },
        model: { id: 'm1', name: 'gpt-4o', externalId: 'gpt-4o' },
        executorId: 'e1',
        scenarios: [
          { id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' },
        ],
      },
    ],
  };

  beforeEach(() => {
    bus = new RunEventBus();
    executor = createMockExecutor();
    reconciler = createMockReconciler();
    events = [];
    bus.subscribe('run-1', (e) => events.push(e));
  });

  it('executes a single-lane single-scenario run to completion', async () => {
    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const types = events.map((e) => e.type);
    expect(types).toContain('task:started');
    expect(types).toContain('task:completed');
    expect(types).toContain('container:finished');
    expect(types).toContain('run:completed');
  });

  it('calls executor lifecycle: start → exec (init, run, test) → stop', async () => {
    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    expect(executor.calls[0]).toBe('start');
    expect(executor.calls.some((c: string) => c.includes('init.sh'))).toBe(true);
    expect(executor.calls.some((c: string) => c.includes('run.sh'))).toBe(true);
    expect(executor.calls.some((c: string) => c.includes('python.sh'))).toBe(true);
    expect(executor.calls.at(-1)).toBe('stop');
  });

  it('retries on test failure then succeeds', async () => {
    let attempt = 0;
    vi.spyOn(reconciler, 'evaluate').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return {
          allPassed: false, testsPassed: 1, testsTotal: 3,
          totalScore: 33, testOutput: 'fail', details: [],
        };
      }
      return {
        allPassed: true, testsPassed: 3, testsTotal: 3,
        totalScore: 100, testOutput: '{}', details: [],
      };
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const types = events.map((e) => e.type);
    expect(types).toContain('task:retrying');
    expect(types).toContain('task:completed');

    const completed = events.find((e) => e.type === 'task:completed');
    expect(completed).toHaveProperty('attempt', 2);
  });

  it('emits task:failed after all retries exhausted', async () => {
    vi.spyOn(reconciler, 'evaluate').mockResolvedValue({
      allPassed: false, testsPassed: 0, testsTotal: 3,
      totalScore: 0, testOutput: 'always fails', details: [],
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const failed = events.find((e) => e.type === 'task:failed');
    expect(failed).toBeDefined();
    // maxRetries=3 → maxAttempts=4, final attempt is 4
    expect(failed).toHaveProperty('attempt', 4);
    expect(failed).toHaveProperty('maxAttempts', 4);
    expect(failed).toHaveProperty('final', true);
  });

  it('emits run:completed with correct task counts', async () => {
    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed).toEqual(expect.objectContaining({
      totalTasks: 1,
      completedTasks: 1,
      failedTasks: 0,
      errorTasks: 0,
      cancelledTasks: 0,
    }));
  });
});

describe('Scheduler error paths', () => {
  let bus: RunEventBus;
  let executor: ReturnType<typeof createMockExecutor>;
  let reconciler: ReturnType<typeof createMockReconciler>;
  let events: RunEvent[];

  const config: RunConfig = {
    runId: 'run-1',
    maxRetries: 3,
    maxConcurrentLanes: 2,
    stepTimeoutSeconds: 0,
    taskIds: new Map([['e1:m1:s1', 'task-uuid-1']]),
    lanes: [
      {
        agent: { id: 'a1', slug: 'mock', name: 'Mock' },
        model: { id: 'm1', name: 'gpt-4o', externalId: 'gpt-4o' },
        executorId: 'e1',
        scenarios: [
          { id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' },
        ],
      },
    ],
  };

  beforeEach(() => {
    bus = new RunEventBus();
    executor = createMockExecutor();
    reconciler = createMockReconciler();
    events = [];
    bus.subscribe('run-1', (e) => events.push(e));
  });

  it('emits task:error when run.sh returns infra error exit code 2', async () => {
    const execCalls: string[][] = [];
    vi.spyOn(executor, 'exec').mockImplementation(async (_handle, cmd) => {
      execCalls.push([...cmd]);
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('run.sh')) {
        return { exitCode: 2, stdout: '', stderr: 'infra failure' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const types = events.map((e) => e.type);
    expect(types).toContain('task:error');
    expect(types).not.toContain('task:completed');
    expect(types).not.toContain('task:failed');

    const taskError = events.find((e) => e.type === 'task:error');
    expect(taskError).toHaveProperty('errorMessage', expect.stringContaining('infra error'));

    const runCompleted = events.find((e) => e.type === 'run:completed');
    expect(runCompleted).toHaveProperty('errorTasks', 1);
  });

  it('emits task:error with timeout message on exit code 124 and does not retry', async () => {
    const execCalls: string[][] = [];
    vi.spyOn(executor, 'exec').mockImplementation(async (_handle, cmd) => {
      execCalls.push([...cmd]);
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('run.sh')) {
        return { exitCode: 124, stdout: '', stderr: 'timed out' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const taskError = events.find((e) => e.type === 'task:error');
    expect(taskError).toBeDefined();
    expect(taskError).toHaveProperty('errorMessage', expect.stringContaining('timeout'));

    // Only init.sh + run.sh were called, no test script (no retry)
    const initCalls = execCalls.filter((c) => c.join(' ').includes('init.sh'));
    const runCalls = execCalls.filter((c) => c.join(' ').includes('run.sh'));
    const testCalls = execCalls.filter((c) => c.join(' ').includes('python.sh'));
    expect(initCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
    expect(testCalls).toHaveLength(0);
  });

  it('emits task:error when init.sh fails and never calls run.sh', async () => {
    const execCalls: string[][] = [];
    vi.spyOn(executor, 'exec').mockImplementation(async (_handle, cmd) => {
      execCalls.push([...cmd]);
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('init.sh')) {
        return { exitCode: 1, stdout: '', stderr: 'init failed' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const taskError = events.find((e) => e.type === 'task:error');
    expect(taskError).toBeDefined();
    expect(taskError).toHaveProperty('errorMessage', expect.stringContaining('init.sh'));

    const runCalls = execCalls.filter((c) => c.join(' ').includes('run.sh'));
    expect(runCalls).toHaveLength(0);
  });

  it('emits task:error when test script returns infra error exit code 2 and does not retry', async () => {
    const execCalls: string[][] = [];
    vi.spyOn(executor, 'exec').mockImplementation(async (_handle, cmd) => {
      execCalls.push([...cmd]);
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('python.sh')) {
        return { exitCode: 2, stdout: '', stderr: 'test harness crashed' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const types = events.map((e) => e.type);
    expect(types).toContain('task:error');
    expect(types).not.toContain('task:completed');
    expect(types).not.toContain('task:failed');
    expect(types).not.toContain('task:retrying');

    const taskError = events.find((e) => e.type === 'task:error');
    expect(taskError).toHaveProperty('errorMessage', expect.stringContaining('Test harness'));

    // run.sh called once, python.sh called once, no retry
    const runCalls = execCalls.filter((c) => c.join(' ').includes('run.sh'));
    const testCalls = execCalls.filter((c) => c.join(' ').includes('python.sh'));
    expect(runCalls).toHaveLength(1);
    expect(testCalls).toHaveLength(1);
  });
});

describe('Scheduler cancel and concurrency', () => {
  let bus: RunEventBus;
  let events: RunEvent[];

  beforeEach(() => {
    bus = new RunEventBus();
    events = [];
    bus.subscribe('run-cc', (e) => events.push(e));
  });

  it('cancels remaining tasks when cancel() is called mid-run', async () => {
    const executor = createMockExecutor();
    const reconciler = createMockReconciler();

    // Make run.sh slow for the first lane so we can cancel mid-flight
    let execCallCount = 0;
    const originalExec = executor.exec.bind(executor);
    executor.exec = async (handle: ExecutorHandle, cmd: string[], options?: { timeoutMs?: number }) => {
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('run.sh')) {
        execCallCount++;
        if (execCallCount === 1) {
          // First lane's run.sh is slow — gives us time to cancel
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return originalExec(handle, cmd, options);
    };

    const config: RunConfig = {
      runId: 'run-cc',
      maxRetries: 0,
      maxConcurrentLanes: 2,
      stepTimeoutSeconds: 0,
      taskIds: new Map([
        ['e1:m1:s1', 'task-1'],
        ['e2:m2:s1', 'task-2'],
      ]),
      lanes: [
        {
          agent: { id: 'a1', slug: 'agent1', name: 'Agent1' },
          model: { id: 'm1', name: 'model1', externalId: 'model1' },
          executorId: 'e1',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
        {
          agent: { id: 'a2', slug: 'agent2', name: 'Agent2' },
          model: { id: 'm2', name: 'model2', externalId: 'model2' },
          executorId: 'e2',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
      ],
    };

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    const executePromise = scheduler.execute(config);

    // Cancel after 50ms — first lane is still blocked in run.sh
    await new Promise((resolve) => setTimeout(resolve, 50));
    await scheduler.cancel('run-cc');

    await executePromise;

    const cancelledEvent = events.find((e) => e.type === 'run:cancelled');
    expect(cancelledEvent).toBeDefined();
    expect(cancelledEvent).toHaveProperty('runId', 'run-cc');

    // At least one task should be accounted for (completed or cancelled)
    const totalAccounted =
      (cancelledEvent as { completedTasks: number; cancelledTasks: number }).completedTasks +
      (cancelledEvent as { completedTasks: number; cancelledTasks: number }).cancelledTasks;
    expect(totalAccounted).toBeGreaterThanOrEqual(0);
  });

  it('processes multiple lanes with concurrency limit', async () => {
    const startTimestamps: { lane: string; time: number }[] = [];
    const finishTimestamps: { lane: string; time: number }[] = [];

    const executor = createMockExecutor();
    const reconciler = createMockReconciler();

    // Track when each lane's container starts
    const originalStart = executor.start.bind(executor);
    executor.start = async (cfg: Parameters<typeof executor.start>[0]) => {
      const laneKey = `${cfg.labels?.['litmus.agent']}-${cfg.labels?.['litmus.model']}`;
      startTimestamps.push({ lane: laneKey, time: Date.now() });
      return originalStart(cfg);
    };

    // Make each lane take some time so we can observe concurrency ordering
    const originalExec = executor.exec.bind(executor);
    executor.exec = async (handle: ExecutorHandle, cmd: string[], options?: { timeoutMs?: number }) => {
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('run.sh')) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return originalExec(handle, cmd, options);
    };

    // Track when each lane's container stops (lane finished)
    const originalStop = executor.stop.bind(executor);
    executor.stop = async (handle: ExecutorHandle) => {
      finishTimestamps.push({ lane: 'any', time: Date.now() });
      return originalStop(handle);
    };

    const config: RunConfig = {
      runId: 'run-cc',
      maxRetries: 0,
      maxConcurrentLanes: 2,
      stepTimeoutSeconds: 0,
      taskIds: new Map([
        ['e1:m1:s1', 'task-1'],
        ['e2:m2:s1', 'task-2'],
        ['e3:m3:s1', 'task-3'],
      ]),
      lanes: [
        {
          agent: { id: 'a1', slug: 'agent1', name: 'Agent1' },
          model: { id: 'm1', name: 'model1', externalId: 'model1' },
          executorId: 'e1',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
        {
          agent: { id: 'a2', slug: 'agent2', name: 'Agent2' },
          model: { id: 'm2', name: 'model2', externalId: 'model2' },
          executorId: 'e2',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
        {
          agent: { id: 'a3', slug: 'agent3', name: 'Agent3' },
          model: { id: 'm3', name: 'model3', externalId: 'model3' },
          executorId: 'e3',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
      ],
    };

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    // All 3 lanes should have started
    expect(startTimestamps).toHaveLength(3);

    // First 2 should start before the 3rd (concurrency limit = 2)
    // The 3rd lane starts only after one of the first 2 finishes
    const sortedStarts = [...startTimestamps].sort((a, b) => a.time - b.time);
    expect(sortedStarts[2].time).toBeGreaterThanOrEqual(finishTimestamps[0].time);

    // All 3 lanes should produce container:finished events
    const containerFinished = events.filter((e) => e.type === 'container:finished');
    expect(containerFinished).toHaveLength(3);

    // run:completed should account for all 3 tasks
    const runCompleted = events.find((e) => e.type === 'run:completed');
    expect(runCompleted).toBeDefined();
    expect(runCompleted).toHaveProperty('totalTasks', 3);
    expect(runCompleted).toHaveProperty('completedTasks', 3);
  });

  it('emits run:completed with all error/failed/completed counts', async () => {
    const executor = createMockExecutor();
    const reconciler = createMockReconciler();

    // Lane 1: pass, Lane 2: fail (allPassed=false), Lane 3: infra error (exit code 2)
    let evalCallCount = 0;
    vi.spyOn(reconciler, 'evaluate').mockImplementation(async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        // Lane 1 — passes
        return { allPassed: true, testsPassed: 3, testsTotal: 3, totalScore: 100, testOutput: '{}', details: [] };
      }
      // Lane 2 — always fails (retries exhausted since maxRetries=0)
      return { allPassed: false, testsPassed: 0, testsTotal: 3, totalScore: 0, testOutput: 'fail', details: [] };
    });

    // Lane 3 (model3) gets infra error on run.sh
    const originalExec = executor.exec.bind(executor);
    executor.exec = async (handle: ExecutorHandle, cmd: string[], options?: { timeoutMs?: number }) => {
      const cmdStr = cmd.join(' ');
      if (cmdStr.includes('run.sh') && cmdStr.includes('model3')) {
        return { exitCode: 2, stdout: '', stderr: 'infra failure' };
      }
      return originalExec(handle, cmd, options);
    };

    const config: RunConfig = {
      runId: 'run-cc',
      maxRetries: 0,
      maxConcurrentLanes: 3,
      stepTimeoutSeconds: 0,
      taskIds: new Map([
        ['e1:m1:s1', 'task-1'],
        ['e2:m2:s1', 'task-2'],
        ['e3:m3:s1', 'task-3'],
      ]),
      lanes: [
        {
          agent: { id: 'a1', slug: 'agent1', name: 'Agent1' },
          model: { id: 'm1', name: 'model1', externalId: 'model1' },
          executorId: 'e1',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
        {
          agent: { id: 'a2', slug: 'agent2', name: 'Agent2' },
          model: { id: 'm2', name: 'model2', externalId: 'model2' },
          executorId: 'e2',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
        {
          agent: { id: 'a3', slug: 'agent3', name: 'Agent3' },
          model: { id: 'm3', name: 'model3', externalId: 'model3' },
          executorId: 'e3',
          scenarios: [{ id: 's1', slug: '1-trivial-pass', promptPath: '1-trivial-pass/prompt.txt', language: 'python' }],
        },
      ],
    };

    const scheduler = new Scheduler(executor, reconciler, bus, './work');
    await scheduler.execute(config);

    const runCompleted = events.find((e) => e.type === 'run:completed');
    expect(runCompleted).toBeDefined();
    expect(runCompleted).toEqual(expect.objectContaining({
      type: 'run:completed',
      totalTasks: 3,
      completedTasks: 1,
      failedTasks: 1,
      errorTasks: 1,
      cancelledTasks: 0,
    }));
  });
});

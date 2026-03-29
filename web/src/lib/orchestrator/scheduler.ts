import * as fs from 'fs/promises';
import path from 'path';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runResults, runTasks } from '@/db/schema';
import { refreshMatviews } from '@/lib/db/refresh-matviews';
import { downloadFile, listFiles, BUCKETS } from '@/lib/s3';
import type {
  AgentExecutor,
  ExecutorHandle,
  RunConfig,
  LaneConfig,
  EvalResult,
  TaskMeta,
} from './types';
import type { Reconciler } from './reconciler';
import type { EventBus } from './event-bus';

export class Scheduler {
  private cancelled = false;
  private activeHandles = new Map<string, ExecutorHandle>();

  constructor(
    private executor: AgentExecutor,
    private reconciler: Reconciler,
    private bus: EventBus,
    private workRoot: string,
  ) {}

  async execute(config: RunConfig): Promise<void> {
    this.cancelled = false;

    // Update run status to running
    await db
      .update(runs)
      .set({ status: 'running' })
      .where(eq(runs.id, config.runId))
      .catch((reason) => this.logBestEffortFailure(`Failed to mark run ${config.runId} as running`, reason));

    // Stage scenarios from S3 to work directory
    const allSlugs = new Set<string>();
    for (const lane of config.lanes) {
      for (const scenario of lane.scenarios) {
        allSlugs.add(scenario.slug);
      }
    }
    for (const slug of allSlugs) {
      await this.stageScenario(config.runId, slug);
    }

    const results = { completed: 0, failed: 0, error: 0, cancelled: 0 };

    // Process lanes with concurrency limit
    const laneQueue = [...config.lanes];
    const activeLanes: Promise<void>[] = [];

    const processNextLane = async (): Promise<void> => {
      while (laneQueue.length > 0 && !this.cancelled) {
        const lane = laneQueue.shift()!;
        const laneResults = await this.executeLane(config, lane);
        results.completed += laneResults.completed;
        results.failed += laneResults.failed;
        results.error += laneResults.error;
        results.cancelled += laneResults.cancelled;
      }
    };

    for (let i = 0; i < config.maxConcurrentLanes; i++) {
      activeLanes.push(processNextLane());
    }

    await Promise.all(activeLanes);

    const totalTasks = config.lanes.reduce((sum, l) => sum + l.scenarios.length, 0);

    if (this.cancelled) {
      this.bus.emit(config.runId, {
        type: 'run:cancelled',
        runId: config.runId,
        completedTasks: results.completed,
        cancelledTasks: results.cancelled,
      });
    } else {
      this.bus.emit(config.runId, {
        type: 'run:completed',
        runId: config.runId,
        totalTasks,
        completedTasks: results.completed,
        failedTasks: results.failed,
        errorTasks: results.error,
        cancelledTasks: results.cancelled,
      });
    }

    // Update run status
    const finalStatus = this.cancelled ? 'cancelled' : 'completed';
    await db
      .update(runs)
      .set({ status: finalStatus, finishedAt: new Date() })
      .where(eq(runs.id, config.runId))
      .catch((reason) => this.logBestEffortFailure(`Failed to finalize run ${config.runId}`, reason));

    await refreshMatviews({
      warn: (message) => console.warn(message),
    }).catch((reason) => this.logBestEffortFailure(`Failed to refresh matviews after run ${config.runId}`, reason));

    // Cleanup workspace
    const runDir = path.join(this.workRoot, 'runs', config.runId);
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled = true;
    for (const [, handle] of this.activeHandles) {
      try { await this.executor.stop(handle); } catch { /* best effort */ }
    }
    this.activeHandles.clear();

    await db
      .update(runTasks)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runTasks.runId, runId), inArray(runTasks.status, ['pending', 'running'])))
      .catch((reason) => this.logBestEffortFailure(`Failed to cancel pending tasks for run ${runId}`, reason));
  }

  private async executeLane(
    config: RunConfig,
    lane: LaneConfig,
  ): Promise<{ completed: number; failed: number; error: number; cancelled: number }> {
    const results = { completed: 0, failed: 0, error: 0, cancelled: 0 };
    const laneKey = `${lane.agent.slug}-${lane.model.name}`;
    const maxAttempts = config.maxRetries + 1;

    let handle: ExecutorHandle | null = null;
    let nextScenarioIndex = 0;

    try {
      const agentHostDir = this.resolveAgentHostDir(lane.agent.slug);
      const workHostDir = this.resolveWorkHostDir();

      handle = await this.executor.start({
        image: 'litmus/runtime-python',
        agentHostDir,
        workHostDir,
        runId: config.runId,
        env: {},
        labels: {
          'litmus.managed': 'true',
          'litmus.run-id': config.runId,
          'litmus.agent': lane.agent.slug,
          'litmus.model': lane.model.name,
        },
      });
      this.activeHandles.set(laneKey, handle);

      for (const scenario of lane.scenarios) {
        nextScenarioIndex = lane.scenarios.indexOf(scenario);
        if (this.cancelled) {
          results.cancelled += lane.scenarios.length - (results.completed + results.failed + results.error);
          break;
        }
        const taskResult = await this.executeScenario(config, lane, scenario, handle);
        results[taskResult]++;
      }
    } catch (reason) {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      const remainingScenarios = lane.scenarios.slice(nextScenarioIndex);
      const startedAt = new Date();

      for (const scenario of remainingScenarios) {
        const taskId = this.resolveTaskId(config, lane, scenario.id);
        this.bus.emit(config.runId, {
          type: 'task:error',
          runId: config.runId,
          taskId,
          agent: lane.agent.name,
          model: lane.model.name,
          scenario: scenario.slug,
          errorMessage,
        });
        await this.persistTaskError(
          this.buildTaskMeta(config, lane, scenario, taskId, 1, maxAttempts, startedAt),
          errorMessage,
        );
        results.error++;
      }
    } finally {
      if (handle) {
        try { await this.executor.stop(handle); } catch { /* best effort */ }
        this.activeHandles.delete(laneKey);
      }
    }

    this.bus.emit(config.runId, {
      type: 'container:finished',
      runId: config.runId,
      agent: lane.agent.name,
      model: lane.model.name,
      completedCount: results.completed,
      failedCount: results.failed,
      errorCount: results.error,
    });

    return results;
  }

  private resolveTaskId(config: RunConfig, lane: LaneConfig, scenarioId: string): string {
    const key = `${lane.executorId}:${lane.model.id}:${scenarioId}`;
    const dbId = config.taskIds.get(key);
    if (!dbId) {
      throw new Error(`No task ID found for key ${key}`);
    }
    return dbId;
  }

  private async executeScenario(
    config: RunConfig,
    lane: LaneConfig,
    scenario: { id: string; slug: string; promptPath: string; language: string },
    handle: ExecutorHandle,
  ): Promise<'completed' | 'failed' | 'error'> {
    const sessionDir = `/work/runs/${config.runId}/${lane.agent.slug}/${lane.model.name}/${scenario.slug}`;
    const localSessionDir = path.join(this.workRoot, 'runs', config.runId, lane.agent.slug, lane.model.name, scenario.slug);
    const scenarioStagedPath = `/work/runs/${config.runId}/_scenarios/${scenario.slug}`;
    const taskId = this.resolveTaskId(config, lane, scenario.id);
    const startedAt = new Date();
    const maxAttempts = config.maxRetries + 1;
    const buildErrorMeta = (attempt: number) =>
      this.buildTaskMeta(config, lane, scenario, taskId, attempt, maxAttempts, startedAt);

    this.bus.emit(config.runId, {
      type: 'task:started',
      runId: config.runId,
      taskId,
      agent: lane.agent.name,
      model: lane.model.name,
      scenario: scenario.slug,
      attempt: 1,
      maxAttempts,
      timestamp: startedAt.toISOString(),
    });

    // Persist running state so reload shows correct status
    await db
      .update(runTasks)
      .set({ status: 'running', startedAt })
      .where(eq(runTasks.id, taskId))
      .catch(() => {}); // best-effort — don't block execution

    try {
      const stepTimeout = config.stepTimeoutSeconds > 0
        ? { timeoutMs: config.stepTimeoutSeconds * 1000 }
        : undefined;

      // init.sh — prepare workspace (subject to same step timeout)
      const initResult = await this.executor.exec(handle, [
        '/opt/agent/../init.sh',
        '--scenario', scenarioStagedPath,
        '--workspace', sessionDir,
      ], stepTimeout);

      if (initResult.exitCode !== 0) {
        const label = this.isInfraError(initResult.exitCode)
          ? this.infraErrorLabel(initResult.exitCode)
          : `exit ${initResult.exitCode}`;
        const msg = `init.sh ${label}: ${initResult.stderr}`;
        this.bus.emit(config.runId, {
          type: 'task:error', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
          errorMessage: msg,
        });
        await this.persistTaskError(buildErrorMeta(1), msg);
        return 'error';
      }

      // Read prompt from staged scenario
      let prompt: string;
      try {
        const localPromptPath = path.join(this.workRoot, 'runs', config.runId, '_scenarios', scenario.slug, 'prompt.txt');
        prompt = await fs.readFile(localPromptPath, 'utf-8');
      } catch {
        prompt = 'Implement the required functionality to make all tests pass.';
      }

      // Retry loop: maxAttempts = 1 + maxRetries
      let evalResult: EvalResult | null = null;
      const testScript = this.resolveTestScript(scenario.language);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const currentPrompt = attempt === 1
          ? prompt
          : this.buildRetryPrompt(prompt, evalResult?.testOutput ?? '');

        const agentResult = await this.executor.exec(handle, [
          '/opt/agent/run.sh',
          '--model', lane.model.externalId,
          '--prompt', currentPrompt,
          '--workspace', sessionDir,
          '--scenario-dir', scenarioStagedPath,
        ], stepTimeout);

        // Exit 2 = infra error, 124 = timeout — both are non-retryable
        if (this.isInfraError(agentResult.exitCode)) {
          const msg = `run.sh ${this.infraErrorLabel(agentResult.exitCode)}: ${agentResult.stderr}`;
          this.bus.emit(config.runId, {
            type: 'task:error', runId: config.runId, taskId,
            agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
            errorMessage: msg,
          });
          await this.persistTaskError(buildErrorMeta(attempt), msg);
          return 'error';
        }

        const testResult = await this.executor.exec(handle, [
          testScript,
          '--workspace', sessionDir,
          '--output', `${sessionDir}/test-results.json`,
        ], stepTimeout);

        if (this.isInfraError(testResult.exitCode)) {
          const msg = `Test harness ${this.infraErrorLabel(testResult.exitCode)}: ${testResult.stderr}`;
          this.bus.emit(config.runId, {
            type: 'task:error', runId: config.runId, taskId,
            agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
            errorMessage: msg,
          });
          await this.persistTaskError(buildErrorMeta(attempt), msg);
          return 'error';
        }

        evalResult = await this.reconciler.evaluate(localSessionDir);

        if (evalResult.allPassed) {
          const duration = Math.round((Date.now() - startedAt.getTime()) / 1000);
          this.bus.emit(config.runId, {
            type: 'task:completed', runId: config.runId, taskId,
            agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
            attempt, maxAttempts,
            score: evalResult.totalScore, testsPassed: evalResult.testsPassed,
            testsTotal: evalResult.testsTotal, duration, final: true,
          });

          await this.reconciler.finalize(localSessionDir, this.buildTaskMeta(config, lane, scenario, taskId, attempt, maxAttempts, startedAt), evalResult);
          return 'completed';
        }

        if (attempt < maxAttempts) {
          this.bus.emit(config.runId, {
            type: 'task:retrying', runId: config.runId, taskId,
            agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
            attempt, maxAttempts, testOutput: evalResult.testOutput,
          });
        }
      }

      // All retries exhausted
      this.bus.emit(config.runId, {
        type: 'task:failed', runId: config.runId, taskId,
        agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
        attempt: maxAttempts, maxAttempts,
        score: evalResult?.totalScore ?? 0,
        errorMessage: `Tests failed after ${maxAttempts} attempts`, final: true,
      });

      await this.reconciler.finalize(localSessionDir, this.buildTaskMeta(config, lane, scenario, taskId, maxAttempts, maxAttempts, startedAt), evalResult!);
      return 'failed';

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit(config.runId, {
        type: 'task:error', runId: config.runId, taskId,
        agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
        errorMessage: msg,
      });
      await this.persistTaskError(buildErrorMeta(1), msg);
      return 'error';
    }
  }

  private buildTaskMeta(
    config: RunConfig, lane: LaneConfig,
    scenario: { id: string; slug: string }, taskId: string,
    attempt: number, maxAttempts: number, startedAt: Date,
  ): TaskMeta {
    return {
      runId: config.runId, taskId,
      agentId: lane.agent.id, modelId: lane.model.id, scenarioId: scenario.id,
      agentSlug: lane.agent.slug, modelSlug: lane.model.name, scenarioSlug: scenario.slug,
      attempt, maxAttempts, startedAt,
    };
  }

  private buildRetryPrompt(originalPrompt: string, testOutput: string): string {
    return `Original task: ${originalPrompt}\n\nPrevious attempt failed. Test output:\n${testOutput}\n\nFix the code to make all tests pass.`;
  }

  /** Persist terminal error status to run_tasks so reload/replay works */
  private async persistTaskError(meta: TaskMeta, errorMessage: string): Promise<void> {
    const finishedAt = new Date();
    const durationSeconds = Math.max(0, Math.round((finishedAt.getTime() - meta.startedAt.getTime()) / 1000));

    await db
      .insert(runResults)
      .values({
        runId: meta.runId,
        agentId: meta.agentId,
        modelId: meta.modelId,
        scenarioId: meta.scenarioId,
        status: 'error',
        testsPassed: 0,
        testsTotal: 0,
        totalScore: 0,
        durationSeconds,
        attempt: meta.attempt,
        maxAttempts: meta.maxAttempts,
        errorMessage,
      })
      .onConflictDoNothing({
        target: [runResults.runId, runResults.agentId, runResults.modelId, runResults.scenarioId],
      })
      .catch((reason) => this.logBestEffortFailure(`Failed to insert error result for task ${meta.taskId}`, reason));

    await db
      .update(runTasks)
      .set({ status: 'error', finishedAt, errorMessage })
      .where(eq(runTasks.id, meta.taskId))
      .catch((reason) => this.logBestEffortFailure(`Failed to persist error status for task ${meta.taskId}`, reason));
  }

  /** Exit codes that signal non-retryable infrastructure failures */
  private isInfraError(exitCode: number): boolean {
    return exitCode === 2 || exitCode === 124;
  }

  private infraErrorLabel(exitCode: number): string {
    if (exitCode === 124) return 'timeout (exit 124)';
    return `infra error (exit ${exitCode})`;
  }

  private resolveTestScript(language: string): string {
    const scripts: Record<string, string> = { python: '/opt/agent/../tests/python.sh' };
    return scripts[language] ?? scripts.python;
  }

  private resolveAgentHostDir(agentSlug: string): string {
    const envDir = process.env.AGENTS_HOST_DIR;
    if (envDir) return path.resolve(envDir, 'agents', agentSlug);
    return path.resolve('./agents', agentSlug);
  }

  private resolveWorkHostDir(): string {
    return process.env.WORK_HOST_DIR ?? path.resolve('./work');
  }

  private async stageScenario(runId: string, scenarioSlug: string): Promise<void> {
    const stageDir = path.join(this.workRoot, 'runs', runId, '_scenarios', scenarioSlug);
    await fs.mkdir(stageDir, { recursive: true });

    const files = await listFiles(BUCKETS.scenarios, `${scenarioSlug}/`);
    for (const key of files) {
      const relativePath = key.slice(scenarioSlug.length + 1);
      if (!relativePath) continue;
      const targetPath = path.join(stageDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = await downloadFile(BUCKETS.scenarios, key);
      await fs.writeFile(targetPath, content);
    }
  }

  private logBestEffortFailure(message: string, reason: unknown): void {
    const detail = reason instanceof Error ? reason.message : String(reason);
    console.warn(`[scheduler] ${message}: ${detail}`);
  }
}

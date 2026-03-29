import * as fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { runResults, runTasks } from '@/db/schema';
import { uploadFile, BUCKETS } from '@/lib/s3';
// Lazy import to avoid pulling Redis/env at module parse time (breaks unit tests)
async function enqueueJudgeTasks(runResultId: string): Promise<void> {
  const { enqueueJudgeTasks: enqueue } = await import('@/lib/judge/service');
  return enqueue(runResultId);
}
import type { EvalResult, TaskMeta } from './types';

interface TestResultsJson {
  tests_passed: number;
  tests_total: number;
  framework: string;
  details: Array<{
    name: string;
    status: 'passed' | 'failed';
    duration_ms: number;
    message: string;
  }>;
}

export class Reconciler {
  /**
   * evaluate() — Read test-results.json, compute score.
   * Called after each attempt (including retries). Does NOT write to DB.
   */
  async evaluate(sessionDir: string): Promise<EvalResult> {
    const resultsPath = path.join(sessionDir, 'test-results.json');

    let raw: string;
    try {
      raw = await fs.readFile(resultsPath, 'utf-8');
    } catch {
      return this.emptyResult('test-results.json not found');
    }

    let data: TestResultsJson;
    try {
      data = JSON.parse(raw);
    } catch {
      return this.emptyResult('test-results.json is malformed');
    }

    const testsPassed = data.tests_passed ?? 0;
    const testsTotal = data.tests_total ?? 0;
    const totalScore = testsTotal > 0 ? (testsPassed / testsTotal) * 100 : 0;

    return {
      allPassed: testsPassed === testsTotal && testsTotal > 0,
      testsPassed,
      testsTotal,
      totalScore,
      testOutput: raw,
      details: (data.details ?? []).map((d) => ({
        name: d.name,
        status: d.status,
        durationMs: d.duration_ms,
        message: d.message ?? '',
      })),
    };
  }

  /**
   * finalize() — Called once per (run, agent, model, scenario) after the final attempt.
   * Inserts run_results, uploads artifacts to S3, updates run_tasks.status.
   */
  async finalize(
    sessionDir: string,
    meta: TaskMeta,
    evalResult: EvalResult,
  ): Promise<void> {
    const durationSeconds = Math.round((Date.now() - meta.startedAt.getTime()) / 1000);
    const status = evalResult.allPassed ? 'completed' : 'failed';
    const s3Key = `artifacts/${meta.runId}/${meta.agentSlug}/${meta.modelSlug}/${meta.scenarioSlug}/`;

    // Upload workspace contents to S3
    await this.uploadArtifacts(sessionDir, s3Key);

    // Insert into run_results (includes attempt for SSE replay)
    const [insertedResult] = await db.insert(runResults).values({
      runId: meta.runId,
      agentId: meta.agentId,
      modelId: meta.modelId,
      scenarioId: meta.scenarioId,
      status,
      testsPassed: evalResult.testsPassed,
      testsTotal: evalResult.testsTotal,
      totalScore: evalResult.totalScore,
      durationSeconds,
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
      artifactsS3Key: s3Key,
    }).returning({ id: runResults.id });

    // Fire-and-forget judge enqueue
    enqueueJudgeTasks(insertedResult.id).catch((err) => {
      console.error('[Reconciler] Failed to enqueue judge tasks:', err);
    });

    // Update run_tasks.status
    await db
      .update(runTasks)
      .set({
        status,
        finishedAt: new Date(),
        exitCode: evalResult.allPassed ? 0 : 1,
      })
      .where(eq(runTasks.id, meta.taskId));
  }

  private async uploadArtifacts(sessionDir: string, s3Prefix: string): Promise<void> {
    const files = await this.walkDir(sessionDir);
    for (const filePath of files) {
      const relativePath = path.relative(sessionDir, filePath);
      const key = s3Prefix + relativePath.replace(/\\/g, '/');
      const content = await fs.readFile(filePath);
      await uploadFile(BUCKETS.artifacts, key, content);
    }
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await this.walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  private emptyResult(testOutput: string): EvalResult {
    return {
      allPassed: false,
      testsPassed: 0,
      testsTotal: 0,
      totalScore: 0,
      testOutput,
      details: [],
    };
  }
}

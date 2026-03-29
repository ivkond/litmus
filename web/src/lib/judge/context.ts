import { db } from '@/db';
import { runResults, scenarios, agents, models } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { downloadFile, BUCKETS } from '@/lib/s3';
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

export type { JudgeContext };

async function loadText(s3Key: string): Promise<string> {
  try {
    const buf = await downloadFile(BUCKETS.artifacts, s3Key);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
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

  // Load logs from S3
  let initLog = '';
  let agentLog = '';
  let testLog = '';
  let files: { path: string; content: string }[] = [];

  if (result.artifactsS3Key) {
    initLog = redactSecrets(await loadText(`${result.artifactsS3Key}/init.log`));
    agentLog = redactSecrets(await loadText(`${result.artifactsS3Key}/agent.log`));
    testLog = redactSecrets(await loadText(`${result.artifactsS3Key}/test.log`));

    try {
      const artifactsJson = await loadText(`${result.artifactsS3Key}/artifacts.json`);
      if (artifactsJson) {
        files = JSON.parse(artifactsJson);
      }
    } catch {
      // artifacts listing unavailable
    }
  }

  return {
    scenario: {
      prompt: scenario?.description ?? '',
      scoringCriteria: [],
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

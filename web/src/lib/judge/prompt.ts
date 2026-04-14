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

  sections.push(`## Task
${truncate(ctx.scenario.prompt, budget.scenario)}

### Scoring Criteria
${ctx.scenario.scoringCriteria.map((c) => `- ${c.criterion} (${c.maxPoints} pts)`).join('\n')}`);

  const testDetails =
    ctx.execution.testResults.details.length > 50
      ? ctx.execution.testResults.details.slice(0, 50)
      : ctx.execution.testResults.details;

  sections.push(`## Test Results
Passed: ${ctx.execution.testResults.passed}/${ctx.execution.testResults.total}

${JSON.stringify(testDetails, null, 2).slice(0, budget.testResults)}`);

  sections.push(`## Agent Execution Log
${truncate(ctx.execution.agentLog, budget.artifacts)}`);

  let artifactBudget = budget.artifacts;
  const artifactSections: string[] = [];
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

  sections.push(`## Test Log
${truncate(ctx.execution.testLog, budget.testLog)}`);

  if (ctx.execution.initLog) {
    sections.push(`## Init Log
${truncate(ctx.execution.initLog, budget.initLog)}`);
  }

  sections.push(`## Meta
- Agent: ${ctx.meta.agent}
- Model: ${ctx.meta.model}
- Attempt: ${ctx.meta.attempt}/${ctx.meta.maxAttempts}
- Duration: ${ctx.meta.durationSeconds}s`);

  return sections.join('\n\n');
}

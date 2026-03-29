// web/src/lib/judge/__tests__/prompt.test.ts
import { describe, it, expect } from 'vitest';
import { allocateBudget, buildSystemPrompt, buildUserPrompt } from '../prompt';
import { CRITERIA, BLOCKING_CHECKS } from '../criteria';

describe('allocateBudget', () => {
  it('allocates fixed budgets for system + scenario + test results', () => {
    const budget = allocateBudget(120000);
    expect(budget.system).toBe(3000);
    expect(budget.scenario).toBe(2000);
    expect(budget.testResults).toBe(2000);
  });

  it('splits remaining budget: agent=compressed, artifacts 60%, testLog 30%, initLog 10%', () => {
    const budget = allocateBudget(120000);
    const remaining = 120000 - 3000 - 2000 - 2000;
    expect(budget.artifacts).toBe(Math.floor(remaining * 0.6));
    expect(budget.testLog).toBe(Math.floor(remaining * 0.3));
    expect(budget.initLog).toBe(Math.floor(remaining * 0.1));
  });

  it('works with small budget', () => {
    const budget = allocateBudget(10000);
    expect(budget.system + budget.scenario + budget.testResults).toBe(7000);
    const remaining = 3000;
    expect(budget.artifacts).toBe(Math.floor(remaining * 0.6));
  });
});

describe('buildSystemPrompt', () => {
  it('includes all 10 criteria', () => {
    const prompt = buildSystemPrompt();
    for (const c of CRITERIA) {
      expect(prompt).toContain(c.key);
      expect(prompt).toContain(c.title);
    }
  });

  it('includes all 4 blocking checks', () => {
    const prompt = buildSystemPrompt();
    for (const b of BLOCKING_CHECKS) {
      expect(prompt).toContain(b.key);
    }
  });

  it('specifies JSON response format', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"scores"');
    expect(prompt).toContain('"blocking"');
  });
});

describe('buildUserPrompt', () => {
  const context = {
    scenario: {
      prompt: 'Build a calculator',
      scoringCriteria: [{ criterion: 'Correctness', maxPoints: 10 }],
    },
    execution: {
      initLog: 'init done',
      agentLog: 'agent did things',
      testLog: 'test output',
      testResults: { passed: 8, total: 10, details: [] },
    },
    artifacts: { files: [{ path: 'calc.ts', content: 'code here' }] },
    meta: { agent: 'claude', model: 'sonnet', attempt: 1, maxAttempts: 3, durationSeconds: 45 },
  };

  it('includes scenario prompt', () => {
    const prompt = buildUserPrompt(context, 120000);
    expect(prompt).toContain('Build a calculator');
  });

  it('includes test results', () => {
    const prompt = buildUserPrompt(context, 120000);
    expect(prompt).toContain('8/10');
  });

  it('includes artifacts', () => {
    const prompt = buildUserPrompt(context, 120000);
    expect(prompt).toContain('calc.ts');
  });

  it('respects total budget', () => {
    const largeContext = {
      ...context,
      execution: {
        ...context.execution,
        agentLog: 'x'.repeat(200000),
        testLog: 'y'.repeat(200000),
        initLog: 'z'.repeat(200000),
      },
      artifacts: {
        files: [{ path: 'big.ts', content: 'c'.repeat(200000) }],
      },
    };
    const prompt = buildUserPrompt(largeContext, 30000);
    expect(prompt.length).toBeLessThan(35000);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

async function isServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/scenarios`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

let serverAvailable = false;

/**
 * E2E: Full ACP run lifecycle with mock agent.
 *
 * Verification #5 from spec: POST /api/runs → SSE task:started → init.sh →
 * ACP prompt (mock copies solution) → test script → task:completed SSE →
 * run_results row with status='completed' and totalScore=100.
 *
 * Prerequisites:
 * - Docker running with litmus/runtime-python image built
 * - Database seeded with mock agent, model, and scenario
 * - S3/garage running with scenario files uploaded
 * - Server running at E2E_BASE_URL
 *
 * This test uses the same infrastructure as run-pipeline.test.ts.
 * It validates the ACP execution path specifically (no run.sh).
 */
describe('ACP run lifecycle E2E', () => {
  beforeAll(async () => {
    serverAvailable = await isServerReachable();
    if (!serverAvailable) {
      console.warn(
        `\n⚠  E2E server not reachable at ${BASE_URL}.\n` +
        `   ACP lifecycle tests will be skipped.\n` +
        `   Set E2E_BASE_URL or start the server before running test:e2e.\n`,
      );
    }
  });

  it.skipIf(!serverAvailable)('completes a full run with mock ACP agent', async () => {
    // 1. Find mock agent and a scenario to run against
    const agentsRes = await fetch(`${BASE_URL}/api/agents`);
    expect(agentsRes.ok).toBe(true);
    const agents = await agentsRes.json();
    const mockAgent = agents.find((a: { slug?: string; name?: string }) =>
      a.slug === 'mock' || a.name?.toLowerCase().includes('mock'),
    );
    expect(mockAgent).toBeDefined();

    const scenariosRes = await fetch(`${BASE_URL}/api/scenarios`);
    expect(scenariosRes.ok).toBe(true);
    const scenarios = await scenariosRes.json();
    expect(scenarios.length).toBeGreaterThan(0);
    const scenario = scenarios[0];

    // 2. Discover models for mock agent
    const modelsRes = await fetch(`${BASE_URL}/api/agents/${mockAgent.id}/models`, { method: 'POST' });
    expect(modelsRes.ok).toBe(true);
    const models = await modelsRes.json();
    expect(models.length).toBeGreaterThan(0);
    const model = models[0];

    // 3. Start a run
    const runRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [{ id: mockAgent.id, models: [model.dbId] }],
        scenarios: [scenario.id],
        maxRetries: 0,
        maxConcurrentLanes: 1,
        stepTimeoutSeconds: 60,
      }),
    });
    expect(runRes.ok).toBe(true);
    const { runId } = await runRes.json();

    // 4. Subscribe to SSE and collect events
    const sseRes = await fetch(`${BASE_URL}/api/runs/${runId}/stream`);
    expect(sseRes.ok).toBe(true);

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const timeout = setTimeout(() => reader.cancel(), 30_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              events.push(event);
              if (event.type === 'run:completed' || event.type === 'run:cancelled') {
                reader.cancel();
              }
            } catch { /* skip malformed lines */ }
          }
        }
      }
    } catch {
      // Reader cancelled or stream ended
    } finally {
      clearTimeout(timeout);
    }

    // 5. Verify SSE events
    const types = events.map((e) => e.type);
    expect(types).toContain('task:started');
    expect(types).toContain('task:completed');
    expect(types).toContain('run:completed');
    expect(types).not.toContain('task:error');

    const completed = events.find((e) => e.type === 'task:completed');
    expect(completed).toHaveProperty('score', 100);
    expect(completed).toHaveProperty('final', true);

    // 6. Verify run results in DB via API
    const resultRes = await fetch(`${BASE_URL}/api/runs/${runId}`);
    expect(resultRes.ok).toBe(true);
    const result = await resultRes.json();
    expect(result.status).toBe('completed');
  }, 60_000);
});

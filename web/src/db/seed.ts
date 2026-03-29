import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { agents, models, scenarios, runs, runResults } from './schema';

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

async function seed() {
  console.log('Seeding database (truncate + insert)...');

  // ─── Truncate in dependency order ───────────────────────────
  await client`TRUNCATE run_results, run_tasks, runs, agent_executors, scenarios, models, agents CASCADE`;

  // ─── Agents ─────────────────────────────────────────────────
  const insertedAgents = await db
    .insert(agents)
    .values([
      { name: 'Claude Code', version: '1.0.32' },
      { name: 'Aider', version: '0.82.0' },
      { name: 'OpenCode', version: '0.5.1' },
    ])
    .returning();

  // ─── Models ─────────────────────────────────────────────────
  const insertedModels = await db
    .insert(models)
    .values([
      { name: 'Sonnet 4', provider: 'Anthropic' },
      { name: 'Opus 4', provider: 'Anthropic' },
      { name: 'GPT-4o', provider: 'OpenAI' },
      { name: 'Gemini 2.5 Pro', provider: 'Google' },
    ])
    .returning();

  // ─── Scenarios ──────────────────────────────────────────────
  const insertedScenarios = await db
    .insert(scenarios)
    .values([
      { slug: '1-data-structure', name: 'Data Structure', language: 'python', description: 'Implement a binary search tree with insert, search, delete', maxScore: 100 },
      { slug: '2-simple-architecture', name: 'Simple Architecture', language: 'python', description: 'Design a layered REST API service', maxScore: 100 },
      { slug: '3-api-design', name: 'API Design', language: 'python', description: 'Build a RESTful API with proper error handling', maxScore: 100 },
      { slug: '4-refactoring', name: 'Refactoring', language: 'python', description: 'Refactor legacy code into clean architecture', maxScore: 100 },
      { slug: '5-testing', name: 'Testing', language: 'python', description: 'Write comprehensive test suite for existing code', maxScore: 100 },
      { slug: '6-debugging', name: 'Debugging', language: 'python', description: 'Find and fix bugs in provided code', maxScore: 100 },
    ])
    .returning();

  // ─── Run + Results ──────────────────────────────────────────
  const [run1] = await db
    .insert(runs)
    .values({
      status: 'completed',
      finishedAt: new Date(),
      configSnapshot: { agents: 3, models: 4, scenarios: 6 },
    })
    .returning();

  // Deterministic scores using seeded pseudo-random (no Math.random)
  const resultRows = [];
  let seedCounter = 0;
  function seededScore(agentIdx: number, modelIdx: number, scenarioIdx: number): number {
    // Deterministic but varied scores based on position
    const base = 45 + ((agentIdx * 17 + modelIdx * 13 + scenarioIdx * 7 + seedCounter++) % 40);
    const agentBonus = [8, 3, 0][agentIdx] ?? 0;   // Claude > Aider > OpenCode
    const modelBonus = [5, 10, 3, 4][modelIdx] ?? 0; // Opus best, Sonnet second
    return Math.min(100, base + agentBonus + modelBonus);
  }

  for (let ai = 0; ai < insertedAgents.length; ai++) {
    for (let mi = 0; mi < insertedModels.length; mi++) {
      for (let si = 0; si < insertedScenarios.length; si++) {
        const score = seededScore(ai, mi, si);
        const total = 5 + (si % 6);  // 5-10 tests per scenario, deterministic
        const passed = Math.round(total * score / 100);

        resultRows.push({
          runId: run1.id,
          agentId: insertedAgents[ai].id,
          modelId: insertedModels[mi].id,
          scenarioId: insertedScenarios[si].id,
          agentVersion: insertedAgents[ai].version,
          scenarioVersion: 'v1',
          status: score > 25 ? ('completed' as const) : ('failed' as const),
          testsPassed: passed,
          testsTotal: total,
          totalScore: score,
          durationSeconds: 30 + ((ai * 100 + mi * 40 + si * 20) % 270),
        });
      }
    }
  }

  await db.insert(runResults).values(resultRows);

  // ─── Refresh materialized views ─────────────────────────────
  await client`REFRESH MATERIALIZED VIEW latest_results`;
  await client`REFRESH MATERIALIZED VIEW score_by_model`;
  await client`REFRESH MATERIALIZED VIEW score_by_agent`;

  const summary = `Seeded: ${insertedAgents.length} agents, ${insertedModels.length} models, ${insertedScenarios.length} scenarios, ${resultRows.length} results`;
  console.log(summary);
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

import { sql } from '@/db';
import { refreshMatviews } from '@/lib/db/refresh-matviews';
import { env } from '@/lib/env';
import { DockerExecutor } from './docker-executor';

const STALE_ERROR_MESSAGE = 'Process terminated unexpectedly';

export async function startupCleanup(): Promise<void> {
  const executor = new DockerExecutor(env.DOCKER_HOST);

  const cleaned = await executor.cleanupOrphans();
  if (cleaned > 0) {
    console.log(`[startup] Cleaned ${cleaned} orphaned agent containers`);
  }

  await sql.unsafe(`
    INSERT INTO run_results (
      run_id,
      agent_id,
      model_id,
      scenario_id,
      status,
      tests_passed,
      tests_total,
      total_score,
      duration_seconds,
      attempt,
      max_attempts,
      error_message
    )
    SELECT
      rt.run_id,
      ae.agent_id,
      rt.model_id,
      rt.scenario_id,
      'error',
      0,
      0,
      0,
      0,
      1,
      1,
      '${STALE_ERROR_MESSAGE}'
    FROM run_tasks rt
    JOIN agent_executors ae ON ae.id = rt.agent_executor_id
    WHERE rt.status = 'running'
    ON CONFLICT (run_id, agent_id, model_id, scenario_id) DO NOTHING
  `);

  const staleTasks = await sql.unsafe(`
    UPDATE run_tasks
    SET status = 'error',
        error_message = '${STALE_ERROR_MESSAGE}',
        finished_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `) as Array<{ id: string }>;

  if (staleTasks.length > 0) {
    console.log(`[startup] Marked ${staleTasks.length} stale running tasks as error`);
  }

  await sql.unsafe(`
    UPDATE runs
    SET status = 'failed',
        finished_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `);

  await refreshMatviews({
    warn: (message) => console.warn(message),
  });
}

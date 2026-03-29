import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { runs, runTasks } from '@/db/schema';
import { DockerExecutor } from './docker-executor';
import { env } from '@/lib/env';

export async function startupCleanup(): Promise<void> {
  const executor = new DockerExecutor(env.DOCKER_HOST);

  const cleaned = await executor.cleanupOrphans();
  if (cleaned > 0) {
    console.log(`[startup] Cleaned ${cleaned} orphaned agent containers`);
  }

  const staleTasks = await db
    .update(runTasks)
    .set({ status: 'error', errorMessage: 'Process terminated unexpectedly', finishedAt: new Date() })
    .where(inArray(runTasks.status, ['running']))
    .returning();

  if (staleTasks.length > 0) {
    console.log(`[startup] Marked ${staleTasks.length} stale running tasks as error`);
  }

  await db
    .update(runs)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(eq(runs.status, 'running'));
}

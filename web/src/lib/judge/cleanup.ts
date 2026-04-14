import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { settingsDefaults } from './types';

async function getSetting<T>(key: string): Promise<T> {
  const { settings } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

/**
 * One-shot cleanup: remove stale verdicts and truncate old rawResponse.
 */
export async function cleanupStaleVerdicts(): Promise<void> {
  // 1. Clean stale verdicts
  await db.execute(sql`
    DELETE FROM judge_verdicts jv
    USING run_results rr
    WHERE jv.run_result_id = rr.id
      AND jv.evaluation_version < rr.evaluation_version
  `);

  // 2. Clean stale compression_logs
  await db.execute(sql`
    DELETE FROM compression_logs cl
    USING run_results rr
    WHERE cl.run_result_id = rr.id
      AND cl.evaluation_version < rr.evaluation_version
  `);

  // 3. Truncate old rawResponse
  const retentionDays = await getSetting<number>('judge_raw_response_retention_days');
  await db.execute(sql`
    UPDATE judge_verdicts
    SET raw_response = NULL
    WHERE raw_response IS NOT NULL
      AND created_at < NOW() - make_interval(days => ${retentionDays})
  `);
}

/**
 * Start periodic cleanup job.
 */
export function startCleanupJob(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await cleanupStaleVerdicts();
    } catch (err) {
      console.error('[CleanupJob] Error:', err);
    }
  }, 3600000); // 1 hour
}

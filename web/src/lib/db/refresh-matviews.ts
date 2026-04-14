import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { getPublisher } from '@/lib/events/redis-client';

const LOCK_KEY = 'litmus:matview-refresh-lock';
const REFRESH_NEEDED_KEY = 'litmus:matview-refresh-needed';
const LOCK_TTL = 60;
const POLL_INTERVAL = 30000;

const VIEWS = ['latest_results', 'score_by_model', 'score_by_agent'] as const;

async function refreshAllViews(
  logger: Pick<typeof console, 'warn'> = console,
): Promise<void> {
  for (const view of VIEWS) {
    try {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const needsFallback =
        /concurrently/i.test(message) ||
        /has not been populated/i.test(message);
      if (!needsFallback) throw reason;
      logger.warn(`[matviews] concurrent refresh unavailable for ${view}; retrying without CONCURRENTLY`);
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
    }
  }
}

/**
 * Start the debounced matview refresh worker.
 */
export function startMatviewRefreshWorker(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const redis = getPublisher();
      const needed = await redis.get(REFRESH_NEEDED_KEY);
      if (!needed) return;

      const acquired = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL, 'NX');
      if (!acquired) return;

      await redis.del(REFRESH_NEEDED_KEY);

      try {
        await refreshAllViews();
      } finally {
        await redis.del(LOCK_KEY);
      }
    } catch (err) {
      console.error('[MatviewRefresh] Error:', err);
    }
  }, POLL_INTERVAL);
}

/**
 * Trigger a debounced refresh by setting the flag in Redis.
 */
export async function requestMatviewRefresh(): Promise<void> {
  const redis = getPublisher();
  await redis.set(REFRESH_NEEDED_KEY, '1');
}

/**
 * Try to acquire lock and refresh. Returns true if refresh was performed.
 * Exported for testing.
 */
export async function tryRefreshMatviews(): Promise<boolean> {
  const redis = getPublisher();
  const acquired = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL, 'NX');
  if (!acquired) return false;
  await redis.del(REFRESH_NEEDED_KEY);
  try {
    await refreshAllViews();
  } finally {
    await redis.del(LOCK_KEY);
  }
  return true;
}

/**
 * Direct refresh (no lock) — backward compat for scheduler.ts and startup.ts.
 */
export async function refreshMatviews(
  logger: Pick<typeof console, 'warn'> = console,
): Promise<void> {
  await refreshAllViews(logger);
}

import { db } from '@/db';
import { judgeVerdicts } from '@/db/schema';
import { getPublisher } from '@/lib/events/redis-client';
import { settingsDefaults } from './types';
import type { JudgeTaskPayload } from './types';

const STREAM_KEY = 'litmus:judge:tasks';
const GROUP_NAME = 'judge-workers';
const DEAD_LETTER_KEY = 'litmus:judge:dead-letter';
const MAX_DELIVERY_ATTEMPTS = 3;

async function getSetting<T>(key: string): Promise<T> {
  const { settings } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return (rows[0]?.value ?? settingsDefaults[key]) as T;
}

/**
 * One-shot reclaim: claim idle messages via XAUTOCLAIM.
 * Messages that exceed MAX_DELIVERY_ATTEMPTS go to dead-letter + error verdict.
 * Returns count of reclaimed messages.
 */
export async function reclaimStaleTasks(consumerId: string): Promise<number> {
  const redis = getPublisher();
  const idleTimeoutMs = await getSetting<number>('judge_task_idle_timeout_ms');

  const result = await redis.xautoclaim(
    STREAM_KEY,
    GROUP_NAME,
    consumerId,
    idleTimeoutMs,
    '0-0'
  );

  if (!result || !result[1]) return 0;
  const claimedMessages = result[1] as [string, string[]][];

  for (const [messageId, fields] of claimedMessages) {
    const payloadIdx = fields.indexOf('payload');
    const payloadStr = payloadIdx >= 0 ? fields[payloadIdx + 1] : null;
    if (!payloadStr) continue;

    // Check delivery count via XPENDING
    const pendingInfo = await redis.xpending(
      STREAM_KEY,
      GROUP_NAME,
      messageId,
      messageId,
      1
    );

    const deliveryCount = (pendingInfo as unknown[])?.[0] != null
      ? ((pendingInfo as unknown[][])[0]?.[3] as number ?? 0)
      : 0;

    if (deliveryCount > MAX_DELIVERY_ATTEMPTS) {
      // Move to dead-letter
      await redis.xadd(DEAD_LETTER_KEY, '*', 'payload', payloadStr, 'reason', 'max_delivery_exceeded');
      await redis.xack(STREAM_KEY, GROUP_NAME, messageId);

      // Write error verdict
      const payload: JudgeTaskPayload = JSON.parse(payloadStr);
      await db.insert(judgeVerdicts).values({
        runResultId: payload.runResultId,
        judgeProviderId: payload.providerId,
        scores: {},
        blockingFlags: {},
        error: 'max delivery attempts exceeded',
        evaluationVersion: payload.evaluationVersion,
      }).onConflictDoNothing();

      // Trigger aggregation check
      const { runAggregation } = await import('./aggregation-runner');
      await runAggregation(payload.runResultId, payload.evaluationVersion);
    }
  }

  return claimedMessages.length;
}

/**
 * Start periodic XAUTOCLAIM reclaim loop.
 */
export function startReclaimLoop(consumerId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await reclaimStaleTasks(consumerId);
    } catch (err) {
      console.error('[ReclaimLoop] Error:', err);
    }
  }, 60000);
}

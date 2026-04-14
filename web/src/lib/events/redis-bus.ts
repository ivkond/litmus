import { getPublisher, getSubscriber } from './redis-client';

const CHANNEL = 'litmus:events';

export interface RedisEvent {
  type: string;
  [key: string]: unknown;
}

type EventHandler = (event: RedisEvent) => void;

const localHandlers = new Map<string, Set<EventHandler>>();

let subscribed = false;

async function ensureSubscribed(): Promise<void> {
  if (subscribed) return;
  const sub = getSubscriber();
  await sub.subscribe(CHANNEL);
  sub.on('message', (_channel: string, message: string) => {
    try {
      const event: RedisEvent = JSON.parse(message);
      // Broadcast to all local handlers
      for (const handlers of localHandlers.values()) {
        for (const handler of handlers) {
          handler(event);
        }
      }
    } catch {
      // ignore malformed messages
    }
  });
  subscribed = true;
}

/**
 * Publish an event to Redis Pub/Sub channel.
 * Fire-and-forget — acceptable to lose (UI optimization only).
 */
export async function publishEvent(event: RedisEvent): Promise<void> {
  const pub = getPublisher();
  await pub.publish(CHANNEL, JSON.stringify(event));
}

/**
 * Subscribe to events with a filter key (e.g., runId).
 * Returns an unsubscribe function.
 */
export function subscribe(
  filterKey: string,
  handler: EventHandler
): () => void {
  void ensureSubscribed().catch((err: unknown) => {
    console.error('[RedisBus] Subscribe failed:', err);
  });
  if (!localHandlers.has(filterKey)) {
    localHandlers.set(filterKey, new Set());
  }
  localHandlers.get(filterKey)!.add(handler);
  return () => {
    localHandlers.get(filterKey)?.delete(handler);
    if (localHandlers.get(filterKey)?.size === 0) {
      localHandlers.delete(filterKey);
    }
  };
}

/**
 * Subscribe to ALL events (no filter). Used by SSE endpoints.
 */
export function subscribeAll(handler: EventHandler): () => void {
  return subscribe('__all__', handler);
}

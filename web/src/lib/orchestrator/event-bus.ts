// EventBus interface + InMemoryEventBus for tests.
// Redis-backed singleton is lazy-loaded via getRedisEventBus() to avoid
// eager env/Redis imports that break unit tests.

import type { RunEvent } from './types';

type EventHandler = (event: RunEvent) => void;

/** Interface for event bus — consumed by Scheduler via DI */
export interface EventBus {
  subscribe(runId: string, handler: EventHandler): () => void;
  emit(runId: string, event: RunEvent): void;
}

/** In-memory implementation — for unit tests (no Redis needed) */
export class InMemoryEventBus implements EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  subscribe(runId: string, handler: EventHandler): () => void {
    if (!this.listeners.has(runId)) {
      this.listeners.set(runId, new Set());
    }
    this.listeners.get(runId)!.add(handler);

    return () => {
      const set = this.listeners.get(runId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.listeners.delete(runId);
      }
    };
  }

  emit(runId: string, event: RunEvent): void {
    const set = this.listeners.get(runId);
    if (set) {
      for (const handler of set) handler(event);
    }
  }
}

/** Lazy singleton — only imports Redis when first accessed */
let _redisEventBus: EventBus | null = null;

export function getRedisEventBus(): EventBus {
  if (!_redisEventBus) {
    // Dynamic import at call time, not at module parse time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { publishEvent, subscribe: redisSubscribe } = require('@/lib/events/redis-bus');
    _redisEventBus = {
      subscribe(runId: string, handler: EventHandler): () => void {
        return redisSubscribe(runId, (event: Record<string, unknown>) => {
          if ('runId' in event && event.runId === runId) {
            handler(event as unknown as RunEvent);
          }
        });
      },
      emit(runId: string, event: RunEvent): void {
        publishEvent({ ...event, runId } as Record<string, unknown>).catch(
          (err: Error) => console.error('[EventBus] publish failed:', err)
        );
      },
    };
  }
  return _redisEventBus;
}

/**
 * Production singleton — lazy accessor.
 * Use `runEventBus` in production code; `InMemoryEventBus` in tests.
 */
export const runEventBus: EventBus = new Proxy({} as EventBus, {
  get(_target, prop: string) {
    const real = getRedisEventBus();
    return (real as unknown as Record<string, unknown>)[prop];
  },
});

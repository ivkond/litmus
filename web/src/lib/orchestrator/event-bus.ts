import type { RunEvent } from './types';

type EventHandler = (event: RunEvent) => void;

export class RunEventBus {
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
      for (const handler of set) {
        handler(event);
      }
    }
  }
}

// Singleton for the process — sufficient for single-instance deployment
export const runEventBus = new RunEventBus();

import { describe, it, expect, vi } from 'vitest';
import { RunEventBus } from '../event-bus';
import type { TaskStartedEvent, RunCompletedEvent } from '../types';

describe('RunEventBus', () => {
  it('delivers events to subscribers of a specific run', () => {
    const bus = new RunEventBus();
    const handler = vi.fn();

    bus.subscribe('run-1', handler);

    const event: TaskStartedEvent = {
      type: 'task:started',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'mock',
      model: 'gpt-4o',
      scenario: 'trivial',
      attempt: 1,
      maxAttempts: 3,
      timestamp: new Date().toISOString(),
    };

    bus.emit('run-1', event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not deliver events to subscribers of other runs', () => {
    const bus = new RunEventBus();
    const handler = vi.fn();

    bus.subscribe('run-2', handler);

    bus.emit('run-1', {
      type: 'task:started',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'mock',
      model: 'gpt-4o',
      scenario: 'trivial',
      attempt: 1,
      maxAttempts: 3,
      timestamp: new Date().toISOString(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new RunEventBus();
    const handler = vi.fn();

    const unsub = bus.subscribe('run-1', handler);
    unsub();

    bus.emit('run-1', {
      type: 'run:completed',
      runId: 'run-1',
      totalTasks: 1,
      completedTasks: 1,
      failedTasks: 0,
      errorTasks: 0,
      cancelledTasks: 0,
    } satisfies RunCompletedEvent);

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers for the same run', () => {
    const bus = new RunEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.subscribe('run-1', h1);
    bus.subscribe('run-1', h2);

    bus.emit('run-1', {
      type: 'task:started',
      runId: 'run-1',
      taskId: 't',
      agent: 'a',
      model: 'm',
      scenario: 's',
      attempt: 1,
      maxAttempts: 1,
      timestamp: new Date().toISOString(),
    });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});

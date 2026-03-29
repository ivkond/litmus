import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSubscribe = vi.fn();
const mockOn = vi.fn();

vi.mock('@/lib/events/redis-client', () => ({
  getPublisher: vi.fn(),
  getSubscriber: vi.fn(() => ({
    subscribe: mockSubscribe,
    on: mockOn,
  })),
}));

describe('redis-bus subscribe', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('test_subscribe_when_redis_subscribe_fails_no_unhandled_rejection', async () => {
    const subscribeError = new Error('redis unavailable');
    mockSubscribe.mockRejectedValueOnce(subscribeError);

    const unhandledRejections: unknown[] = [];
    const unhandledListener = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', unhandledListener);

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const { subscribe } = await import('../redis-bus');
      const unsubscribe = subscribe('run-1', vi.fn());

      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[RedisBus] Subscribe failed:',
        subscribeError
      );

      unsubscribe();
    } finally {
      process.off('unhandledRejection', unhandledListener);
      consoleErrorSpy.mockRestore();
    }
  });
});

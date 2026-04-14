import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = process.env;

function removeRequiredEnv(): void {
  delete process.env.DATABASE_URL;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
}

describe('env lazy resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    removeRequiredEnv();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('test_env_when_required_missing_and_module_imported_then_does_not_throw', async () => {
    await expect(import('@/lib/env')).resolves.toBeDefined();
  });

  it('test_env_when_required_missing_and_property_accessed_then_throws', async () => {
    const { env } = await import('@/lib/env');
    expect(() => env.DATABASE_URL).toThrow('[env] DATABASE_URL:');
  });

  it('test_env_when_redis_url_missing_then_default_is_used', async () => {
    delete process.env.REDIS_URL;
    const { env } = await import('@/lib/env');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });
});

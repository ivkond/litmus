import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startupCleanup } from '../startup';

const sqlUnsafeMock = vi.hoisted(() => vi.fn());
const cleanupOrphansMock = vi.hoisted(() => vi.fn());
const refreshMatviewsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/db', () => ({
  sql: {
    unsafe: sqlUnsafeMock,
  },
}));

vi.mock('../docker-executor', () => ({
  DockerExecutor: vi.fn().mockImplementation(function DockerExecutorMock() {
    return {
      cleanupOrphans: cleanupOrphansMock,
    };
  }),
}));

vi.mock('@/lib/db/refresh-matviews', () => ({
  refreshMatviews: refreshMatviewsMock,
}));

vi.mock('@/lib/env', () => ({
  env: {
    DOCKER_HOST: 'tcp://docker:2375',
  },
}));

describe('startupCleanup', () => {
  beforeEach(() => {
    sqlUnsafeMock.mockReset();
    cleanupOrphansMock.mockReset();
    refreshMatviewsMock.mockClear();
  });

  it('synthesizes stale error rows, marks stale tasks/runs, and refreshes matviews', async () => {
    cleanupOrphansMock.mockResolvedValue(2);
    sqlUnsafeMock.mockImplementation(async (query: string) => {
      if (query.includes('UPDATE run_tasks')) {
        return [{ id: 'task-1' }, { id: 'task-2' }];
      }
      if (query.includes('UPDATE runs')) {
        return [{ id: 'run-1' }];
      }
      return [];
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await startupCleanup();

    expect(sqlUnsafeMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO run_results'));
    expect(sqlUnsafeMock).toHaveBeenCalledWith(expect.stringContaining('UPDATE run_tasks'));
    expect(sqlUnsafeMock).toHaveBeenCalledWith(expect.stringContaining('UPDATE runs'));
    expect(refreshMatviewsMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[startup] Cleaned 2 orphaned agent containers');
    expect(logSpy).toHaveBeenCalledWith('[startup] Marked 2 stale running tasks as error');

    logSpy.mockRestore();
  });
});

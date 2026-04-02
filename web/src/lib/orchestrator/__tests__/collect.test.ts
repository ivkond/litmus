import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { collect } from '../collect';
import type { AgentExecutor, ExecutorHandle, InteractiveHandle } from '../types';

function createMockInteractiveHandle(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}): InteractiveHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = opts.exitCode ?? 0;

  if (!opts.hang) {
    process.nextTick(() => {
      if (opts.stdout) stdout.write(opts.stdout);
      if (opts.stderr) stderr.write(opts.stderr);
      stdout.end();
      stderr.end();
    });
  }

  return {
    stdin,
    stdout,
    stderr,
    wait: vi.fn().mockImplementation(async () => {
      if (opts.hang) return new Promise(() => {}); // never resolves
      await new Promise<void>((resolve) => stdout.on('end', resolve));
      return exitCode;
    }),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExecutor(handle: InteractiveHandle): AgentExecutor {
  return {
    type: 'docker',
    start: vi.fn(),
    exec: vi.fn().mockResolvedValue(handle),
    stop: vi.fn(),
    healthCheck: vi.fn(),
  };
}

describe('collect', () => {
  it('collects stdout and stderr into ExecResult', async () => {
    const ih = createMockInteractiveHandle({ exitCode: 0, stdout: 'hello', stderr: 'warn' });
    const executor = createMockExecutor(ih);
    const handle = { containerId: 'c1' } as ExecutorHandle;

    const result = await collect(executor, handle, ['echo', 'hello']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('warn');
    expect(executor.exec).toHaveBeenCalledWith(handle, ['echo', 'hello'], undefined);
  });

  it('closes stdin immediately (one-shot command)', async () => {
    const ih = createMockInteractiveHandle({ exitCode: 0, stdout: '' });
    const executor = createMockExecutor(ih);
    const handle = { containerId: 'c1' } as ExecutorHandle;

    await collect(executor, handle, ['ls']);

    expect((ih.stdin as PassThrough).destroyed || (ih.stdin as PassThrough).writableEnded).toBe(true);
  });

  it('passes ExecOptions through to executor.exec', async () => {
    const ih = createMockInteractiveHandle({ exitCode: 0, stdout: '' });
    const executor = createMockExecutor(ih);
    const handle = { containerId: 'c1' } as ExecutorHandle;

    await collect(executor, handle, ['run'], { env: { FOO: 'bar' }, timeoutMs: 5000 });

    expect(executor.exec).toHaveBeenCalledWith(handle, ['run'], { env: { FOO: 'bar' }, timeoutMs: 5000 });
  });

  it('returns exitCode 124 and kills process on timeout', async () => {
    const ih = createMockInteractiveHandle({ hang: true });
    const executor = createMockExecutor(ih);
    const handle = { containerId: 'c1' } as ExecutorHandle;

    const result = await collect(executor, handle, ['sleep', '999'], { timeoutMs: 50 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
    expect(ih.kill).toHaveBeenCalled();
  });

  it('returns non-zero exit code from failed command', async () => {
    const ih = createMockInteractiveHandle({ exitCode: 2, stdout: '', stderr: 'infra failure' });
    const executor = createMockExecutor(ih);
    const handle = { containerId: 'c1' } as ExecutorHandle;

    const result = await collect(executor, handle, ['init.sh']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('infra failure');
  });
});

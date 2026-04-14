import type { AgentExecutor, ExecutorHandle, ExecOptions, ExecResult } from './types';

/**
 * Run a one-shot command via the executor and collect stdout/stderr into an ExecResult.
 * Used for init.sh, test scripts, models.sh — anything that doesn't need bidirectional IO.
 */
export async function collect(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  cmd: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const ih = await executor.exec(handle, cmd, options);

  // One-shot: no input needed
  ih.stdin.end();

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  ih.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  ih.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const timeoutMs = options?.timeoutMs;

  if (timeoutMs && timeoutMs > 0) {
    const result = await Promise.race([
      ih.wait().then((exitCode) => ({ type: 'done' as const, exitCode })),
      new Promise<{ type: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ type: 'timeout' }), timeoutMs),
      ),
    ]);

    if (result.type === 'timeout') {
      await ih.kill();
      return {
        exitCode: 124,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: `Command timed out after ${timeoutMs}ms`,
      };
    }

    return {
      exitCode: result.exitCode,
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    };
  }

  const exitCode = await ih.wait();
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf-8'),
    stderr: Buffer.concat(stderr).toString('utf-8'),
  };
}

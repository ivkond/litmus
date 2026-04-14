import type { AgentExecutor, ExecutorHandle, ExecOptions } from './types';
import { collect } from './collect';

export function validateTarPaths(paths: string[]): void {
  for (const p of paths) {
    if (p.startsWith('/')) {
      throw new Error(`Credential path must not be absolute: "${p}"`);
    }
    const segments = p.split('/');
    if (segments.some((s) => s === '..')) {
      throw new Error(`Credential path contains directory traversal: "${p}"`);
    }
  }
}

function validateTarContents(base64Tar: string, allowedPaths: string[]): void {
  const binaryData = Buffer.from(base64Tar, 'base64');
  const tarStr = binaryData.toString('binary');

  const allowedSet = new Set(allowedPaths);
  const lines = tarStr.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;

    const name = parts.slice(5).join(' ').replace(/->.*$/, '').replace(/\/+$/, '');

    if (!name) continue;
    if (name.startsWith('/')) {
      throw new Error(`Tar contains absolute path: "${name}"`);
    }
    if (name.includes('..')) {
      throw new Error(`Tar contains path traversal: "${name}"`);
    }

    const isAllowed = allowedSet.has(name) || allowedSet.has(name.replace(/^\.\//, ''));
    if (!isAllowed && name !== '.' && name !== '') {
      throw new Error(`Tar contains unexpected path: "${name}"`);
    }
  }
}

export async function extractCredentials(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  paths: string[],
  options?: ExecOptions,
): Promise<string> {
  validateTarPaths(paths);

  const result = await collect(
    executor,
    handle,
    ['tar', 'czf', '-', '-C', '/root', ...paths],
    options,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `credential extraction failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  return Buffer.from(result.stdout, 'binary').toString('base64');
}

export async function restoreCredentialFiles(
  executor: AgentExecutor,
  handle: ExecutorHandle,
  blobs: Array<{ acpMethodId: string; base64Tar: string; credentialPaths: string[] }>,
  options?: ExecOptions,
): Promise<void> {
  for (const blob of blobs) {
    validateTarPaths(blob.credentialPaths);

    validateTarContents(blob.base64Tar, blob.credentialPaths);

    const ih = await executor.exec(
      handle,
      ['tar', 'xzf', '-', '-C', '/root', '--no-absolute-names', '--no-same-owner'],
      options,
    );

    const binaryData = Buffer.from(blob.base64Tar, 'base64');

    ih.stdin.write(binaryData);
    ih.stdin.end();

    const exitCode = await ih.wait();

    if (exitCode !== 0) {
      throw new Error(
        `Failed to restore credentials for method "${blob.acpMethodId}" (tar exit ${exitCode})`,
      );
    }
  }
}
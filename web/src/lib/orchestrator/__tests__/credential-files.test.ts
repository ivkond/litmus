import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorHandle, InteractiveHandle } from '../types';

const collectMock = vi.hoisted(() => vi.fn());
vi.mock('../collect', () => ({ collect: collectMock }));

describe('validateTarPaths', () => {
  it('test_validateTarPaths_relativePaths_passes', async () => {
    const { validateTarPaths } = await import('../credential-files');
    validateTarPaths(['.config/cursor/auth.json', '.config/cursor/session.json']);
  });

  it('test_validateTarPaths_absolutePath_throws', async () => {
    const { validateTarPaths } = await import('../credential-files');
    expect(() => validateTarPaths(['/etc/passwd'])).toThrow('absolute');
  });

  it('test_validateTarPaths_parentTraversal_throws', async () => {
    const { validateTarPaths } = await import('../credential-files');
    expect(() => validateTarPaths(['.config/../../../etc/passwd'])).toThrow('traversal');
  });

  it('test_validateTarPaths_emptyArray_passes', async () => {
    const { validateTarPaths } = await import('../credential-files');
    validateTarPaths([]);
  });
});

describe('extractCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_extractCredentials_validPaths_returnsBase64', async () => {
    const rawTar = Buffer.from('testdata');
    collectMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: rawTar.toString('binary'),
      stderr: '',
    });

    const { extractCredentials } = await import('../credential-files');

    const mockExecutor = {
      type: 'docker' as const,
      exec: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };
    const mockHandle = { containerId: 'c1' };

    const result = await extractCredentials(
      mockExecutor,
      mockHandle,
      ['.config/cursor/auth.json'],
      undefined,
    );

    expect(result).toBe(rawTar.toString('base64'));
    expect(collectMock).toHaveBeenCalledWith(
      mockExecutor,
      mockHandle,
      ['tar', 'czf', '-', '-C', '/root', '.config/cursor/auth.json'],
      undefined,
    );
  });

  it('test_extractCredentials_tarFails_throws', async () => {
    collectMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'tar: .config/cursor/auth.json: No such file',
    });

    const { extractCredentials } = await import('../credential-files');

    const mockExecutor = {
      type: 'docker' as const,
      exec: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };
    const mockHandle = { containerId: 'c1' };

    await expect(
      extractCredentials(mockExecutor, mockHandle, ['.config/cursor/auth.json']),
    ).rejects.toThrow('credential extraction failed');
  });
});

describe('restoreCredentialFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_restoreCredentialFiles_validBlob_pipesToTar', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writtenChunks: Buffer[] = [];

    stdin.on('data', (chunk: Buffer) => writtenChunks.push(chunk));

    const mockHandle: InteractiveHandle = {
      stdin,
      stdout,
      stderr,
      wait: vi.fn().mockResolvedValue(0),
      kill: vi.fn(),
    };

    const mockExecutor: AgentExecutor = {
      type: 'docker',
      exec: vi.fn().mockResolvedValue(mockHandle),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };

    const execHandle: ExecutorHandle = { containerId: 'c1' };
    const base64Tar = Buffer.from('test-tar-data').toString('base64');

    const { restoreCredentialFiles } = await import('../credential-files');

    process.nextTick(() => {
      stdout.end();
      stderr.end();
    });

    await restoreCredentialFiles(mockExecutor, execHandle, [
      {
        acpMethodId: 'cursor-oauth',
        base64Tar,
        credentialPaths: ['.config/cursor/auth.json'],
      },
    ]);

    expect(mockExecutor.exec).toHaveBeenCalledWith(
      execHandle,
      ['tar', 'xzf', '-', '-C', '/root', '--no-absolute-names', '--no-same-owner'],
      undefined,
    );

    const written = Buffer.concat(writtenChunks);
    expect(written.length).toBeGreaterThan(0);
    expect(written).toEqual(Buffer.from(base64Tar, 'base64'));
  });

  it('test_restoreCredentialFiles_nonZeroExit_throws', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const mockHandle: InteractiveHandle = {
      stdin,
      stdout,
      stderr,
      wait: vi.fn().mockResolvedValue(2),
      kill: vi.fn(),
    };

    const mockExecutor: AgentExecutor = {
      type: 'docker',
      exec: vi.fn().mockResolvedValue(mockHandle),
      start: vi.fn(),
      stop: vi.fn(),
      healthCheck: vi.fn(),
    };

    const execHandle: ExecutorHandle = { containerId: 'c1' };
    const base64Tar = Buffer.from('test-tar-data').toString('base64');

    process.nextTick(() => { stdout.end(); stderr.end(); });

    const { restoreCredentialFiles } = await import('../credential-files');

    await expect(
      restoreCredentialFiles(mockExecutor, execHandle, [
        { acpMethodId: 'cursor-oauth', base64Tar, credentialPaths: ['.config/cursor/auth.json'] },
      ]),
    ).rejects.toThrow(/Failed to restore credentials/);
  });
});
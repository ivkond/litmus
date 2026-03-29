import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { DockerExecutor } from '../docker-executor';
import type { ExecutorConfig } from '../types';

// Mock dockerode
const mockContainer = {
  id: 'container-123',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  exec: vi.fn(),
  modem: { demuxStream: vi.fn() },
};

const mockDocker = {
  createContainer: vi.fn().mockResolvedValue(mockContainer),
  ping: vi.fn().mockResolvedValue('OK'),
  listContainers: vi.fn().mockResolvedValue([]),
};

vi.mock('dockerode', () => ({
  default: function MockDockerode() {
    return mockDocker;
  },
}));

describe('DockerExecutor', () => {
  let executor: DockerExecutor;
  const baseConfig: ExecutorConfig = {
    image: 'litmus/runtime-python',
    agentHostDir: '/host/agents/mock',
    workHostDir: '/host/work',
    runId: 'run-1',
    env: { CURSOR_API_KEY: 'test-key' },
    labels: { 'litmus.custom': 'true' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new DockerExecutor('tcp://localhost:2375');
  });

  it('creates a container with correct config on start()', async () => {
    const handle = await executor.start(baseConfig);

    expect(handle.containerId).toBe('container-123');
    expect(mockDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'litmus/runtime-python',
        Cmd: ['sleep', 'infinity'],
        Labels: expect.objectContaining({
          'litmus.managed': 'true',
          'litmus.run-id': 'run-1',
          'litmus.custom': 'true',
        }),
      }),
    );
    expect(mockContainer.start).toHaveBeenCalled();
  });

  it('passes bind mounts for agent scripts and work directory', async () => {
    await executor.start(baseConfig);

    const createCall = mockDocker.createContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Binds).toEqual([
      '/host/agents/mock:/opt/agent:ro',
      '/host/work:/work',
    ]);
  });

  it('applies memory and CPU limits', async () => {
    await executor.start({ ...baseConfig, limits: { memory: 2, cpus: 1 } });

    const createCall = mockDocker.createContainer.mock.calls[0][0];
    expect(createCall.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(createCall.HostConfig.NanoCpus).toBe(1e9);
  });

  it('stops and removes container on stop()', async () => {
    const handle = await executor.start(baseConfig);
    await executor.stop(handle);

    expect(mockContainer.stop).toHaveBeenCalled();
    expect(mockContainer.remove).toHaveBeenCalled();
  });

  it('returns true from healthCheck() when Docker responds', async () => {
    const healthy = await executor.healthCheck();
    expect(healthy).toBe(true);
  });

  it('returns false from healthCheck() when Docker is unreachable', async () => {
    mockDocker.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const healthy = await executor.healthCheck();
    expect(healthy).toBe(false);
  });
});

describe('DockerExecutor - command execution', () => {
  let dockerExecutor: DockerExecutor;

  function setupCommandMock(opts: { exitCode?: number; stdout?: string; stderr?: string; hang?: boolean }) {
    const mockStream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    mockStream.destroy = vi.fn();

    const mockDockerExec = {
      start: vi.fn().mockResolvedValue(mockStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: opts.exitCode ?? 0 }),
    };
    mockContainer.exec.mockResolvedValue(mockDockerExec);

    // demuxStream: push data to stdout/stderr PassThrough, then emit 'end'
    mockContainer.modem.demuxStream.mockImplementation(
      (_stream: unknown, outStream: NodeJS.WritableStream, errStream: NodeJS.WritableStream) => {
        if (!opts.hang) {
          process.nextTick(() => {
            if (opts.stdout) outStream.write(Buffer.from(opts.stdout));
            if (opts.stderr) errStream.write(Buffer.from(opts.stderr));
            process.nextTick(() => mockStream.emit('end'));
          });
        }
      },
    );

    return { mockStream, mockDockerExec };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dockerExecutor = new DockerExecutor('tcp://localhost:2375');
  });

  it('runs a command and returns stdout, stderr, and exitCode', async () => {
    setupCommandMock({ exitCode: 0, stdout: 'hello world', stderr: '' });

    const handle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const result = await dockerExecutor.exec(handle, ['echo', 'hello']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(mockContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({ Cmd: ['echo', 'hello'], AttachStdout: true, AttachStderr: true }),
    );
  });

  it('returns non-zero exitCode from a failed command', async () => {
    setupCommandMock({ exitCode: 1, stdout: '', stderr: 'error msg' });

    const handle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const result = await dockerExecutor.exec(handle, ['false']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error msg');
  });

  it('passes env vars to the docker exec call', async () => {
    setupCommandMock({ exitCode: 0, stdout: '', stderr: '' });

    const handle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    await dockerExecutor.exec(handle, ['run.sh'], { env: { FOO: 'bar' } });

    expect(mockContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({ Env: ['FOO=bar'] }),
    );
  });

  it('returns exit 124 and destroys stream on timeout', async () => {
    const { mockStream } = setupCommandMock({ hang: true });

    // Also mock the kill command for cleanup
    const killStream = new EventEmitter();
    const mockKillDockerExec = { start: vi.fn().mockResolvedValue(killStream) };
    mockContainer.exec.mockResolvedValueOnce({
      start: vi.fn().mockResolvedValue(mockStream),
      inspect: vi.fn(),
    }).mockResolvedValueOnce(mockKillDockerExec);

    // End the kill stream immediately
    setTimeout(() => killStream.emit('end'), 10);

    const handle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const result = await dockerExecutor.exec(handle, ['sleep', '999'], { timeoutMs: 50 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
    expect(mockStream.destroy).toHaveBeenCalled();
  });

  it('cleans up orphan containers on cleanupOrphans()', async () => {
    const mockOrphan = {
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockDocker.listContainers.mockResolvedValueOnce([{ Id: 'orphan-1' }]);
    (mockDocker as Record<string, unknown>).getContainer = vi.fn().mockReturnValue(mockOrphan);

    const count = await dockerExecutor.cleanupOrphans();
    expect(count).toBe(1);
    expect(mockOrphan.stop).toHaveBeenCalled();
    expect(mockOrphan.remove).toHaveBeenCalled();
  });
});

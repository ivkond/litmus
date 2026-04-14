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

describe('DockerExecutor - exec returns InteractiveHandle', () => {
  let dockerExecutor: DockerExecutor;

  function setupExecMock(opts: { exitCode?: number; stdout?: string; stderr?: string }) {
    const mockStream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    mockStream.destroy = vi.fn();
    mockStream.write = vi.fn();

    const mockDockerExec = {
      start: vi.fn().mockResolvedValue(mockStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: opts.exitCode ?? 0 }),
    };
    mockContainer.exec.mockResolvedValue(mockDockerExec);

    mockContainer.modem.demuxStream.mockImplementation(
      (_stream: unknown, outStream: NodeJS.WritableStream, errStream: NodeJS.WritableStream) => {
        process.nextTick(() => {
          if (opts.stdout) outStream.write(Buffer.from(opts.stdout));
          if (opts.stderr) errStream.write(Buffer.from(opts.stderr));
          process.nextTick(() => mockStream.emit('end'));
        });
      },
    );

    return { mockStream, mockDockerExec };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dockerExecutor = new DockerExecutor('tcp://localhost:2375');
  });

  it('returns InteractiveHandle with stdin, stdout, stderr, wait, kill', async () => {
    setupExecMock({ exitCode: 0, stdout: 'hello', stderr: '' });

    const containerHandle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const ih = await dockerExecutor.exec(containerHandle, ['echo', 'hello']);

    expect(ih).toHaveProperty('stdin');
    expect(ih).toHaveProperty('stdout');
    expect(ih).toHaveProperty('stderr');
    expect(typeof ih.wait).toBe('function');
    expect(typeof ih.kill).toBe('function');
  });

  it('stdout stream receives command output', async () => {
    setupExecMock({ exitCode: 0, stdout: 'hello world', stderr: '' });

    const containerHandle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const ih = await dockerExecutor.exec(containerHandle, ['echo', 'hello']);

    const chunks: Buffer[] = [];
    ih.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    await ih.wait();

    expect(Buffer.concat(chunks).toString('utf-8')).toBe('hello world');
  });

  it('wait() returns exit code from Docker inspect', async () => {
    setupExecMock({ exitCode: 42, stdout: '', stderr: '' });

    const containerHandle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const ih = await dockerExecutor.exec(containerHandle, ['exit', '42']);

    const exitCode = await ih.wait();
    expect(exitCode).toBe(42);
  });

  it('passes env vars to Docker exec', async () => {
    setupExecMock({ exitCode: 0, stdout: '', stderr: '' });

    const containerHandle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    await dockerExecutor.exec(containerHandle, ['run.sh'], { env: { FOO: 'bar' } });

    expect(mockContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({ Env: ['FOO=bar'] }),
    );
  });

  it('creates exec with AttachStdin for bidirectional communication', async () => {
    setupExecMock({ exitCode: 0, stdout: '', stderr: '' });

    const containerHandle = await dockerExecutor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    await dockerExecutor.exec(containerHandle, ['cat']);

    expect(mockContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      }),
    );
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

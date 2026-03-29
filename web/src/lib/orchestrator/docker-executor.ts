import Dockerode from 'dockerode';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorConfig, ExecutorHandle, ExecResult, ExecOptions } from './types';

interface ContainerHandle extends ExecutorHandle {
  container: Dockerode.Container;
}

export class DockerExecutor implements AgentExecutor {
  type = 'docker' as const;
  private docker: Dockerode;

  constructor(dockerHost: string) {
    const url = new URL(dockerHost);
    this.docker = new Dockerode({ host: url.hostname, port: Number(url.port) });
  }

  async start(config: ExecutorConfig): Promise<ContainerHandle> {
    const container = await this.docker.createContainer({
      Image: config.image,
      Cmd: ['sleep', 'infinity'],
      Env: Object.entries(config.env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        'litmus.managed': 'true',
        'litmus.run-id': config.runId,
        ...(config.labels ?? {}),
      },
      HostConfig: {
        Binds: [
          `${config.agentHostDir}:/opt/agent:ro`,
          `${config.workHostDir}:/work`,
        ],
        NetworkMode: config.network ?? 'litmus-agents',
        Memory: (config.limits?.memory ?? 4) * 1024 * 1024 * 1024,
        NanoCpus: (config.limits?.cpus ?? 2) * 1e9,
      },
    });
    await container.start();
    return { containerId: container.id, container };
  }

  async exec(handle: ExecutorHandle, cmd: string[], options?: ExecOptions): Promise<ExecResult> {
    const { container } = handle as ContainerHandle;
    const env = options?.env;
    const timeoutMs = options?.timeoutMs;

    const dockerExec = await container.exec({
      Cmd: cmd,
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await dockerExec.start({});

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const streamPromise = new Promise<void>((resolve, reject) => {
      const outStream = new PassThrough();
      const errStream = new PassThrough();

      container.modem.demuxStream(stream, outStream, errStream);

      outStream.on('data', (chunk: Buffer) => stdout.push(chunk));
      errStream.on('data', (chunk: Buffer) => stderr.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (timeoutMs && timeoutMs > 0) {
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const race = await Promise.race([
        streamPromise.then(() => 'done' as const),
        timeout,
      ]);
      if (race === 'timeout') {
        stream.destroy();
        // Kill orphaned exec processes inside the container.
        // PID 1 (sleep infinity) is protected from SIGKILL by the Linux kernel
        // in Docker's default config, so the container survives.
        await this.killOrphanedProcesses(container);
        return {
          exitCode: 124,
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: `Command timed out after ${timeoutMs}ms`,
        };
      }
    } else {
      await streamPromise;
    }

    const info = await dockerExec.inspect();
    return {
      exitCode: info.ExitCode ?? 1,
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    };
  }

  async stop(handle: ExecutorHandle): Promise<void> {
    const { container } = handle as ContainerHandle;
    try {
      await container.stop({ t: 5 });
    } catch {
      // Container may already be stopped
    }
    await container.remove({ force: true });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill all non-PID-1 processes inside a container (best-effort).
   * Used after exec timeout to prevent orphaned processes from starving the next scenario.
   */
  private async killOrphanedProcesses(container: Dockerode.Container): Promise<void> {
    try {
      const killExec = await container.exec({
        Cmd: ['sh', '-c', 'kill -9 -1 2>/dev/null; true'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const killStream = await killExec.start({});
      // Drain the stream so Docker doesn't buffer indefinitely
      killStream.on('data', () => {});
      await new Promise<void>((resolve) => {
        killStream.on('end', resolve);
        killStream.on('error', resolve);
        // Safety: don't wait more than 5s for cleanup
        setTimeout(resolve, 5000);
      });
    } catch {
      // Container may be stopped or process already dead
    }
  }

  /** Remove all containers labeled litmus.managed=true (orphan cleanup) */
  async cleanupOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['litmus.managed=true'] },
    });
    for (const info of containers) {
      const c = this.docker.getContainer(info.Id);
      try {
        await c.stop({ t: 2 });
      } catch {
        // already stopped
      }
      await c.remove({ force: true });
    }
    return containers.length;
  }
}

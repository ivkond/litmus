import Dockerode from 'dockerode';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorConfig, ExecutorHandle, InteractiveHandle, ExecOptions } from './types';

interface ContainerHandle extends ExecutorHandle {
  container: Dockerode.Container;
}

export class DockerExecutor implements AgentExecutor {
  type = 'docker' as const;
  private docker: Dockerode;

  constructor(dockerHost: string) {
    const url = new URL(dockerHost);
    if (url.protocol === 'unix:' || dockerHost.startsWith('unix://')) {
      const socketPath = dockerHost.replace(/^unix:\/\//, '');
      this.docker = new Dockerode({ socketPath });
    } else {
      this.docker = new Dockerode({ host: url.hostname, port: Number(url.port) });
    }
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
          ...(config.sharedScriptsDir ? [`${config.sharedScriptsDir}:/opt/shared:ro`] : []),
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

  async exec(handle: ExecutorHandle, cmd: string[], options?: ExecOptions): Promise<InteractiveHandle> {
    const { container } = handle as ContainerHandle;
    const env = options?.env;

    const dockerExec = await container.exec({
      Cmd: cmd,
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await dockerExec.start({ hijack: true, stdin: true });

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    container.modem.demuxStream(stream, stdout, stderr);
    stream.on('end', () => {
      stdout.end();
      stderr.end();
    });

    const stdinProxy = new PassThrough();
    stdinProxy.pipe(stream);

    return {
      stdin: stdinProxy,
      stdout,
      stderr,
      wait: async () => {
        await new Promise<void>((resolve) => {
          stream.on('end', resolve);
          stream.on('error', resolve);
        });
        const info = await dockerExec.inspect();
        return info.ExitCode ?? 1;
      },
      kill: async () => {
        stream.destroy();
        await this.killOrphanedProcesses(container);
      },
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

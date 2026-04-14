# ACP Integration into Scheduler/Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stdout-parsing shell-based agent execution with Agent Client Protocol (ACP) — structured JSON-RPC over stdio — in the orchestrator.

**Architecture:** `DockerExecutor.exec` changes from fire-and-collect (`ExecResult`) to bidirectional streaming (`InteractiveHandle`). A `collect()` utility wraps one-shot commands (init.sh, test scripts). `AcpSession` manages ACP lifecycle per lane via `@agentclientprotocol/sdk`. Mock ACP server replaces `mock/run.sh` for E2E tests.

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk@^0.18.0`, Dockerode (hijack mode), Python 3.12 (mock server), Vitest

**Spec:** `docs/superpowers/specs/2026-03-29-acp-integration-design.md`

---

## SDK API Reference (v0.18.0)

> The spec references SDK v0.11.4 but the current version is **v0.18.0**. This plan uses the actual current API.

```typescript
import * as acp from '@agentclientprotocol/sdk';

// Stream creation: convert Node.js streams to web streams
const stdinWeb = Writable.toWeb(proc.stdin!);
const stdoutWeb = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

// Connection: toClient factory + stream
const conn = new acp.ClientSideConnection((_agent) => client, stream);

// Initialize
await conn.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {},
  clientInfo: { name: 'litmus', version: '1.0.0' },
});

// New session
const { sessionId } = await conn.newSession({
  cwd: '/work/runs/run-1/mock/gpt-4o/1-trivial-pass',
  mcpServers: [],
});

// Prompt (ContentBlock array, not string)
const result = await conn.prompt({
  sessionId,
  prompt: [{ type: 'text', text: 'Implement the required functionality.' }],
  _meta: { scenarioDir: '/work/runs/run-1/_scenarios/1-trivial-pass' },
});
// result: { stopReason, usage?, _meta? }

// Cancel (notification, not request)
await conn.cancel({ sessionId });

// StopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
// Usage: { inputTokens, outputTokens, totalTokens, cachedReadTokens?, cachedWriteTokens?, thoughtTokens? }
```

**Key differences from spec (SDK v0.18 vs spec's v0.11.4):**

1. **`session/update` via callback:** Tool calls and text chunks are delivered via the `Client.sessionUpdate` callback, not in `PromptResponse`. The `PromptResponse` only contains `stopReason` and `usage`.

2. **No `configuration` in prompt:** The spec describes `configuration: { model, workspaceDir }` in the prompt request. SDK v0.18 has no `configuration` field in `PromptRequest` — `cwd` is set in `newSession()`, and there is no standard way to pass model selection per-prompt. **Conscious deviation:** model is set at the agent CLI level (via ACP command flags or env vars, not per-prompt). `workspaceDir` maps to `cwd` in `newSession`. This is architecturally correct because the ACP session lives per-lane (one model per lane), and `newSession` is called per-scenario with the correct `cwd`.

3. **`usage` field names follow SDK 0.18:** `cachedReadTokens`/`cachedWriteTokens`/`thoughtTokens`/`totalTokens` instead of spec's `cacheReadTokens`/`cacheCreationTokens`. No `totalTokens` in spec; added from SDK.

4. **No `connection.close()`:** `ClientSideConnection` has no explicit `close()` method. Connection closes when the underlying stream ends. `AcpSession.close()` ends stdin and awaits `connection.closed` promise.

5. **`StopReason` values:** The SDK adds `'max_turn_requests'` as a new stop reason not present in the spec — it means the agent hit its internal tool-call limit. Separately, the spec's `'error'` stopReason (for internal agent errors) has no direct ACP protocol equivalent — our `AgentResult.stopReason = 'error'` is produced by the `mapStopReason` fallback for unknown values and by process-level failures (e.g. binary not found, handshake rejected), not by the ACP `StopReason` enum.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `web/src/lib/orchestrator/types.ts` | Modify | Add `InteractiveHandle`, `AgentResult`, `AgentToolCall`, `AcpAgentConfig`; update `AgentExecutor.exec` return type |
| `web/src/lib/orchestrator/docker-executor.ts` | Modify | Rewrite `exec()` to return `InteractiveHandle` via Docker hijack mode |
| `web/src/lib/orchestrator/collect.ts` | Create | `collect()` free function — wraps `InteractiveHandle` into `ExecResult` for one-shot commands |
| `web/src/lib/orchestrator/acp-session.ts` | Create | `AcpSession` class — ACP client lifecycle (start, prompt, cancel, resetSession, close) |
| `web/src/lib/orchestrator/scheduler.ts` | Modify | Use `AcpSession` for agent calls, `collect()` for shell scripts; add `activeSessions` map |
| `web/src/app/api/agents/[id]/models/route.ts` | Modify | Replace `docker.exec()` with `collect()` |
| `web/agents/mock/mock-acp-server.py` | Create | Minimal ACP server over stdio (Python 3.12 stdlib) for E2E tests |
| `web/src/lib/orchestrator/__tests__/collect.test.ts` | Create | Contract tests for `collect()` |
| `web/src/lib/orchestrator/__tests__/docker-executor.test.ts` | Modify | Update assertions: `InteractiveHandle` instead of `ExecResult` |
| `web/src/lib/orchestrator/__tests__/acp-session.test.ts` | Create | Unit tests with mock `ClientSideConnection` |
| `web/src/lib/orchestrator/__tests__/scheduler.test.ts` | Modify | Mock executor returns `InteractiveHandle`; mock `AcpSession` for agent calls |
| `web/e2e/run-acp-lifecycle.test.ts` | Create | Full ACP run lifecycle E2E test with mock agent |
| `web/src/app/api/runs/route.ts` | Modify | Update JSDoc/Zod comment (remove `run.sh` reference) |

---

## Phase 1: Types + DockerExecutor + collect + migrate all call sites

> Changing `AgentExecutor.exec` return type breaks every call site. ALL callers must switch to `collect()` in the same phase, otherwise TypeScript won't compile. This is a pure refactoring phase — zero behavior change.

### Task 1: Install ACP SDK

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install the SDK**

```bash
cd web && npm install @agentclientprotocol/sdk
```

- [ ] **Step 2: Verify installation**

```bash
cd web && node -e "const acp = require('@agentclientprotocol/sdk'); console.log('PROTOCOL_VERSION:', acp.PROTOCOL_VERSION)"
```

Expected: prints `PROTOCOL_VERSION: <version string>` without error.

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore(web): add @agentclientprotocol/sdk dependency"
```

---

### Task 2: Add new types to types.ts

**Files:**
- Modify: `web/src/lib/orchestrator/types.ts`
- Test: `web/src/lib/orchestrator/__tests__/types-compile.test.ts`

- [ ] **Step 1: Write compile-time type test**

Create `web/src/lib/orchestrator/__tests__/types-compile.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type {
  InteractiveHandle,
  AgentResult,
  AgentToolCall,
  AcpAgentConfig,
  AgentExecutor,
  ExecResult,
  ExecutorHandle,
} from '../types';

describe('InteractiveHandle type', () => {
  it('has stdin, stdout, stderr streams and wait/kill methods', () => {
    expectTypeOf<InteractiveHandle>().toHaveProperty('stdin');
    expectTypeOf<InteractiveHandle>().toHaveProperty('stdout');
    expectTypeOf<InteractiveHandle>().toHaveProperty('stderr');
    expectTypeOf<InteractiveHandle>().toHaveProperty('wait');
    expectTypeOf<InteractiveHandle>().toHaveProperty('kill');
  });

  it('wait returns Promise<number> (exit code)', () => {
    expectTypeOf<InteractiveHandle['wait']>().returns.resolves.toBeNumber();
  });

  it('kill returns Promise<void>', () => {
    expectTypeOf<InteractiveHandle['kill']>().returns.resolves.toBeVoid();
  });
});

describe('AgentResult type', () => {
  it('has stopReason as union of known reasons', () => {
    expectTypeOf<AgentResult['stopReason']>().toEqualTypeOf<
      'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error'
    >();
  });

  it('has required content and toolCalls', () => {
    expectTypeOf<AgentResult>().toHaveProperty('content');
    expectTypeOf<AgentResult>().toHaveProperty('toolCalls');
  });

  it('has optional usage', () => {
    expectTypeOf<AgentResult['usage']>().toEqualTypeOf<
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cachedReadTokens?: number;
          cachedWriteTokens?: number;
          thoughtTokens?: number;
          durationMs: number;
        }
      | undefined
    >();
  });
});

describe('AcpAgentConfig type', () => {
  it('has acpCmd as string array', () => {
    expectTypeOf<AcpAgentConfig['acpCmd']>().toEqualTypeOf<string[]>();
  });
});

describe('AgentExecutor.exec returns InteractiveHandle', () => {
  it('exec method returns Promise<InteractiveHandle>', () => {
    type ExecReturn = ReturnType<AgentExecutor['exec']>;
    expectTypeOf<ExecReturn>().resolves.toEqualTypeOf<InteractiveHandle>();
  });
});

describe('ExecResult still exists (used by collect)', () => {
  it('has exitCode, stdout, stderr', () => {
    expectTypeOf<ExecResult>().toHaveProperty('exitCode');
    expectTypeOf<ExecResult>().toHaveProperty('stdout');
    expectTypeOf<ExecResult>().toHaveProperty('stderr');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/types-compile.test.ts
```

Expected: FAIL — `InteractiveHandle`, `AgentResult`, `AgentToolCall`, `AcpAgentConfig` not exported from types.

- [ ] **Step 3: Add new types and update AgentExecutor**

In `web/src/lib/orchestrator/types.ts`, add after the `ExecResult` interface (after line 25) and update `AgentExecutor.exec`:

```typescript
// ─── Executor Interface ────────────────────────────────────────

export interface AgentExecutor {
  type: 'docker' | 'host' | 'kubernetes';
  start(config: ExecutorConfig): Promise<ExecutorHandle>;
  exec(handle: ExecutorHandle, cmd: string[], options?: ExecOptions): Promise<InteractiveHandle>;
  stop(handle: ExecutorHandle): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export interface ExecOptions {
  env?: Record<string, string>;
  /** Timeout in milliseconds. 0 or undefined = no timeout. */
  timeoutMs?: number;
}

export interface ExecutorHandle {
  containerId: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── Interactive Handle (bidirectional process streams) ───────

export interface InteractiveHandle {
  stdin: import('stream').Writable;
  stdout: import('stream').Readable;
  stderr: import('stream').Readable;
  /** Wait for process to finish, returns exit code */
  wait(): Promise<number>;
  /** Force-kill the process */
  kill(): Promise<void>;
}

// ─── ACP Agent Result ─────────────────────────────────────────

export interface AgentResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';
  content: string;
  toolCalls: AgentToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    durationMs: number;
  };
}

export interface AgentToolCall {
  name: string;
  status: 'completed' | 'failed';
  input: Record<string, unknown>;
  output?: string;
}

export interface AcpAgentConfig {
  acpCmd: string[];
  requiresAuth: boolean;
  capabilities?: Record<string, unknown>;
}
```

The change to `AgentExecutor.exec` return type (`ExecResult` → `InteractiveHandle`) will cause compile errors in `docker-executor.ts`, `scheduler.ts`, and `models/route.ts`. These are fixed in Tasks 3-6.

- [ ] **Step 4: Run type test to verify it passes**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/types-compile.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/types.ts web/src/lib/orchestrator/__tests__/types-compile.test.ts
git commit -m "feat(orchestrator): add InteractiveHandle, AgentResult, AcpAgentConfig types; update AgentExecutor.exec signature"
```

---

### Task 3: Create collect() utility

**Files:**
- Create: `web/src/lib/orchestrator/collect.ts`
- Create: `web/src/lib/orchestrator/__tests__/collect.test.ts`

- [ ] **Step 1: Write collect tests**

Create `web/src/lib/orchestrator/__tests__/collect.test.ts`:

```typescript
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
      await new Promise((resolve) => stdout.on('end', resolve));
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

    // stdin should have been ended
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/collect.test.ts
```

Expected: FAIL — `collect` module does not exist.

- [ ] **Step 3: Implement collect()**

Create `web/src/lib/orchestrator/collect.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/collect.test.ts
```

Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/collect.ts web/src/lib/orchestrator/__tests__/collect.test.ts
git commit -m "feat(orchestrator): add collect() utility for one-shot commands over InteractiveHandle"
```

---

### Task 4: Rewrite DockerExecutor.exec to return InteractiveHandle

**Files:**
- Modify: `web/src/lib/orchestrator/docker-executor.ts`
- Modify: `web/src/lib/orchestrator/__tests__/docker-executor.test.ts`

- [ ] **Step 1: Rewrite docker-executor tests**

Replace the entire content of `web/src/lib/orchestrator/__tests__/docker-executor.test.ts`. The key change: `exec()` now returns an `InteractiveHandle` with streams, not a collected `ExecResult`. Start/stop/health tests remain structurally similar.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { DockerExecutor } from '../docker-executor';
import type { ExecutorConfig } from '../types';

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
    expect(await executor.healthCheck()).toBe(true);
  });

  it('returns false from healthCheck() when Docker is unreachable', async () => {
    mockDocker.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await executor.healthCheck()).toBe(false);
  });
});

describe('DockerExecutor - exec returns InteractiveHandle', () => {
  let executor: DockerExecutor;

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
    executor = new DockerExecutor('tcp://localhost:2375');
  });

  it('returns InteractiveHandle with stdin, stdout, stderr streams', async () => {
    setupExecMock({ stdout: 'hello' });

    const handle = await executor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const ih = await executor.exec(handle, ['echo', 'hello']);

    expect(ih).toHaveProperty('stdin');
    expect(ih).toHaveProperty('stdout');
    expect(ih).toHaveProperty('stderr');
    expect(ih).toHaveProperty('wait');
    expect(ih).toHaveProperty('kill');
  });

  it('stdout stream receives command output', async () => {
    setupExecMock({ stdout: 'hello world' });

    const handle = await executor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const ih = await executor.exec(handle, ['echo', 'hello']);

    const chunks: Buffer[] = [];
    ih.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    await ih.wait();
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('hello world');
  });

  it('wait() returns exit code from Docker inspect', async () => {
    setupExecMock({ exitCode: 42 });

    const handle = await executor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    const ih = await executor.exec(handle, ['false']);
    const exitCode = await ih.wait();

    expect(exitCode).toBe(42);
  });

  it('passes env vars to Docker exec', async () => {
    setupExecMock({ stdout: '' });

    const handle = await executor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    await executor.exec(handle, ['run.sh'], { env: { FOO: 'bar' } });

    expect(mockContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({ Env: ['FOO=bar'] }),
    );
  });

  it('creates exec with AttachStdin for bidirectional communication', async () => {
    setupExecMock({ stdout: '' });

    const handle = await executor.start({
      image: 'litmus/runtime-python', agentHostDir: '/a', workHostDir: '/w', runId: 'r1', env: {},
    });
    await executor.exec(handle, ['acp-server']);

    expect(mockContainer.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      }),
    );
  });
});

describe('DockerExecutor - cleanupOrphans', () => {
  let executor: DockerExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new DockerExecutor('tcp://localhost:2375');
  });

  it('removes all litmus.managed containers', async () => {
    const mockOrphan = {
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockDocker.listContainers.mockResolvedValueOnce([{ Id: 'orphan-1' }]);
    (mockDocker as Record<string, unknown>).getContainer = vi.fn().mockReturnValue(mockOrphan);

    const count = await executor.cleanupOrphans();
    expect(count).toBe(1);
    expect(mockOrphan.stop).toHaveBeenCalled();
    expect(mockOrphan.remove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/docker-executor.test.ts
```

Expected: FAIL — `exec()` still returns `ExecResult`, not `InteractiveHandle`.

- [ ] **Step 3: Rewrite DockerExecutor.exec**

Replace the entire `exec` method in `web/src/lib/orchestrator/docker-executor.ts`:

```typescript
import Dockerode from 'dockerode';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorConfig, ExecutorHandle, ExecOptions, InteractiveHandle } from './types';

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
    // ... unchanged — keep existing implementation exactly as-is
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
    // ... unchanged
  }

  async healthCheck(): Promise<boolean> {
    // ... unchanged
  }

  private async killOrphanedProcesses(container: Dockerode.Container): Promise<void> {
    // ... unchanged
  }

  async cleanupOrphans(): Promise<number> {
    // ... unchanged
  }
}
```

Key changes:
- `exec` now passes `{ hijack: true, stdin: true }` to `dockerExec.start()`
- Returns `InteractiveHandle` with separate stdout/stderr `PassThrough` streams
- `stdin` is a `PassThrough` piped into the Docker multiplexed stream
- `wait()` awaits stream end + calls `dockerExec.inspect()` for exit code
- `kill()` destroys the stream and kills orphaned processes (reuses existing `killOrphanedProcesses`)
- Timeout management is removed from `exec` — now handled by callers (`collect` or `AcpSession`)

- [ ] **Step 4: Run docker-executor tests**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/docker-executor.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/docker-executor.ts web/src/lib/orchestrator/__tests__/docker-executor.test.ts
git commit -m "refactor(orchestrator): DockerExecutor.exec returns InteractiveHandle with bidirectional streams"
```

---

### Task 5: Migrate scheduler.ts to use collect()

**Files:**
- Modify: `web/src/lib/orchestrator/scheduler.ts`
- Modify: `web/src/lib/orchestrator/__tests__/scheduler.test.ts`

> This is the largest migration. Every `this.executor.exec(handle, [...])` call becomes `collect(this.executor, handle, [...])`. Import `collect` at the top. Behavior is identical — `collect` wraps `InteractiveHandle` back into `ExecResult`.

- [ ] **Step 1: Update scheduler.test.ts mock executor to return InteractiveHandle**

The mock executor must return `InteractiveHandle` instead of `ExecResult`. Replace the `createMockExecutor` function:

```typescript
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorHandle, InteractiveHandle, ExecOptions } from '../types';

function createMockInteractiveHandle(opts?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): InteractiveHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = opts?.exitCode ?? 0;

  process.nextTick(() => {
    if (opts?.stdout) stdout.write(opts.stdout);
    if (opts?.stderr) stderr.write(opts.stderr);
    stdout.end();
    stderr.end();
  });

  return {
    stdin,
    stdout,
    stderr,
    wait: async () => {
      await new Promise<void>((resolve) => stdout.on('end', resolve));
      return exitCode;
    },
    kill: async () => {},
  };
}

function createMockExecutor(): AgentExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    type: 'docker',
    calls,
    async start() {
      calls.push('start');
      return { containerId: 'mock-container' } as ExecutorHandle;
    },
    async exec(_handle: ExecutorHandle, cmd: string[], _options?: ExecOptions) {
      const cmdStr = cmd.join(' ');
      calls.push(`exec: ${cmdStr}`);
      return createMockInteractiveHandle({ exitCode: 0, stdout: 'ok', stderr: '' });
    },
    async stop() {
      calls.push('stop');
    },
    async healthCheck() {
      return true;
    },
  };
}
```

Also update all `vi.spyOn(executor, 'exec').mockImplementation(...)` calls in error path tests to return `InteractiveHandle` instead of `ExecResult`:

```typescript
// Before (returns ExecResult):
return { exitCode: 2, stdout: '', stderr: 'infra failure' };

// After (returns InteractiveHandle):
return createMockInteractiveHandle({ exitCode: 2, stdout: '', stderr: 'infra failure' });
```

Apply this change to ALL `mockImplementation` blocks that mock `executor.exec` — there are **7** such blocks:
1. "emits task:error when run.sh returns infra error exit code 2"
2. "emits task:error with timeout message on exit code 124"
3. "emits task:error when init.sh fails"
4. "emits task:error when test script returns infra error exit code 2"
5. "processes multiple lanes with concurrency limit" (the slow run.sh mock)
6. "cancels remaining tasks when cancel() is called mid-run" (the slow run.sh mock)
7. "emits run:completed with all error/failed/completed counts" (model3 infra error)

For tests that override `executor.exec` inline (like the concurrency test), also return `InteractiveHandle`:

```typescript
executor.exec = async (handle: ExecutorHandle, cmd: string[], options?: ExecOptions) => {
  const cmdStr = cmd.join(' ');
  if (cmdStr.includes('run.sh')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return originalExec(handle, cmd, options);
};
```

This works because `originalExec` now returns `InteractiveHandle`.

- [ ] **Step 2: Update scheduler.ts to import and use collect()**

In `web/src/lib/orchestrator/scheduler.ts`:

Add import at top:
```typescript
import { collect } from './collect';
```

Replace all 3 `this.executor.exec(handle, [...], ...)` calls in `executeScenario` with `collect(...)`:

**init.sh call (around line 259):**
```typescript
// Before:
const initResult = await this.executor.exec(handle, [
  '/opt/shared/init.sh',
  '--scenario', scenarioStagedPath,
  '--workspace', sessionDir,
], stepTimeout);

// After:
const initResult = await collect(this.executor, handle, [
  '/opt/shared/init.sh',
  '--scenario', scenarioStagedPath,
  '--workspace', sessionDir,
], stepTimeout);
```

**run.sh call (around line 290):**
```typescript
// Before:
const agentResult = await this.executor.exec(handle, [
  '/opt/agent/run.sh',
  '--model', lane.model.externalId,
  '--prompt', currentPrompt,
  '--workspace', sessionDir,
  '--scenario-dir', scenarioStagedPath,
], stepTimeout);

// After:
const agentResult = await collect(this.executor, handle, [
  '/opt/agent/run.sh',
  '--model', lane.model.externalId,
  '--prompt', currentPrompt,
  '--workspace', sessionDir,
  '--scenario-dir', scenarioStagedPath,
], stepTimeout);
```

**test script call (around line 310):**
```typescript
// Before:
const testResult = await this.executor.exec(handle, [
  testScript,
  '--workspace', sessionDir,
  '--output', `${sessionDir}/test-results.json`,
], stepTimeout);

// After:
const testResult = await collect(this.executor, handle, [
  testScript,
  '--workspace', sessionDir,
  '--output', `${sessionDir}/test-results.json`,
], stepTimeout);
```

- [ ] **Step 3: Run scheduler tests**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts
```

Expected: PASS (all existing tests pass — behavior unchanged)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/orchestrator/scheduler.ts web/src/lib/orchestrator/__tests__/scheduler.test.ts
git commit -m "refactor(orchestrator): migrate scheduler to collect() for all shell commands"
```

---

### Task 6: Migrate models/route.ts to use collect()

**Files:**
- Modify: `web/src/app/api/agents/[id]/models/route.ts`

- [ ] **Step 1: Update models route**

In `web/src/app/api/agents/[id]/models/route.ts`:

Add import:
```typescript
import { collect } from '@/lib/orchestrator/collect';
```

Replace line 58:
```typescript
// Before:
const result = await docker.exec(handle, ['/opt/agent/models.sh']);

// After:
const result = await collect(docker, handle, ['/opt/agent/models.sh']);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no compile errors (entire project compiles with new `exec` signature)

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/agents/[id]/models/route.ts
git commit -m "refactor(orchestrator): migrate models route to collect()"
```

---

### Task 7: Phase 1 verification — full test suite

- [ ] **Step 1: Run all orchestrator tests**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/
```

Expected: ALL PASS

- [ ] **Step 2: Run full project tests**

```bash
cd web && npx vitest run
```

Expected: ALL PASS — Phase 1 is a pure refactoring, zero behavior change.

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors

---

## Phase 2: AcpSession

### Task 8: Create AcpSession class

**Files:**
- Create: `web/src/lib/orchestrator/acp-session.ts`
- Create: `web/src/lib/orchestrator/__tests__/acp-session.test.ts`

- [ ] **Step 1: Write AcpSession unit tests**

Create `web/src/lib/orchestrator/__tests__/acp-session.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import { AcpSession } from '../acp-session';
import type { AgentExecutor, ExecutorHandle, InteractiveHandle, AcpAgentConfig } from '../types';

// Mock the ACP SDK module
const mockInitialize = vi.fn().mockResolvedValue({ protocolVersion: '0.1', agentInfo: { name: 'mock' } });
const mockNewSession = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
const mockPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn', usage: null });
const mockCancel = vi.fn().mockResolvedValue(undefined);
const mockConnection = {
  initialize: mockInitialize,
  newSession: mockNewSession,
  prompt: mockPrompt,
  cancel: mockCancel,
  closed: new Promise<void>(() => {}),
  signal: new AbortController().signal,
};

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: '2025-11-16',
  ndJsonStream: vi.fn().mockReturnValue('mock-stream'),
  ClientSideConnection: vi.fn().mockImplementation(() => mockConnection),
}));

function createMockInteractiveHandle(): InteractiveHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin,
    stdout,
    stderr,
    wait: vi.fn().mockImplementation(() => new Promise(() => {})), // hangs (ACP server is long-running)
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExecutor(ih: InteractiveHandle): AgentExecutor {
  return {
    type: 'docker',
    start: vi.fn(),
    exec: vi.fn().mockResolvedValue(ih),
    stop: vi.fn(),
    healthCheck: vi.fn(),
  };
}

describe('AcpSession', () => {
  let executor: AgentExecutor;
  let ih: InteractiveHandle;
  const handle = { containerId: 'c1' } as ExecutorHandle;
  const acpConfig: AcpAgentConfig = {
    acpCmd: ['python3', '/opt/agent/mock-acp-server.py'],
    requiresAuth: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ih = createMockInteractiveHandle();
    executor = createMockExecutor(ih);
    mockPrompt.mockResolvedValue({ stopReason: 'end_turn', usage: null });
  });

  describe('start', () => {
    it('spawns ACP process and initializes connection', async () => {
      const session = await AcpSession.start(executor, handle, acpConfig);

      expect(executor.exec).toHaveBeenCalledWith(handle, acpConfig.acpCmd, undefined);
      expect(mockInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          clientInfo: expect.objectContaining({ name: 'litmus' }),
        }),
      );
      expect(session).toBeInstanceOf(AcpSession);
    });

    it('throws if initialize fails', async () => {
      mockInitialize.mockRejectedValueOnce(new Error('handshake rejected'));

      await expect(AcpSession.start(executor, handle, acpConfig)).rejects.toThrow('handshake rejected');
    });
  });

  describe('prompt', () => {
    it('creates new session and sends prompt, returns AgentResult', async () => {
      const session = await AcpSession.start(executor, handle, acpConfig);

      const result = await session.prompt({
        text: 'Implement the function.',
        cwd: '/work/runs/run-1/mock/gpt-4o/1-trivial',
        scenarioDir: '/work/runs/run-1/_scenarios/1-trivial',
      });

      expect(mockNewSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/work/runs/run-1/mock/gpt-4o/1-trivial' }),
      );
      expect(mockPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          prompt: [{ type: 'text', text: 'Implement the function.' }],
          _meta: { scenarioDir: '/work/runs/run-1/_scenarios/1-trivial' },
        }),
      );
      expect(result.stopReason).toBe('end_turn');
    });

    it('reuses existing sessionId on subsequent prompts (retry)', async () => {
      const session = await AcpSession.start(executor, handle, acpConfig);

      await session.prompt({ text: 'first', cwd: '/work/a', scenarioDir: '/work/s' });
      await session.prompt({ text: 'retry', cwd: '/work/a', scenarioDir: '/work/s' });

      // newSession called only once
      expect(mockNewSession).toHaveBeenCalledTimes(1);
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });

    it('maps max_tokens to retryable AgentResult', async () => {
      mockPrompt.mockResolvedValueOnce({ stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });

      const session = await AcpSession.start(executor, handle, acpConfig);
      const result = await session.prompt({ text: 'do it', cwd: '/work/a', scenarioDir: '/work/s' });

      expect(result.stopReason).toBe('max_tokens');
      expect(result.usage).toEqual(expect.objectContaining({ inputTokens: 100, outputTokens: 50 }));
    });

    it('maps refusal to non-retryable AgentResult', async () => {
      mockPrompt.mockResolvedValueOnce({ stopReason: 'refusal', usage: null });

      const session = await AcpSession.start(executor, handle, acpConfig);
      const result = await session.prompt({ text: 'bad', cwd: '/work/a', scenarioDir: '/work/s' });

      expect(result.stopReason).toBe('refusal');
    });
  });

  describe('resetSession', () => {
    it('clears sessionId so next prompt creates a new session', async () => {
      const session = await AcpSession.start(executor, handle, acpConfig);

      await session.prompt({ text: 'first', cwd: '/work/a', scenarioDir: '/work/s' });
      session.resetSession();
      await session.prompt({ text: 'second', cwd: '/work/b', scenarioDir: '/work/s' });

      expect(mockNewSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancel', () => {
    it('sends session/cancel notification', async () => {
      const session = await AcpSession.start(executor, handle, acpConfig);
      await session.prompt({ text: 'go', cwd: '/work/a', scenarioDir: '/work/s' });
      await session.cancel();

      expect(mockCancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('force-kills process if cancel takes too long', async () => {
      mockCancel.mockImplementation(() => new Promise(() => {})); // never resolves

      const session = await AcpSession.start(executor, handle, acpConfig);
      await session.prompt({ text: 'go', cwd: '/work/a', scenarioDir: '/work/s' });
      await session.cancel();

      expect(ih.kill).toHaveBeenCalled();
    }, 10000);
  });

  describe('close', () => {
    it('closes stdin and awaits connection.closed + process exit', async () => {
      const session = await AcpSession.start(executor, handle, acpConfig);
      await session.close();

      // stdin should be closed to signal EOF to the ACP server
      expect((ih.stdin as PassThrough).writableEnded).toBe(true);
      // connection.closed should have been awaited (via Promise.all in close())
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/acp-session.test.ts
```

Expected: FAIL — `acp-session` module does not exist.

- [ ] **Step 3: Implement AcpSession**

Create `web/src/lib/orchestrator/acp-session.ts`:

```typescript
import { Readable, Writable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentExecutor,
  ExecutorHandle,
  ExecOptions,
  InteractiveHandle,
  AcpAgentConfig,
  AgentResult,
  AgentToolCall,
} from './types';

interface PromptParams {
  text: string;
  cwd: string;
  scenarioDir: string;
  timeoutMs?: number;
}

export class AcpSession {
  private sessionId: string | null = null;
  private content: string = '';
  private toolCalls: AgentToolCall[] = [];

  private constructor(
    private connection: acp.ClientSideConnection,
    private proc: InteractiveHandle,
  ) {}

  static async start(
    executor: AgentExecutor,
    handle: ExecutorHandle,
    acpConfig: AcpAgentConfig,
  ): Promise<AcpSession> {
    const proc = await executor.exec(handle, acpConfig.acpCmd);

    const stdinWeb = Writable.toWeb(proc.stdin);
    const stdoutWeb = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    const session = new AcpSession(null as unknown as acp.ClientSideConnection, proc);

    const connection = new acp.ClientSideConnection(
      (_agent) => session.createClient(),
      stream,
    );
    (session as { connection: acp.ClientSideConnection }).connection = connection;

    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'litmus', version: '1.0.0' },
      clientCapabilities: {},
    });

    return session;
  }

  async prompt(params: PromptParams): Promise<AgentResult> {
    // Reset per-turn accumulators
    this.content = '';
    this.toolCalls = [];

    // Create session on first prompt (or after resetSession)
    if (!this.sessionId) {
      const result = await this.connection.newSession({
        cwd: params.cwd,
        mcpServers: [],
      });
      this.sessionId = result.sessionId;
    }

    const promptFn = () =>
      this.connection.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: 'text', text: params.text }],
        _meta: { scenarioDir: params.scenarioDir },
      });

    let response: acp.PromptResponse;

    if (params.timeoutMs && params.timeoutMs > 0) {
      const result = await Promise.race([
        promptFn().then((r) => ({ type: 'done' as const, response: r })),
        new Promise<{ type: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ type: 'timeout' }), params.timeoutMs),
        ),
      ]);

      if (result.type === 'timeout') {
        await this.cancel();
        return {
          stopReason: 'cancelled',
          content: this.content,
          toolCalls: this.toolCalls,
        };
      }
      response = result.response;
    } else {
      response = await promptFn();
    }

    const startMs = Date.now();
    return this.mapResponse(response, startMs);
  }

  resetSession(): void {
    this.sessionId = null;
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) return;

    const cancelPromise = this.connection.cancel({ sessionId: this.sessionId }).catch(() => {});

    const result = await Promise.race([
      cancelPromise.then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);

    if (result === 'timeout') {
      await this.proc.kill();
    }
  }

  async close(): Promise<void> {
    // Close stdin → signals EOF to ACP server → triggers stream end → connection.closed resolves
    this.proc.stdin.end();
    // Wait for SDK connection to close (stream end) + process exit, with safety timeout
    await Promise.race([
      Promise.all([this.connection.closed, this.proc.wait()]),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  private createClient(): acp.Client {
    return {
      sessionUpdate: (notification) => {
        this.handleSessionUpdate(notification);
      },
      requestPermission: async () => {
        // Auto-approve all tool calls (headless mode)
        return { allowed: true };
      },
    };
  }

  private handleSessionUpdate(notification: Record<string, unknown>): void {
    const updates = (notification as { updates?: unknown[] }).updates;
    if (!Array.isArray(updates)) return;

    for (const update of updates) {
      const u = update as Record<string, unknown>;
      if (u.type === 'text' && typeof u.text === 'string') {
        this.content += u.text;
      } else if (u.type === 'tool_call_start' || u.type === 'tool_call') {
        const name = (u.name ?? u.toolName ?? 'unknown') as string;
        const status = u.status === 'failed' ? 'failed' : 'completed';
        this.toolCalls.push({
          name,
          status,
          input: (u.input ?? {}) as Record<string, unknown>,
          output: u.output as string | undefined,
        });
      }
    }
  }

  private mapResponse(response: acp.PromptResponse, startMs: number): AgentResult {
    const durationMs = Date.now() - startMs;
    const usage = response.usage
      ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          cachedReadTokens: response.usage.cachedReadTokens ?? undefined,
          cachedWriteTokens: response.usage.cachedWriteTokens ?? undefined,
          thoughtTokens: response.usage.thoughtTokens ?? undefined,
          durationMs,
        }
      : undefined;

    return {
      stopReason: this.mapStopReason(response.stopReason),
      content: this.content,
      toolCalls: this.toolCalls,
      usage,
    };
  }

  private mapStopReason(
    reason: acp.StopReason,
  ): AgentResult['stopReason'] {
    switch (reason) {
      case 'end_turn': return 'end_turn';
      case 'max_tokens': return 'max_tokens';
      case 'max_turn_requests': return 'max_turn_requests';
      case 'refusal': return 'refusal';
      case 'cancelled': return 'cancelled';
      default: return 'error';
    }
  }
}
```

> **Implementation note:** The `Client` interface callback (`sessionUpdate`) accumulates text content and tool calls during the prompt turn. The `PromptResponse` only carries `stopReason` + `usage`, so content must be captured from notifications. The exact shape of `sessionUpdate` notifications may vary — the `handleSessionUpdate` method is a best-effort parser that should be validated against real agent output in Phase 3/4.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/acp-session.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/orchestrator/acp-session.ts web/src/lib/orchestrator/__tests__/acp-session.test.ts
git commit -m "feat(orchestrator): add AcpSession class — ACP client lifecycle over stdio"
```

---

## Phase 3: Mock ACP server + Scheduler migration (shell → ACP)

### Task 9: Create mock ACP server

**Files:**
- Create: `web/agents/mock/mock-acp-server.py`

- [ ] **Step 1: Create mock-acp-server.py**

Create `web/agents/mock/mock-acp-server.py`:

```python
#!/usr/bin/env python3
"""Minimal ACP JSON-RPC server over stdio for the mock agent.

Replaces mock/run.sh. Copies solution/ files into the workspace on session/prompt,
just like the shell script did.

Uses only Python 3.12 stdlib — no pip dependencies.
"""
import json
import shutil
import sys
import os
from pathlib import Path

def send_response(id: int | str, result: dict) -> None:
    msg = json.dumps({"jsonrpc": "2.0", "id": id, "result": result})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()

def send_notification(method: str, params: dict) -> None:
    msg = json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()

def handle_initialize(id, _params):
    send_response(id, {
        "protocolVersion": "2025-11-16",
        "agentInfo": {"name": "mock-acp", "version": "1.0.0"},
        "capabilities": {},
    })

def handle_new_session(id, params):
    # Note: spec says { id: "mock-session" } but SDK NewSessionResponse uses `sessionId`.
    # Using `sessionId` to match the actual protocol.
    send_response(id, {"sessionId": "mock-session"})

def handle_prompt(id, params):
    session_id = params.get("sessionId", "mock-session")
    meta = params.get("_meta", {})
    scenario_dir = meta.get("scenarioDir", "")

    # Determine workspace from the session's cwd (set in session/new)
    workspace = getattr(handle_prompt, "_cwd", "/work")
    solution_dir = os.path.join(scenario_dir, "solution")

    status_text = "Mock agent: no solution directory found"

    if os.path.isdir(solution_dir):
        project_dir = os.path.join(workspace, "project")
        os.makedirs(project_dir, exist_ok=True)
        for item in os.listdir(solution_dir):
            src = os.path.join(solution_dir, item)
            dst = os.path.join(project_dir, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        status_text = f"Mock agent: copied solution from {solution_dir} to {project_dir}"
    elif not scenario_dir:
        status_text = "Mock agent: no scenarioDir in _meta"

    # Send session/update notification with text content
    send_notification("session/update", {
        "sessionId": session_id,
        "updates": [{"type": "text", "text": status_text}],
    })

    send_response(id, {
        "stopReason": "end_turn",
        "usage": {
            "inputTokens": 10,
            "outputTokens": 5,
            "totalTokens": 15,
        },
    })

def handle_cancel(_params):
    # Notification — no response expected. Exit cleanly per spec.
    sys.exit(0)

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        params = msg.get("params", {})
        msg_id = msg.get("id")

        if method == "initialize":
            handle_initialize(msg_id, params)
        elif method == "session/new":
            # Store cwd for prompt handler
            handle_prompt._cwd = params.get("cwd", "/work")
            handle_new_session(msg_id, params)
        elif method == "session/prompt":
            handle_prompt(msg_id, params)
        elif method == "session/cancel":
            handle_cancel(params)
        elif msg_id is not None:
            # Unknown method with id — return error
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify mock server works locally**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-16"}}' | python3 web/agents/mock/mock-acp-server.py
```

Expected: JSON response with `agentInfo.name: "mock-acp"`.

- [ ] **Step 3: Commit**

```bash
git add web/agents/mock/mock-acp-server.py
git commit -m "feat(agents): add mock ACP server (Python 3, stdlib only) replacing mock/run.sh"
```

---

### Task 10: Add resolveAcpConfig to scheduler and integrate AcpSession into executeLane/executeScenario

**Files:**
- Modify: `web/src/lib/orchestrator/scheduler.ts`

- [ ] **Step 1: Update scheduler.test.ts with AcpSession mocks**

Add AcpSession mock to test file. The key: mock `AcpSession.start` to return a fake session, and verify the scheduler uses it for agent calls while keeping `collect` for init/test:

Add at the top of the test file after existing mocks:

```typescript
import { AcpSession } from '../acp-session';
import type { AgentResult } from '../types';

vi.mock('../acp-session', () => {
  const mockSession = {
    prompt: vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      content: 'Mock ACP response',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, durationMs: 1000 },
    } satisfies AgentResult),
    resetSession: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    AcpSession: {
      start: vi.fn().mockResolvedValue(mockSession),
      __mockSession: mockSession,
    },
  };
});
```

Update the "calls executor lifecycle" test to NOT check for `run.sh`:

```typescript
it('calls executor lifecycle: start → exec (init, test via collect) → AcpSession for agent → stop', async () => {
  const scheduler = new Scheduler(executor, reconciler, bus, './work');
  await scheduler.execute(config);

  expect(executor.calls[0]).toBe('start');
  expect(executor.calls.some((c: string) => c.includes('init.sh'))).toBe(true);
  // run.sh is no longer called — agent goes through AcpSession
  expect(executor.calls.some((c: string) => c.includes('run.sh'))).toBe(false);
  expect(executor.calls.some((c: string) => c.includes('python.sh'))).toBe(true);
  expect(executor.calls.at(-1)).toBe('stop');

  // Verify AcpSession was used
  expect(AcpSession.start).toHaveBeenCalled();
  const mockSession = (AcpSession as unknown as { __mockSession: { prompt: ReturnType<typeof vi.fn> } }).__mockSession;
  expect(mockSession.prompt).toHaveBeenCalled();
  expect(mockSession.close).toHaveBeenCalled();
});
```

Update error path tests — infra error from run.sh becomes ACP error scenarios:

```typescript
it('emits task:error when AcpSession.prompt returns error stopReason', async () => {
  const mockSession = (AcpSession as unknown as { __mockSession: Record<string, ReturnType<typeof vi.fn>> }).__mockSession;
  mockSession.prompt.mockResolvedValueOnce({
    stopReason: 'error',
    content: '',
    toolCalls: [],
  } satisfies AgentResult);

  const scheduler = new Scheduler(executor, reconciler, bus, './work');
  await scheduler.execute(config);

  const types = events.map((e) => e.type);
  expect(types).toContain('task:error');
  expect(types).not.toContain('task:completed');
});

it('emits task:error with refusal and does not retry', async () => {
  const mockSession = (AcpSession as unknown as { __mockSession: Record<string, ReturnType<typeof vi.fn>> }).__mockSession;
  mockSession.prompt.mockResolvedValueOnce({
    stopReason: 'refusal',
    content: 'I cannot do that.',
    toolCalls: [],
  } satisfies AgentResult);

  const scheduler = new Scheduler(executor, reconciler, bus, './work');
  await scheduler.execute(config);

  const taskError = events.find((e) => e.type === 'task:error');
  expect(taskError).toBeDefined();
  expect(taskError).toHaveProperty('errorMessage', expect.stringContaining('refusal'));
  // Only 1 prompt call — no retry for refusal
  expect(mockSession.prompt).toHaveBeenCalledTimes(1);
});

it('emits task:cancelled (not task:error) when user cancels during ACP prompt', async () => {
  const mockSession = (AcpSession as unknown as { __mockSession: Record<string, ReturnType<typeof vi.fn>> }).__mockSession;

  // Make prompt slow so we can cancel mid-flight (same pattern as existing cancel tests)
  mockSession.prompt.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { stopReason: 'cancelled', content: '', toolCalls: [] } satisfies AgentResult;
  });

  const scheduler = new Scheduler(executor, reconciler, bus, './work');
  const executePromise = scheduler.execute(config);

  // Cancel after 50ms — prompt is still in-flight
  await new Promise((resolve) => setTimeout(resolve, 50));
  await scheduler.cancel('run-1');

  await executePromise;

  // Key assertion: task:cancelled emitted, NOT task:error
  const cancelledEvent = events.find((e) => e.type === 'task:cancelled');
  expect(cancelledEvent).toBeDefined();
  expect(cancelledEvent).toHaveProperty('taskId', 'task-uuid-1');
  expect(cancelledEvent).toHaveProperty('agent', 'Mock');
  expect(cancelledEvent).toHaveProperty('scenario', '1-trivial-pass');

  // Must NOT have task:error for this scenario
  const errorEvents = events.filter((e) => e.type === 'task:error');
  expect(errorEvents).toHaveLength(0);

  // run:cancelled (not run:completed) at the run level
  const runCancelled = events.find((e) => e.type === 'run:cancelled');
  expect(runCancelled).toBeDefined();
});

it('emits task:error for remaining scenarios when AcpSession.start fails', async () => {
  // Verification #8 from spec: AcpSession.start failure in executeLane
  vi.mocked(AcpSession.start).mockRejectedValueOnce(new Error('binary not found'));

  const scheduler = new Scheduler(executor, reconciler, bus, './work');
  await scheduler.execute(config);

  const taskError = events.find((e) => e.type === 'task:error');
  expect(taskError).toBeDefined();
  expect(taskError).toHaveProperty('errorMessage', expect.stringContaining('binary not found'));

  const runCompleted = events.find((e) => e.type === 'run:completed');
  expect(runCompleted).toHaveProperty('errorTasks', 1);
});

it('retries on max_tokens then succeeds', async () => {
  const mockSession = (AcpSession as unknown as { __mockSession: Record<string, ReturnType<typeof vi.fn>> }).__mockSession;
  let callCount = 0;
  mockSession.prompt.mockImplementation(async () => {
    callCount++;
    return callCount === 1
      ? { stopReason: 'max_tokens', content: 'partial', toolCalls: [] }
      : { stopReason: 'end_turn', content: 'done', toolCalls: [] };
  });

  const scheduler = new Scheduler(executor, reconciler, bus, './work');
  await scheduler.execute(config);

  const types = events.map((e) => e.type);
  expect(types).toContain('task:completed');
  expect(mockSession.prompt).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts
```

Expected: FAIL — scheduler still calls `run.sh` via `collect`, not `AcpSession`.

- [ ] **Step 3: Implement scheduler changes**

In `web/src/lib/orchestrator/scheduler.ts`:

Add imports:
```typescript
import { AcpSession } from './acp-session';
import type { AcpAgentConfig, AgentResult } from './types';
```

Add `activeSessions` map and `resolveAcpConfig` method:

```typescript
export class Scheduler {
  private cancelled = false;
  private activeHandles = new Map<string, ExecutorHandle>();
  private activeSessions = new Map<string, AcpSession>();

  // ... constructor unchanged ...

  /**
   * Map agentType (from `agent_executors.agent_type` column in DB — free text, set by user
   * at agent creation via settings UI) to ACP launch config.
   *
   * IMPORTANT: Keys here MUST match the `agentType` values users enter when creating agents.
   * Before merging, verify actual values in the database match these keys.
   * Current convention: lowercase, hyphenated (e.g. 'claude-code', 'cursor', 'mock').
   */
  private resolveAcpConfig(agentType: string): AcpAgentConfig {
    const configs: Record<string, AcpAgentConfig> = {
      'claude-code': { acpCmd: ['claude', '--acp'], requiresAuth: true },
      'codex': { acpCmd: ['codex', 'acp'], requiresAuth: true },
      'opencode': { acpCmd: ['opencode', 'acp'], requiresAuth: true },
      'cline': { acpCmd: ['cline', '--acp'], requiresAuth: true },
      'kilocode': { acpCmd: ['kilo', 'acp'], requiresAuth: true },
      'cursor': { acpCmd: ['cursor', 'agent', '--acp'], requiresAuth: true },
      'mock': { acpCmd: ['python3', '/opt/agent/mock-acp-server.py'], requiresAuth: false },
    };
    const config = configs[agentType];
    if (!config) {
      throw new Error(`No ACP config for agent type "${agentType}". Known types: ${Object.keys(configs).join(', ')}`);
    }
    return config;
  }
```

Update `cancel` method:
```typescript
async cancel(runId: string): Promise<void> {
  this.cancelled = true;
  for (const [, session] of this.activeSessions) {
    try { await session.cancel(); } catch { /* best effort */ }
  }
  this.activeSessions.clear();
  for (const [, handle] of this.activeHandles) {
    try { await this.executor.stop(handle); } catch { /* best effort */ }
  }
  this.activeHandles.clear();

  await db
    .update(runTasks)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(runTasks.runId, runId), inArray(runTasks.status, ['pending', 'running'])))
    .catch((reason) => this.logBestEffortFailure(`Failed to cancel pending tasks for run ${runId}`, reason));
}
```

Update `executeLane` — create AcpSession per lane:
```typescript
private async executeLane(
  config: RunConfig,
  lane: LaneConfig,
): Promise<{ completed: number; failed: number; error: number; cancelled: number }> {
  const results = { completed: 0, failed: 0, error: 0, cancelled: 0 };
  const laneKey = `${lane.agent.slug}-${lane.model.name}`;
  const maxAttempts = config.maxRetries + 1;

  let handle: ExecutorHandle | null = null;
  let acpSession: AcpSession | null = null;
  let nextScenarioIndex = 0;

  try {
    const agentHostDir = resolveAgentHostDirForDocker(lane.agent.type);
    const sharedScriptsDir = resolveSharedScriptsDirForDocker();
    const workHostDir = resolveWorkHostDirForDocker();

    handle = await this.executor.start({
      image: 'litmus/runtime-python',
      agentHostDir,
      sharedScriptsDir,
      workHostDir,
      runId: config.runId,
      env: lane.env ?? {},
      labels: {
        'litmus.managed': 'true',
        'litmus.run-id': config.runId,
        'litmus.agent': lane.agent.slug,
        'litmus.model': lane.model.name,
      },
    });
    this.activeHandles.set(laneKey, handle);

    // Start ACP session for this lane
    const acpConfig = this.resolveAcpConfig(lane.agent.type);
    acpSession = await AcpSession.start(this.executor, handle, acpConfig);
    this.activeSessions.set(laneKey, acpSession);

    for (const scenario of lane.scenarios) {
      nextScenarioIndex = lane.scenarios.indexOf(scenario);
      if (this.cancelled) {
        results.cancelled += lane.scenarios.length - (results.completed + results.failed + results.error);
        break;
      }
      const taskResult = await this.executeScenario(config, lane, scenario, handle, acpSession);
      results[taskResult]++;
    }
  } catch (reason) {
    // ... unchanged error handling for remaining scenarios ...
  } finally {
    if (acpSession) {
      try { await acpSession.close(); } catch { /* best effort */ }
      this.activeSessions.delete(laneKey);
    }
    if (handle) {
      try { await this.executor.stop(handle); } catch { /* best effort */ }
      this.activeHandles.delete(laneKey);
    }
  }

  this.bus.emit(config.runId, {
    type: 'container:finished',
    runId: config.runId,
    agent: lane.agent.name,
    model: lane.model.name,
    completedCount: results.completed,
    failedCount: results.failed,
    errorCount: results.error,
  });

  return results;
}
```

Update `executeScenario` — accept `AcpSession` parameter, use `acpSession.prompt` instead of `collect` for agent call:

```typescript
private async executeScenario(
  config: RunConfig,
  lane: LaneConfig,
  scenario: { id: string; slug: string; prompt: string; language: string },
  handle: ExecutorHandle,
  acpSession: AcpSession,
): Promise<'completed' | 'failed' | 'error'> {
  // ... taskId, sessionDir, startedAt — unchanged ...
  // ... emit task:started — unchanged ...
  // ... persist running state — unchanged ...

  try {
    const stepTimeout = config.stepTimeoutSeconds > 0
      ? { timeoutMs: config.stepTimeoutSeconds * 1000 }
      : undefined;

    // init.sh — prepare workspace (via collect, unchanged)
    const initResult = await collect(this.executor, handle, [
      '/opt/shared/init.sh',
      '--scenario', scenarioStagedPath,
      '--workspace', sessionDir,
    ], stepTimeout);

    if (initResult.exitCode !== 0) {
      // ... unchanged error handling ...
    }

    const prompt = scenario.prompt;
    let evalResult: EvalResult | null = null;
    const testScript = this.resolveTestScript(scenario.language);

    // Reset ACP session for this scenario (new workspace)
    acpSession.resetSession();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const currentPrompt = attempt === 1
        ? prompt
        : this.buildRetryPrompt(prompt, evalResult?.testOutput ?? '');

      // ACP agent call (replaces collect + run.sh)
      const agentResult = await acpSession.prompt({
        text: currentPrompt,
        cwd: sessionDir,
        scenarioDir: scenarioStagedPath,
        timeoutMs: stepTimeout?.timeoutMs,
      });

      // Write telemetry file per attempt
      await this.writeTelemetry(localSessionDir, attempt, agentResult);

      // Error/stopReason-based detection (replaces exit code checks)
      if (agentResult.stopReason === 'error' || agentResult.stopReason === 'refusal') {
        const msg = `Agent ${agentResult.stopReason}: ${agentResult.content || 'no details'}`;
        this.bus.emit(config.runId, {
          type: 'task:error', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
          errorMessage: msg,
        });
        await this.persistTaskError(buildErrorMeta(attempt), msg);
        return 'error';
      }

      if (agentResult.stopReason === 'cancelled' && this.cancelled) {
        // User-initiated cancel → emit task:cancelled (spec: existing cancelled semantics)
        this.bus.emit(config.runId, {
          type: 'task:cancelled', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
        });
        await db.update(runTasks)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(eq(runTasks.id, taskId))
          .catch(() => {});
        return 'cancelled' as 'completed' | 'failed' | 'error';
        // Note: executeScenario return type needs extending to include 'cancelled'.
        // Update return type to: Promise<'completed' | 'failed' | 'error' | 'cancelled'>
        // and executeLane results accumulator to count it.
      }

      if (agentResult.stopReason === 'cancelled' && !this.cancelled) {
        // Timeout-triggered cancel → emit task:error (spec: "Agent timed out", non-retryable)
        const msg = 'Agent timed out';
        this.bus.emit(config.runId, {
          type: 'task:error', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
          errorMessage: msg,
        });
        await this.persistTaskError(buildErrorMeta(attempt), msg);
        return 'error';
      }

      // Test script (via collect, unchanged)
      const testResult = await collect(this.executor, handle, [
        testScript,
        '--workspace', sessionDir,
        '--output', `${sessionDir}/test-results.json`,
      ], stepTimeout);

      if (this.isInfraError(testResult.exitCode)) {
        const msg = `Test harness ${this.infraErrorLabel(testResult.exitCode)}: ${testResult.stderr}`;
        this.bus.emit(config.runId, {
          type: 'task:error', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
          errorMessage: msg,
        });
        await this.persistTaskError(buildErrorMeta(attempt), msg);
        return 'error';
      }

      evalResult = await this.reconciler.evaluate(localSessionDir);

      if (evalResult.allPassed) {
        // ... unchanged success path ...
        return 'completed';
      }

      // max_tokens is retryable — continue loop
      if (attempt < maxAttempts) {
        this.bus.emit(config.runId, {
          type: 'task:retrying', runId: config.runId, taskId,
          agent: lane.agent.name, model: lane.model.name, scenario: scenario.slug,
          attempt, maxAttempts, testOutput: evalResult.testOutput,
        });
      }
    }

    // All retries exhausted — unchanged
    // ...
  }
}
```

Add telemetry writer method:
```typescript
private async writeTelemetry(sessionDir: string, attempt: number, result: AgentResult): Promise<void> {
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `acp-telemetry-attempt-${attempt}.json`);
    await fs.writeFile(filePath, JSON.stringify({
      attempt,
      stopReason: result.stopReason,
      usage: result.usage ?? null,
      toolCalls: result.toolCalls,
    }, null, 2));
  } catch {
    // Best-effort — don't block execution
  }
}
```

Update `stepTimeoutSeconds` JSDoc in `types.ts` (line 193):
```typescript
/** Per-step timeout in seconds. 0 = no timeout (default). Applied to ACP agent prompts (triggers session/cancel) and shell commands via collect (triggers kill + exit 124). */
```

Update Zod schema comment in `runs/route.ts` (line 23):
```typescript
/** Per-step timeout in seconds (ACP prompt, test script). 0 = no timeout. */
```

- [ ] **Step 4: Run scheduler tests**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts
```

Expected: PASS

- [ ] **Step 5: Run all tests**

```bash
cd web && npx vitest run
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/orchestrator/scheduler.ts web/src/lib/orchestrator/__tests__/scheduler.test.ts web/src/lib/orchestrator/types.ts web/src/app/api/runs/route.ts
git commit -m "feat(orchestrator): integrate AcpSession into scheduler — replace run.sh with ACP for agent calls"
```

---

### Task 11: E2E test — ACP run lifecycle

**Files:**
- Create: `web/e2e/run-acp-lifecycle.test.ts`

> This test verifies the full ACP path: POST /api/runs → SSE events → init.sh → ACP prompt (mock copies solution) → test script → task:completed → run_results in DB.
> This is the critical ACP integration proof (Verification #5 from the spec).

- [ ] **Step 1: Write E2E test**

Create `web/e2e/run-acp-lifecycle.test.ts`. This test requires Docker and a real database — it should be tagged/skipped in CI unless the E2E environment is available:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db';
import { agents, agentExecutors, models, scenarios, runs, runTasks, runResults } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * E2E: Full ACP run lifecycle with mock agent.
 *
 * Prerequisites:
 * - Docker running with litmus/runtime-python image built
 * - Database seeded with mock agent, model, and scenario
 * - S3/garage running with scenario files uploaded
 *
 * This test uses the same infrastructure as run-pipeline.test.ts
 * but validates the ACP execution path specifically.
 */
describe('ACP run lifecycle E2E', () => {
  // Setup: seed DB entities, build Docker image
  // ... (depends on existing E2E infrastructure)

  it('completes a full run with mock ACP agent', async () => {
    // 1. POST /api/runs with mock agent
    // 2. Subscribe to SSE stream
    // 3. Verify events: task:started → task:completed → run:completed
    // 4. Verify run_results in DB: status='completed', totalScore=100
    // 5. Verify acp-telemetry-attempt-1.json exists in session dir
    expect(true).toBe(true); // Placeholder — actual implementation depends on E2E harness
  });
});
```

> **Note for implementor:** The exact E2E setup depends on the project's existing E2E infrastructure (Docker Compose, DB seeding, S3 fixtures). Use the same patterns as `run-pipeline.test.ts`. The critical assertions are:
> 1. SSE stream emits `task:started` then `task:completed` (not `task:error`)
> 2. `run_results` row has `status='completed'` and `totalScore=100`
> 3. `acp-telemetry-attempt-1.json` file is written to the session directory
> 4. No `run.sh` is called (only ACP prompt)

- [ ] **Step 2: Commit**

```bash
git add web/e2e/run-acp-lifecycle.test.ts
git commit -m "test(e2e): add ACP run lifecycle E2E test skeleton"
```

---

### Task 12: Phase 3 verification

- [ ] **Step 1: Run all unit tests**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/
```

Expected: ALL PASS

- [ ] **Step 2: Run full test suite**

```bash
cd web && npx vitest run
```

Expected: ALL PASS

- [ ] **Step 3: Verify run-pipeline.test.ts has no regressions (spec requirement #10)**

```bash
cd web && npx vitest run e2e/run-pipeline.test.ts
```

Expected: PASS — existing pack/import/register flow unchanged. If this E2E test requires Docker, run manually with Docker up.

- [ ] **Step 4: TypeScript compilation check**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors

> **Note on Verification #3 (DockerExecutor hijack mode integration test with real Docker):**
> Phase 1 tests use mocked Dockerode. A true integration test with real Docker requires a running Docker daemon and is deferred to Phase 4 agent onboarding, where each agent is smoke-tested in a real container. If CI has Docker available, consider adding an opt-in integration test in Phase 1 that spawns a real container, execs `echo hello` via InteractiveHandle, and verifies bidirectional streams work.

---

## Phase 4: Agent onboarding + Docker cleanup (future)

> Phase 4 is **out of scope for this plan** — it requires modifying `web/agents/runtime/Dockerfile` to install 6 agent CLIs (Cursor, Claude Code, Codex, OpenCode, Cline, KiloCode), per-agent smoke tests with real binaries, and deleting `web/agents/cursor/run.sh` + `web/agents/mock/run.sh`. This is infrastructure work that depends on:
>
> 1. Agent CLI availability and installation methods
> 2. API key provisioning for smoke tests
> 3. ACP compatibility testing per agent (some may reject `_meta` extension fields)
>
> Phase 4 should be planned separately after Phase 3 is verified in a real Docker environment.
>
> **Note:** `LaneConfig.env` and env plumbing (mentioned as Phase 4 prerequisite in the spec) is **already implemented** in the current codebase:
> - `LaneConfig` has `env?: Record<string, string>` (types.ts:204)
> - `POST /api/runs` reads executor secrets and passes `env: mergedEnv` (runs/route.ts:127)
> - `Scheduler.executeLane` passes `env: lane.env ?? {}` to `executor.start` (scheduler.ts:149)

---

## Verification Checklist (from spec)

| # | Verification | Phase | Task | Status |
|---|---|---|---|---|
| 1 | Unit: AcpSession with mocked ClientSideConnection | Phase 2 | Task 8 | Covered |
| 2 | Unit: `collect` with mock InteractiveHandle | Phase 1 | Task 3 | Covered |
| 3 | Integration: DockerExecutor hijack mode (real Docker) | Phase 1/4 | Task 4 (unit mocks); real Docker deferred to Phase 4 | Partial — see Note in Task 12 |
| 4 | Integration: Scheduler + InMemoryEventBus + mock AcpSession | Phase 3 | Task 10 | Covered |
| 5 | E2E: Full run lifecycle with mock ACP agent | Phase 3 | Task 11 | Skeleton — needs E2E harness |
| 6 | E2E: Model discovery via `collect` | Phase 1 | Task 6 (compile check) | Covered (compile) |
| 7 | E2E: Cancellation → session/cancel → graceful shutdown | Phase 3 | Task 10 (cancel mid-flight + task:cancelled assertions) | Covered |
| 8 | Unit: AcpSession.start failure → remaining scenarios get task:error | Phase 3 | Task 10 ("AcpSession.start fails" test) | Covered |
| — | Regression: run-pipeline.test.ts passes | Phase 3 | Task 12 step 3 | Covered |

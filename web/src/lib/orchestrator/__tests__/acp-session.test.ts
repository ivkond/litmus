import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { AgentExecutor, ExecutorHandle, InteractiveHandle, AcpAgentConfig } from '../types';

// ─── ACP SDK mock ──────────────────────────────────────────────
const acpMocks = vi.hoisted(() => {
  const mockInitialize = vi.fn().mockResolvedValue({
    protocolVersion: 1,
    agentInfo: { name: 'mock-agent', version: '1.0.0' },
  });
  const mockNewSession = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
  const mockPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn', usage: null });
  const mockCancel = vi.fn().mockResolvedValue(undefined);

  let clientFactory: ((agent: unknown) => unknown) | null = null;

  let lastInstance: {
    initialize: typeof mockInitialize;
    newSession: typeof mockNewSession;
    prompt: typeof mockPrompt;
    cancel: typeof mockCancel;
    closed: Promise<void>;
    signal: AbortSignal;
  } | null = null;

  // Must be a real class so `new` works
  class MockClientSideConnectionClass {
    initialize = mockInitialize;
    newSession = mockNewSession;
    prompt = mockPrompt;
    cancel = mockCancel;
    closed = new Promise<void>(() => {});
    signal = new AbortController().signal;

    constructor(toClient: (agent: unknown) => unknown, _stream: unknown) {
      clientFactory = toClient;
      lastInstance = this;
    }
  }
  const MockClientSideConnection = MockClientSideConnectionClass;

  return {
    mockInitialize,
    mockNewSession,
    mockPrompt,
    mockCancel,
    MockClientSideConnection,
    getClientFactory: () => clientFactory,
    getLastInstance: () => lastInstance,
  };
});

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn().mockReturnValue({ writable: {}, readable: {} }),
  ClientSideConnection: acpMocks.MockClientSideConnection,
}));

// ─── Helpers ───────────────────────────────────────────────────

function createMockInteractiveHandle(): InteractiveHandle {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    wait: vi.fn().mockResolvedValue(0),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExecutor(handle: InteractiveHandle): AgentExecutor {
  return {
    type: 'docker',
    start: vi.fn(),
    exec: vi.fn().mockResolvedValue(handle),
    stop: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

const defaultAcpConfig: AcpAgentConfig = {
  acpCmd: ['/usr/bin/acp-agent'],
  requiresAuth: false,
};

const defaultHandle: ExecutorHandle = { containerId: 'container-1' };

// ─── Tests ─────────────────────────────────────────────────────

describe('AcpSession', () => {
  let mockProc: InteractiveHandle;
  let mockExecutor: AgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = createMockInteractiveHandle();
    mockExecutor = createMockExecutor(mockProc);
  });

  // Lazy import so mocks are applied
  async function importModule() {
    return import('../acp-session');
  }

  describe('start', () => {
    it('test_start_validArgs_spawnsProcessAndInitializesConnection', async () => {
      const { AcpSession } = await importModule();

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);

      expect(session).toBeInstanceOf(AcpSession);
      expect(mockExecutor.exec).toHaveBeenCalledWith(defaultHandle, defaultAcpConfig.acpCmd);
      expect(acpMocks.mockInitialize).toHaveBeenCalledWith({
        protocolVersion: 1,
        clientInfo: { name: 'litmus', version: '1.0.0' },
        clientCapabilities: {},
      });
    });

    it('test_start_initializeFails_throwsError', async () => {
      const { AcpSession } = await importModule();
      acpMocks.mockInitialize.mockRejectedValueOnce(new Error('protocol mismatch'));

      await expect(
        AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig),
      ).rejects.toThrow('protocol mismatch');
    });
  });

  describe('prompt', () => {
    it('test_prompt_firstCall_createsSessionAndSendsPrompt', async () => {
      const { AcpSession } = await importModule();
      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);

      const result = await session.prompt({
        text: 'Fix the bug',
        cwd: '/work',
        scenarioDir: '/scenarios/s1',
      });

      expect(acpMocks.mockNewSession).toHaveBeenCalledWith({
        cwd: '/work',
        mcpServers: [],
      });
      expect(acpMocks.mockPrompt).toHaveBeenCalledWith({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'Fix the bug' }],
        _meta: { scenarioDir: '/scenarios/s1' },
      });
      expect(result.stopReason).toBe('end_turn');
      expect(result.content).toBe('');
      expect(result.toolCalls).toEqual([]);
    });

    it('test_prompt_secondCall_reusesSessionId', async () => {
      const { AcpSession } = await importModule();
      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);

      await session.prompt({ text: 'First', cwd: '/work', scenarioDir: '/s1' });
      await session.prompt({ text: 'Second', cwd: '/work', scenarioDir: '/s1' });

      // newSession called only once
      expect(acpMocks.mockNewSession).toHaveBeenCalledTimes(1);
      // prompt called twice
      expect(acpMocks.mockPrompt).toHaveBeenCalledTimes(2);
      expect(acpMocks.mockPrompt).toHaveBeenNthCalledWith(2, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'Second' }],
        _meta: { scenarioDir: '/s1' },
      });
    });

    it('test_prompt_maxTokensStopReason_mapsToRetryableResult', async () => {
      const { AcpSession } = await importModule();
      acpMocks.mockPrompt.mockResolvedValueOnce({ stopReason: 'max_tokens', usage: null });

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      const result = await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      expect(result.stopReason).toBe('max_tokens');
    });

    it('test_prompt_refusalStopReason_mapsToNonRetryableResult', async () => {
      const { AcpSession } = await importModule();
      acpMocks.mockPrompt.mockResolvedValueOnce({ stopReason: 'refusal', usage: null });

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      const result = await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      expect(result.stopReason).toBe('refusal');
    });

    it('test_prompt_withTimeout_cancelledOnTimeout', async () => {
      const { AcpSession } = await importModule();

      // prompt that never resolves
      acpMocks.mockPrompt.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      acpMocks.mockCancel.mockResolvedValueOnce(undefined);

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      const result = await session.prompt({
        text: 'Go',
        cwd: '/work',
        scenarioDir: '/s',
        timeoutMs: 50,
      });

      expect(result.stopReason).toBe('cancelled');
    });

    it('test_prompt_withUsage_mapsUsageAndDuration', async () => {
      const { AcpSession } = await importModule();
      acpMocks.mockPrompt.mockResolvedValueOnce({
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedReadTokens: 10,
          cachedWriteTokens: 5,
          thoughtTokens: 20,
        },
      });

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      const result = await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      expect(result.usage).toBeDefined();
      expect(result.usage!.inputTokens).toBe(100);
      expect(result.usage!.outputTokens).toBe(50);
      expect(result.usage!.totalTokens).toBe(150);
      expect(result.usage!.cachedReadTokens).toBe(10);
      expect(result.usage!.cachedWriteTokens).toBe(5);
      expect(result.usage!.thoughtTokens).toBe(20);
      expect(result.usage!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('test_prompt_sessionUpdateAccumulatesContent', async () => {
      const { AcpSession } = await importModule();

      // Make prompt call the client sessionUpdate before resolving
      acpMocks.mockPrompt.mockImplementationOnce(async () => {
        const factory = acpMocks.getClientFactory();
        const client = factory!({}) as { sessionUpdate: (p: unknown) => Promise<void> };

        await client.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello ' },
          },
        });
        await client.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'World' },
          },
        });

        return { stopReason: 'end_turn', usage: null };
      });

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      const result = await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      expect(result.content).toBe('Hello World');
    });

    it('test_prompt_sessionUpdateAccumulatesToolCalls', async () => {
      const { AcpSession } = await importModule();

      acpMocks.mockPrompt.mockImplementationOnce(async () => {
        const factory = acpMocks.getClientFactory();
        const client = factory!({}) as { sessionUpdate: (p: unknown) => Promise<void> };

        await client.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'read_file',
            status: 'completed',
            rawInput: { path: '/foo.ts' },
            rawOutput: 'file content',
          },
        });

        return { stopReason: 'end_turn', usage: null };
      });

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      const result = await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        name: 'read_file',
        status: 'completed',
        input: { path: '/foo.ts' },
        output: 'file content',
      });
    });
  });

  describe('resetSession', () => {
    it('test_resetSession_afterPrompt_nextPromptCreatesNewSession', async () => {
      const { AcpSession } = await importModule();
      acpMocks.mockNewSession
        .mockResolvedValueOnce({ sessionId: 'session-1' })
        .mockResolvedValueOnce({ sessionId: 'session-2' });

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      await session.prompt({ text: 'First', cwd: '/work', scenarioDir: '/s' });

      session.resetSession();
      await session.prompt({ text: 'Second', cwd: '/work', scenarioDir: '/s' });

      expect(acpMocks.mockNewSession).toHaveBeenCalledTimes(2);
      expect(acpMocks.mockPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
        sessionId: 'session-2',
      }));
    });
  });

  describe('cancel', () => {
    it('test_cancel_withActiveSession_sendsCancelNotification', async () => {
      const { AcpSession } = await importModule();
      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      await session.cancel();

      expect(acpMocks.mockCancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('test_cancel_noSession_doesNothing', async () => {
      const { AcpSession } = await importModule();
      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);

      await session.cancel();

      expect(acpMocks.mockCancel).not.toHaveBeenCalled();
    });

    it('test_cancel_timeout_forceKillsProcess', async () => {
      const { AcpSession } = await importModule();
      // cancel never resolves
      acpMocks.mockCancel.mockImplementationOnce(() => new Promise(() => {}));

      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);
      await session.prompt({ text: 'Go', cwd: '/work', scenarioDir: '/s' });

      // Override internal cancel timeout to be short for test
      await session.cancel(100);

      expect(mockProc.kill).toHaveBeenCalled();
    }, 10_000);
  });

  describe('close', () => {
    it('test_close_normalFlow_closesStdinAndAwaitsExit', async () => {
      const { AcpSession } = await importModule();
      const session = await AcpSession.start(mockExecutor, defaultHandle, defaultAcpConfig);

      // Make connection.closed resolve immediately for this test
      const connInstance = acpMocks.getLastInstance()!;
      connInstance.closed = Promise.resolve();

      await session.close();

      // Stdin should be ended
      expect((mockProc.stdin as PassThrough).destroyed || (mockProc.stdin as PassThrough).writableEnded).toBe(true);
      expect(mockProc.wait).toHaveBeenCalled();
    });
  });
});

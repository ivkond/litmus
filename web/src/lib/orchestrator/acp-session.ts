import { Writable, Readable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentExecutor,
  ExecutorHandle,
  InteractiveHandle,
  AcpAgentConfig,
  AgentResult,
  AgentToolCall,
} from './types';

// ─── Params ────────────────────────────────────────────────────

export interface PromptParams {
  text: string;
  cwd: string;
  scenarioDir: string;
  timeoutMs?: number;
}

// ─── AcpSession ────────────────────────────────────────────────

export class AcpSession {
  private connection: acp.ClientSideConnection;
  private proc: InteractiveHandle;
  private sessionId: string | null = null;

  // Per-turn accumulators (reset on each prompt call)
  private content = '';
  private toolCalls: AgentToolCall[] = [];

  private constructor(connection: acp.ClientSideConnection, proc: InteractiveHandle) {
    this.connection = connection;
    this.proc = proc;
  }

  // ── Factory ────────────────────────────────────────────────

  static async start(
    executor: AgentExecutor,
    handle: ExecutorHandle,
    acpConfig: AcpAgentConfig,
  ): Promise<AcpSession> {
    const proc = await executor.exec(handle, acpConfig.acpCmd);

    const stdinWeb = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const stdoutWeb = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);

    let session: AcpSession;

    const connection = new acp.ClientSideConnection((_agent) => {
      // The client object handles incoming notifications from the agent
      return {
        sessionUpdate: async (notification: acp.SessionNotification) => {
          session.handleSessionUpdate(notification);
        },
        requestPermission: async () => ({ outcome: 'allowed' as const }),
      };
    }, stream);

    session = new AcpSession(connection, proc);

    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'litmus', version: '1.0.0' },
      clientCapabilities: {},
    });

    return session;
  }

  // ── Prompt ─────────────────────────────────────────────────

  async prompt(params: PromptParams): Promise<AgentResult> {
    // Reset per-turn accumulators
    this.content = '';
    this.toolCalls = [];

    // Create session if needed
    if (!this.sessionId) {
      const resp = await this.connection.newSession({
        cwd: params.cwd,
        mcpServers: [],
      });
      this.sessionId = resp.sessionId;
    }

    const startMs = Date.now();

    const promptCall = this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text' as const, text: params.text }],
      _meta: { scenarioDir: params.scenarioDir },
    });

    let response: acp.PromptResponse;

    if (params.timeoutMs && params.timeoutMs > 0) {
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), params.timeoutMs),
      );

      const raceResult = await Promise.race([
        promptCall.then((r) => ({ kind: 'response' as const, value: r })),
        timeoutPromise.then(() => ({ kind: 'timeout' as const })),
      ]);

      if (raceResult.kind === 'timeout') {
        await this.cancel();
        return {
          stopReason: 'cancelled',
          content: this.content,
          toolCalls: this.toolCalls,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: Date.now() - startMs },
        };
      }

      response = (raceResult as { kind: 'response'; value: acp.PromptResponse }).value;
    } else {
      response = await promptCall;
    }

    const durationMs = Date.now() - startMs;
    return this.mapResponse(response, durationMs);
  }

  // ── Session management ─────────────────────────────────────

  resetSession(): void {
    this.sessionId = null;
  }

  async cancel(timeoutMs = 5000): Promise<void> {
    if (!this.sessionId) return;

    const cancelPromise = this.connection.cancel({ sessionId: this.sessionId });
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs),
    );

    const result = await Promise.race([
      cancelPromise.then(() => 'done' as const),
      timeoutPromise,
    ]);

    if (result === 'timeout') {
      await this.proc.kill();
    }
  }

  async close(): Promise<void> {
    (this.proc.stdin as import('stream').Writable).end();

    const safetyTimeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));

    await Promise.race([
      Promise.all([this.connection.closed, this.proc.wait()]),
      safetyTimeout,
    ]);
  }

  // ── Private: notification handler ──────────────────────────

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    const update = notification.update;

    if (update.sessionUpdate === 'agent_message_chunk') {
      const chunk = update as acp.ContentChunk & { sessionUpdate: string };
      if (chunk.content && 'text' in chunk.content && typeof chunk.content.text === 'string') {
        this.content += chunk.content.text;
      }
    } else if (update.sessionUpdate === 'tool_call') {
      const tc = update as acp.ToolCall & { sessionUpdate: string };
      this.toolCalls.push({
        name: tc.title,
        status: (tc.status === 'completed' || tc.status === 'failed') ? tc.status : 'completed',
        input: (tc.rawInput as Record<string, unknown>) ?? {},
        output: typeof tc.rawOutput === 'string' ? tc.rawOutput : undefined,
      });
    }
  }

  // ── Private: response mapping ──────────────────────────────

  private mapResponse(response: acp.PromptResponse, durationMs: number): AgentResult {
    const validReasons: AgentResult['stopReason'][] = [
      'end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled',
    ];

    const stopReason: AgentResult['stopReason'] = validReasons.includes(response.stopReason as AgentResult['stopReason'])
      ? (response.stopReason as AgentResult['stopReason'])
      : 'error';

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
      stopReason,
      content: this.content,
      toolCalls: this.toolCalls,
      usage,
    };
  }
}

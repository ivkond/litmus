import { describe, expectTypeOf, it } from 'vitest';
import type { Writable, Readable } from 'stream';
import type {
  InteractiveHandle,
  AgentResult,
  AgentToolCall,
  AcpAgentConfig,
  AgentExecutor,
  ExecutorHandle,
  ExecResult,
  InteractiveHandle as InteractiveHandleAlias,
} from '../types';

describe('InteractiveHandle', () => {
  it('has stdin as Writable', () => {
    expectTypeOf<InteractiveHandle['stdin']>().toEqualTypeOf<Writable>();
  });

  it('has stdout as Readable', () => {
    expectTypeOf<InteractiveHandle['stdout']>().toEqualTypeOf<Readable>();
  });

  it('has stderr as Readable', () => {
    expectTypeOf<InteractiveHandle['stderr']>().toEqualTypeOf<Readable>();
  });

  it('wait() returns Promise<number>', () => {
    expectTypeOf<InteractiveHandle['wait']>().toEqualTypeOf<() => Promise<number>>();
  });

  it('kill() returns Promise<void>', () => {
    expectTypeOf<InteractiveHandle['kill']>().toEqualTypeOf<() => Promise<void>>();
  });
});

describe('AgentToolCall', () => {
  it('has name as string', () => {
    expectTypeOf<AgentToolCall['name']>().toBeString();
  });

  it('has status as completed | failed', () => {
    expectTypeOf<AgentToolCall['status']>().toEqualTypeOf<'completed' | 'failed'>();
  });

  it('has input as Record<string, unknown>', () => {
    expectTypeOf<AgentToolCall['input']>().toEqualTypeOf<Record<string, unknown>>();
  });

  it('has optional output as string', () => {
    expectTypeOf<AgentToolCall['output']>().toEqualTypeOf<string | undefined>();
  });
});

describe('AgentResult', () => {
  it('has stopReason as union of known reasons', () => {
    expectTypeOf<AgentResult['stopReason']>().toEqualTypeOf<
      'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error'
    >();
  });

  it('has content as string', () => {
    expectTypeOf<AgentResult['content']>().toBeString();
  });

  it('has toolCalls as AgentToolCall[]', () => {
    expectTypeOf<AgentResult['toolCalls']>().toEqualTypeOf<AgentToolCall[]>();
  });

  it('has optional usage with token fields', () => {
    type Usage = NonNullable<AgentResult['usage']>;
    expectTypeOf<Usage['inputTokens']>().toBeNumber();
    expectTypeOf<Usage['outputTokens']>().toBeNumber();
    expectTypeOf<Usage['totalTokens']>().toBeNumber();
    expectTypeOf<Usage['durationMs']>().toBeNumber();
    expectTypeOf<Usage['cachedReadTokens']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Usage['cachedWriteTokens']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Usage['thoughtTokens']>().toEqualTypeOf<number | undefined>();
  });
});

describe('AcpAgentConfig', () => {
  it('has acpCmd as string[]', () => {
    expectTypeOf<AcpAgentConfig['acpCmd']>().toEqualTypeOf<string[]>();
  });

  it('has requiresAuth as boolean', () => {
    expectTypeOf<AcpAgentConfig['requiresAuth']>().toBeBoolean();
  });

  it('has optional capabilities as Record<string, unknown>', () => {
    expectTypeOf<AcpAgentConfig['capabilities']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >();
  });
});

describe('AgentExecutor.exec return type', () => {
  it('returns Promise<InteractiveHandle>', () => {
    type ExecReturn = ReturnType<AgentExecutor['exec']>;
    expectTypeOf<ExecReturn>().toEqualTypeOf<Promise<InteractiveHandle>>();
  });
});

describe('ExecResult still exists', () => {
  it('has exitCode, stdout, stderr', () => {
    expectTypeOf<ExecResult['exitCode']>().toBeNumber();
    expectTypeOf<ExecResult['stdout']>().toBeString();
    expectTypeOf<ExecResult['stderr']>().toBeString();
  });
});

// ─── Executor Interface ────────────────────────────────────────

export interface AgentExecutor {
  type: 'docker' | 'host' | 'kubernetes';
  start(config: ExecutorConfig): Promise<ExecutorHandle>;
  exec(handle: ExecutorHandle, cmd: string[], options?: ExecOptions): Promise<InteractiveHandle>;
  stop(handle: ExecutorHandle): Promise<void>;
  healthCheck(): Promise<boolean>;
  /** Verify that the runtime image exists locally. Returns false if image is not found. */
  checkImage?(image: string): Promise<boolean>;
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
  /** Accumulated text output from session/update notifications during the prompt turn */
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
  /** Paths inside container (relative to /root) that hold credential files */
  credentialPaths?: string[];
}

export interface ExecutorConfig {
  image: string;
  agentHostDir: string;
  sharedScriptsDir?: string;
  workHostDir: string;
  runId: string;
  env: Record<string, string>;
  labels?: Record<string, string>;
  limits?: { memory: number; cpus: number };
  network?: string;
}

// ─── Reconciler ────────────────────────────────────────────────

export interface EvalResult {
  allPassed: boolean;
  testsPassed: number;
  testsTotal: number;
  totalScore: number;
  testOutput: string;
  details: TestDetail[];
  attempt?: number;      // final attempt number (set by scheduler before finalize)
  maxAttempts?: number;  // total attempts allowed (set by scheduler before finalize)
}

export interface TestDetail {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  message: string;
}

export interface TaskMeta {
  runId: string;
  taskId: string;
  agentId: string;
  modelId: string;
  scenarioId: string;
  agentSlug: string;
  modelSlug: string;
  scenarioSlug: string;
  attempt: number;
  maxAttempts: number;
  startedAt: Date;
}

// ─── SSE Events ────────────────────────────────────────────────

export type RunEvent =
  | TaskStartedEvent
  | TaskRetryingEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskErrorEvent
  | TaskCancelledEvent
  | ContainerFinishedEvent
  | RunCompletedEvent
  | RunCancelledEvent;

export interface TaskStartedEvent {
  type: 'task:started';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  timestamp: string;
}

export interface TaskRetryingEvent {
  type: 'task:retrying';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  testOutput: string;
}

export interface TaskCompletedEvent {
  type: 'task:completed';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  score: number;
  testsPassed: number;
  testsTotal: number;
  duration: number;
  final: true;
}

export interface TaskFailedEvent {
  type: 'task:failed';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  attempt: number;
  maxAttempts: number;
  score: number;
  errorMessage: string;
  final: true;
}

export interface TaskErrorEvent {
  type: 'task:error';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
  errorMessage: string;
}

export interface TaskCancelledEvent {
  type: 'task:cancelled';
  runId: string;
  taskId: string;
  agent: string;
  model: string;
  scenario: string;
}

export interface ContainerFinishedEvent {
  type: 'container:finished';
  runId: string;
  agent: string;
  model: string;
  completedCount: number;
  failedCount: number;
  errorCount: number;
}

export interface RunCompletedEvent {
  type: 'run:completed';
  runId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  errorTasks: number;
  cancelledTasks: number;
}

export interface RunCancelledEvent {
  type: 'run:cancelled';
  runId: string;
  completedTasks: number;
  cancelledTasks: number;
}

// ─── Scheduler ─────────────────────────────────────────────────

export interface RunConfig {
  runId: string;
  lanes: LaneConfig[];
  maxRetries: number;
  maxConcurrentLanes: number;
  /** Per-step timeout in seconds. 0 = no timeout (default). Applied to ACP agent prompts (triggers session/cancel) and shell commands via collect (triggers kill + exit 124). */
  stepTimeoutSeconds: number;
  /** Map from composite key "executorId:modelId:scenarioId" → run_tasks.id (DB UUID) */
  taskIds: Map<string, string>;
}

export interface LaneConfig {
  agent: { id: string; slug: string; type: string; name: string };
  model: { id: string; name: string; externalId: string };
  executorId: string;
  scenarios: { id: string; slug: string; prompt: string; language: string }[];
  env?: Record<string, string>;
}

import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  boolean,
} from 'drizzle-orm/pg-core';

// ─── Reference Tables ───────────────────────────────────────────

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  version: text('version'),
  availableModels: jsonb('available_models').default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** API-level model identifier passed to agent CLI, e.g. "claude-sonnet-4-20250514" */
  externalId: text('external_id'),
  provider: text('provider'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const scenarios = pgTable('scenarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version').default('v1'),
  language: text('language'),
  tags: text('tags').array(),
  maxScore: integer('max_score'),
  prompt: text('prompt'),
  task: text('task'),
  scoring: text('scoring'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── Run Tables ─────────────────────────────────────────────────

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status', {
    enum: ['pending', 'running', 'completed', 'failed', 'error', 'cancelled'],
  }).default('pending').notNull(),
  configSnapshot: jsonb('config_snapshot'),
});

export const runResults = pgTable('run_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  modelId: uuid('model_id').notNull().references(() => models.id),
  scenarioId: uuid('scenario_id').notNull().references(() => scenarios.id),
  agentVersion: text('agent_version'),
  scenarioVersion: text('scenario_version'),
  status: text('status', {
    enum: ['completed', 'failed', 'error'],
  }).default('completed').notNull(),
  testsPassed: integer('tests_passed').notNull().default(0),
  testsTotal: integer('tests_total').notNull().default(0),
  totalScore: real('total_score').notNull().default(0),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  attempt: integer('attempt').notNull().default(1),
  maxAttempts: integer('max_attempts').notNull().default(1),
  judgeScores: jsonb('judge_scores'),
  judgeStatus: text('judge_status').default('pending'),
  blockingFlags: jsonb('blocking_flags'),
  compositeScore: real('composite_score'),
  judgeMeta: jsonb('judge_meta'),
  evaluationVersion: integer('evaluation_version').default(1).notNull(),
  artifactsS3Key: text('artifacts_s3_key'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_run_results_run').on(table.runId),
  index('idx_run_results_agent_model').on(table.agentId, table.modelId),
  index('idx_run_results_scenario').on(table.scenarioId),
  uniqueIndex('idx_run_results_unique_combo').on(
    table.runId, table.agentId, table.modelId, table.scenarioId,
  ),
]);

// ─── Agent Orchestration ────────────────────────────────────────

export const agentExecutors = pgTable('agent_executors', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  type: text('type', {
    enum: ['docker', 'host', 'kubernetes'],
  }).notNull(),
  agentSlug: text('agent_slug').notNull(),
  agentType: text('agent_type').notNull().default('mock'),
  binaryPath: text('binary_path'),
  healthCheck: text('health_check'),
  config: jsonb('config').default({}),
  authMethods: jsonb('auth_methods'),
  authMethodsDiscoveredAt: timestamp('auth_methods_discovered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const agentSecrets = pgTable('agent_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentExecutorId: uuid('agent_executor_id').notNull().references(() => agentExecutors.id, { onDelete: 'cascade' }),
  acpMethodId: text('acp_method_id').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  authType: text('auth_type', { enum: ['api_key', 'credential_files'] }).notNull(),
  credentialPaths: jsonb('credential_paths'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('idx_agent_secrets_unique').on(table.agentExecutorId, table.acpMethodId),
]);

export const runTasks = pgTable('run_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  agentExecutorId: uuid('agent_executor_id').notNull().references(() => agentExecutors.id),
  modelId: uuid('model_id').notNull().references(() => models.id),
  scenarioId: uuid('scenario_id').notNull().references(() => scenarios.id),
  status: text('status', {
    enum: ['pending', 'running', 'completed', 'failed', 'error', 'cancelled'],
  }).default('pending').notNull(),
  containerId: text('container_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  exitCode: integer('exit_code'),
  errorMessage: text('error_message'),
}, (table) => [
  index('idx_run_tasks_run').on(table.runId),
  index('idx_run_tasks_status').on(table.status),
]);

// ─── Judge System Tables ─────────────────────────────────────────

export const judgeProviders = pgTable('judge_providers', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(), // encrypted at rest
  model: text('model').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  priority: integer('priority').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const judgeVerdicts = pgTable(
  'judge_verdicts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runResultId: uuid('run_result_id')
      .references(() => runResults.id, { onDelete: 'cascade' })
      .notNull(),
    judgeProviderId: uuid('judge_provider_id')
      .references(() => judgeProviders.id)
      .notNull(),
    scores: jsonb('scores').notNull(), // { criteria_key: { score, rationale } }
    blockingFlags: jsonb('blocking_flags').notNull(), // { flag_key: { triggered, rationale } }
    rawResponse: text('raw_response'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    evaluationVersion: integer('evaluation_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('judge_verdicts_unique').on(
      table.runResultId,
      table.judgeProviderId,
      table.evaluationVersion
    ),
  ]
);

export const compressionLogs = pgTable(
  'compression_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runResultId: uuid('run_result_id')
      .references(() => runResults.id, { onDelete: 'cascade' })
      .notNull(),
    inputChars: integer('input_chars').notNull(),
    outputChars: integer('output_chars').notNull(),
    ratio: real('ratio').notNull(),
    compressorType: text('compressor_type').notNull(),
    durationMs: integer('duration_ms'),
    evaluationVersion: integer('evaluation_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('compression_logs_unique').on(
      table.runResultId,
      table.evaluationVersion
    ),
  ]
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Type Exports ───────────────────────────────────────────────

export type Agent = typeof agents.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunResult = typeof runResults.$inferSelect;
export type AgentExecutor = typeof agentExecutors.$inferSelect;
export type AgentSecret = typeof agentSecrets.$inferSelect;
export type RunTask = typeof runTasks.$inferSelect;
export type JudgeProvider = typeof judgeProviders.$inferSelect;
export type JudgeVerdict = typeof judgeVerdicts.$inferSelect;
export type CompressionLog = typeof compressionLogs.$inferSelect;
export type Setting = typeof settings.$inferSelect;

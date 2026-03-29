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
  judgeModel: text('judge_model'),
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
  binaryPath: text('binary_path'),
  healthCheck: text('health_check'),
  config: jsonb('config').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

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

// ─── Type Exports ───────────────────────────────────────────────

export type Agent = typeof agents.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunResult = typeof runResults.$inferSelect;
export type AgentExecutor = typeof agentExecutors.$inferSelect;
export type RunTask = typeof runTasks.$inferSelect;

import { z } from 'zod';

// --- Criterion & blocking check definitions ---

export interface CriterionDef {
  key: string;
  title: string;
  description: string;
}

export interface BlockingCheckDef {
  key: string;
  title: string;
  description: string;
}

// --- Judge verdict (single provider response) ---

export interface JudgeCriterionScore {
  score: number; // 1-5
  rationale: string;
}

export interface JudgeBlockingFlag {
  triggered: boolean;
  rationale: string;
}

export interface JudgeResponse {
  scores: Record<string, JudgeCriterionScore>;
  blocking: Record<string, JudgeBlockingFlag>;
}

const REQUIRED_CRITERIA_KEYS = [
  'task_success', 'solution_correctness', 'instruction_following',
  'design_quality', 'tool_action_quality', 'reasoning_diagnosis',
  'recovery_adaptivity', 'safety_scope_control', 'context_state_handling',
  'verification_awareness',
] as const;

const REQUIRED_BLOCKING_KEYS = [
  'hard_instruction_violation', 'unsafe_or_out_of_scope_change',
  'invalid_solution_artifact', 'incorrect_final_state',
] as const;

const criterionScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  rationale: z.string(),
});

const blockingFlagSchema = z.object({
  triggered: z.boolean(),
  rationale: z.string(),
});

export const judgeResponseSchema = z.object({
  scores: z.record(z.string(), criterionScoreSchema)
    .refine(
      (scores) => REQUIRED_CRITERIA_KEYS.every((k) => k in scores),
      { message: `scores must contain all 10 criteria keys: ${REQUIRED_CRITERIA_KEYS.join(', ')}` }
    ),
  blocking: z.record(z.string(), blockingFlagSchema)
    .refine(
      (blocking) => REQUIRED_BLOCKING_KEYS.every((k) => k in blocking),
      { message: `blocking must contain all 4 check keys: ${REQUIRED_BLOCKING_KEYS.join(', ')}` }
    ),
});

// --- Aggregated result ---

export interface AggregatedScores {
  medianScores: Record<string, number>;
  blockingFlags: Record<string, boolean>;
  judgeWeighted: number;
  judgeNormalized: number;
  compositeScore: number;
  blockingCount: number;
  confidence: 'normal' | 'lowConfidence';
}

// --- Judge task payload (Redis Stream message) ---

export interface JudgeTaskPayload {
  runResultId: string;
  providerId: string;
  evaluationVersion: number;
}

// --- Judge meta (stored in run_results.judgeMeta) ---

export interface JudgeMeta {
  targetProviderIds: string[];
  partial?: boolean;
  succeeded?: number;
  failed?: number;
  lowConfidence?: boolean;
  allFailed?: boolean;
}

// --- Settings Zod schemas ---

export const compositeWeightsSchema = z
  .object({
    test: z.number().positive(),
    judge: z.number().positive(),
  })
  .refine((v) => Math.abs(v.test + v.judge - 1.0) < 0.001, {
    message: 'test + judge must equal 1.0',
  });

const VALID_CRITERIA_KEYS = [
  'task_success', 'solution_correctness', 'instruction_following',
  'design_quality', 'tool_action_quality', 'reasoning_diagnosis',
  'recovery_adaptivity', 'safety_scope_control', 'context_state_handling',
  'verification_awareness',
] as const;

export const criteriaPrioritySchema = z.object({
  order: z
    .array(z.enum(VALID_CRITERIA_KEYS))
    .length(10)
    .refine(
      (arr) => new Set(arr).size === 10,
      { message: 'All 10 unique criteria keys must be present' }
    ),
  preset: z.enum(['flat', 'linear', 'steep']),
});

export const blockingCapsSchema = z.object({
  '1': z.number().int().min(0).max(100),
  '2': z.number().int().min(0).max(100),
});

export type WeightPreset = 'flat' | 'linear' | 'steep';

// Settings key → Zod schema map
export const settingsSchemas: Record<string, z.ZodType> = {
  composite_weights: compositeWeightsSchema,
  criteria_priority: criteriaPrioritySchema,
  blocking_caps: blockingCapsSchema,
  judge_max_retries: z.number().int().min(1).max(10),
  judge_max_concurrent_per_provider: z.number().int().min(1).max(20),
  judge_max_concurrent_global: z.number().int().min(1).max(50),
  judge_temperature: z.number().min(0).max(1),
  log_compression: z.enum(['structured', 'none']),
  max_compressed_chars: z.number().int().min(1000).max(200000),
  max_judge_prompt_chars: z.number().int().min(10000).max(500000),
  judge_task_idle_timeout_ms: z.number().int().min(60000).max(1800000),
  judge_raw_response_retention_days: z.number().int().min(1).max(365),
  general_theme: z.enum(['light', 'dark', 'system']),
  general_auto_judge: z.boolean(),
  general_max_concurrent_lanes: z.number().int().min(1).max(10),
};

// Default values for all settings
export const settingsDefaults: Record<string, unknown> = {
  composite_weights: { test: 0.4, judge: 0.6 },
  criteria_priority: {
    order: [
      'task_success',
      'solution_correctness',
      'instruction_following',
      'design_quality',
      'tool_action_quality',
      'reasoning_diagnosis',
      'recovery_adaptivity',
      'safety_scope_control',
      'context_state_handling',
      'verification_awareness',
    ],
    preset: 'linear',
  },
  blocking_caps: { '1': 60, '2': 40 },
  judge_max_retries: 3,
  judge_max_concurrent_per_provider: 3,
  judge_max_concurrent_global: 10,
  judge_temperature: 0.3,
  log_compression: 'structured',
  max_compressed_chars: 30000,
  max_judge_prompt_chars: 120000,
  judge_task_idle_timeout_ms: 300000,
  judge_raw_response_retention_days: 90,
  general_theme: 'dark',
  general_auto_judge: false,
  general_max_concurrent_lanes: 3,
};

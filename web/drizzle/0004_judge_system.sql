-- New tables
CREATE TABLE IF NOT EXISTS judge_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_result_id UUID NOT NULL REFERENCES run_results(id) ON DELETE CASCADE,
  judge_provider_id UUID NOT NULL REFERENCES judge_providers(id),
  scores JSONB NOT NULL,
  blocking_flags JSONB NOT NULL,
  raw_response TEXT,
  duration_ms INTEGER,
  error TEXT,
  evaluation_version INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT now() NOT NULL,
  UNIQUE(run_result_id, judge_provider_id, evaluation_version)
);

CREATE TABLE IF NOT EXISTS compression_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_result_id UUID NOT NULL REFERENCES run_results(id) ON DELETE CASCADE,
  input_chars INTEGER NOT NULL,
  output_chars INTEGER NOT NULL,
  ratio REAL NOT NULL,
  compressor_type TEXT NOT NULL,
  duration_ms INTEGER,
  evaluation_version INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT now() NOT NULL,
  UNIQUE(run_result_id, evaluation_version)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now() NOT NULL
);

-- Modify run_results: add new columns, drop judgeModel
ALTER TABLE run_results
  ADD COLUMN IF NOT EXISTS judge_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS blocking_flags JSONB,
  ADD COLUMN IF NOT EXISTS composite_score REAL,
  ADD COLUMN IF NOT EXISTS judge_meta JSONB,
  ADD COLUMN IF NOT EXISTS evaluation_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE run_results DROP COLUMN IF EXISTS judge_model;

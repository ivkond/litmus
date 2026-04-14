-- Phase 1: ACP Auth Integration — Schema migration
-- Adds auth discovery cache to agent_executors and migrates agent_secrets
-- from envVar-keyed to acpMethodId-keyed storage.

BEGIN;

-- 1. Add auth discovery cache columns to agent_executors
ALTER TABLE agent_executors
  ADD COLUMN IF NOT EXISTS auth_methods JSONB,
  ADD COLUMN IF NOT EXISTS auth_methods_discovered_at TIMESTAMPTZ;

-- 2. Add new columns to agent_secrets
ALTER TABLE agent_secrets
  ADD COLUMN IF NOT EXISTS acp_method_id TEXT,
  ADD COLUMN IF NOT EXISTS credential_paths JSONB;

-- 3. Backfill acp_method_id from env_var for existing rows
-- Uses env_var as the method ID during transition (e.g. "CURSOR_API_KEY")
UPDATE agent_secrets
SET acp_method_id = env_var
WHERE acp_method_id IS NULL;

-- 4. Make acp_method_id NOT NULL now that all rows have values
ALTER TABLE agent_secrets
  ALTER COLUMN acp_method_id SET NOT NULL;

-- 4b. Rename legacy auth_type='oauth' to new semantics 'credential_files'
UPDATE agent_secrets SET auth_type = 'credential_files' WHERE auth_type = 'oauth';

-- 5. Drop the auto-generated unique constraint on env_var
-- Migration 0005 used inline UNIQUE(agent_executor_id, env_var) which Postgres
-- auto-names `agent_secrets_agent_executor_id_env_var_key`.
ALTER TABLE agent_secrets DROP CONSTRAINT IF EXISTS agent_secrets_agent_executor_id_env_var_key;

-- 6. Drop any previously-created named unique index (safe on retry),
-- then create the new named unique index.
DROP INDEX IF EXISTS idx_agent_secrets_unique;
CREATE UNIQUE INDEX idx_agent_secrets_unique ON agent_secrets (agent_executor_id, acp_method_id);

-- 7. Drop env_var column (data preserved in acp_method_id via step 3)
ALTER TABLE agent_secrets
  DROP COLUMN IF EXISTS env_var;

COMMIT;

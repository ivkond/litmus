CREATE TABLE IF NOT EXISTS agent_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_executor_id UUID NOT NULL REFERENCES agent_executors(id) ON DELETE CASCADE,
  env_var TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_executor_id, env_var)
);

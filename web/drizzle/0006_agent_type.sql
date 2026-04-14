ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS agent_type TEXT NOT NULL DEFAULT 'mock';
-- Backfill: assume existing slugs match directory names
UPDATE agent_executors SET agent_type = agent_slug WHERE agent_type = 'mock' AND agent_slug != 'mock';

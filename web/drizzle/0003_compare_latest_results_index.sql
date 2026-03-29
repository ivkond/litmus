CREATE INDEX "idx_run_results_latest_wins"
  ON "run_results" USING btree ("agent_id", "model_id", "scenario_id", "created_at" DESC)
  WHERE "status" IN ('completed', 'failed');

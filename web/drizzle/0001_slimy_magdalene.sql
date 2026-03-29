ALTER TABLE "agents" ADD COLUMN "available_models" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "run_results" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_results" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;
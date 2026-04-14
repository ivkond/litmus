CREATE TABLE "agent_executors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"agent_slug" text NOT NULL,
	"binary_path" text,
	"health_check" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agents_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "models_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"agent_version" text,
	"scenario_version" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"tests_passed" integer DEFAULT 0 NOT NULL,
	"tests_total" integer DEFAULT 0 NOT NULL,
	"total_score" real DEFAULT 0 NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"judge_scores" jsonb,
	"judge_model" text,
	"artifacts_s3_key" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "run_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_executor_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"container_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"config_snapshot" jsonb
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" text DEFAULT 'v1',
	"language" text,
	"tags" text[],
	"max_score" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "scenarios_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agent_executors" ADD CONSTRAINT "agent_executors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_agent_executor_id_agent_executors_id_fk" FOREIGN KEY ("agent_executor_id") REFERENCES "public"."agent_executors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_results_run" ON "run_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_run_results_agent_model" ON "run_results" USING btree ("agent_id","model_id");--> statement-breakpoint
CREATE INDEX "idx_run_results_scenario" ON "run_results" USING btree ("scenario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_results_unique_combo" ON "run_results" USING btree ("run_id","agent_id","model_id","scenario_id");--> statement-breakpoint
CREATE INDEX "idx_run_tasks_run" ON "run_tasks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_run_tasks_status" ON "run_tasks" USING btree ("status");
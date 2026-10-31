CREATE TABLE "job_logs" (
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_logs_job_id_seq_pk" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"parent_job_id" uuid,
	"playlist_index" integer,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"url" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipe" jsonb,
	"inputs" jsonb,
	"destination" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"error_code" text,
	"error_message" text,
	"total_items" integer DEFAULT 0 NOT NULL,
	"completed_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cost_estimate" integer,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"extractor" text NOT NULL,
	"media_id" text NOT NULL,
	"preset" text NOT NULL,
	"options_hash" text NOT NULL,
	"job_id" uuid,
	"path" text NOT NULL,
	"size_bytes" bigint,
	"mime" text,
	"title" text,
	"duration_s" real,
	"probe" jsonb,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"is_directory" boolean DEFAULT false NOT NULL,
	"mime" text,
	"size_bytes" bigint,
	"duration_s" real,
	"probe" jsonb,
	"media_file_id" uuid,
	"drive_file_id" text,
	"drive_link" text,
	"drive_folder_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_media_file_id_media_files_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_owner_created_idx" ON "jobs" USING btree ("client_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_parent_idx" ON "jobs" USING btree ("parent_job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_key_idx" ON "media_files" USING btree ("extractor","media_id","preset","options_hash");--> statement-breakpoint
CREATE INDEX "media_files_expires_idx" ON "media_files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outputs_job_idx" ON "outputs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "outputs_owner_created_idx" ON "outputs" USING btree ("client_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "outputs_expires_idx" ON "outputs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outputs_path_idx" ON "outputs" USING btree ("path");
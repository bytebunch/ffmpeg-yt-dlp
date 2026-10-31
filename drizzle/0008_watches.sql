CREATE TABLE "watch_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"watch_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"new_items" integer DEFAULT 0 NOT NULL,
	"job_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "watch_seen" (
	"watch_id" uuid NOT NULL,
	"entry_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_seen_watch_id_entry_key_pk" PRIMARY KEY("watch_id","entry_key")
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"url" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"options" jsonb NOT NULL,
	"recipe" jsonb,
	"destination" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_runs" ADD CONSTRAINT "watch_runs_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_seen" ADD CONSTRAINT "watch_seen_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_runs_watch_idx" ON "watch_runs" USING btree ("watch_id","started_at");--> statement-breakpoint
CREATE INDEX "watches_owner_idx" ON "watches" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "watches_due_idx" ON "watches" USING btree ("next_run_at") WHERE "watches"."status" = 'active';
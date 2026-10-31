CREATE TABLE "inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"source" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"probe" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text,
	"declared_size" bigint NOT NULL,
	"received_size" bigint DEFAULT 0 NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"probe" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inputs" ADD CONSTRAINT "inputs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inputs_owner_content_idx" ON "inputs" USING btree ("client_id","user_id","content_hash");--> statement-breakpoint
CREATE INDEX "inputs_source_idx" ON "inputs" USING btree ("client_id","user_id","source_hash");--> statement-breakpoint
CREATE INDEX "inputs_expires_idx" ON "inputs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "uploads_owner_idx" ON "uploads" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "uploads_expires_idx" ON "uploads" USING btree ("expires_at");
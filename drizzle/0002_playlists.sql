CREATE TABLE "archive" (
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"extractor" text NOT NULL,
	"media_id" text NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_client_id_user_id_extractor_media_id_pk" PRIMARY KEY("client_id","user_id","extractor","media_id")
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cache_key" text NOT NULL,
	"extractor" text,
	"playlist_id" text,
	"title" text,
	"uploader" text,
	"item_count" integer,
	"entries" jsonb NOT NULL,
	"expanded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlists_cache_key_idx" ON "playlists" USING btree ("cache_key");
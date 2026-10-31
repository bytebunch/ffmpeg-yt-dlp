CREATE TABLE "cookie_jars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"domains" jsonb NOT NULL,
	"cookie_count" integer NOT NULL,
	"jar_enc" text NOT NULL,
	"key_version" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"site_key" text NOT NULL,
	"username" text NOT NULL,
	"secret_enc" text NOT NULL,
	"totp_seed_enc" text,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cookie_jars" ADD CONSTRAINT "cookie_jars_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_credentials" ADD CONSTRAINT "site_credentials_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cookie_jars_owner_label_idx" ON "cookie_jars" USING btree ("client_id","user_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "cookie_jars_owner_default_idx" ON "cookie_jars" USING btree ("client_id","user_id") WHERE "cookie_jars"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "site_credentials_owner_site_idx" ON "site_credentials" USING btree ("client_id","user_id","site_key");
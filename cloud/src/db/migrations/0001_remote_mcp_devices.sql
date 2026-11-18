CREATE TABLE "mcp_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"public_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirm_code_hash" text NOT NULL,
	"confirm_attempts" integer DEFAULT 0 NOT NULL,
	"claim_secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"token_issued_at" timestamp with time zone,
	"token_expires_at" timestamp with time zone,
	"key_rotated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"grant_epoch" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_devices_status_check" CHECK ("mcp_devices"."status" in ('pending', 'active', 'suspended', 'revoked')),
	CONSTRAINT "mcp_devices_grant_epoch_check" CHECK ("mcp_devices"."grant_epoch" >= 0),
	CONSTRAINT "mcp_devices_confirm_attempts_check" CHECK ("mcp_devices"."confirm_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mcp_devices" ADD CONSTRAINT "mcp_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_devices_user_idx" ON "mcp_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_devices_token_hash_uq" ON "mcp_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_grants_user_client_resource_uq" ON "mcp_grants" USING btree ("user_id","client_id","resource");--> statement-breakpoint
CREATE INDEX "mcp_grants_user_idx" ON "mcp_grants" USING btree ("user_id");
-- Phase 1.3.1-A：MCP OAuth 的五张表（设计 §10）。
--
-- 纯增量：不修改 0000–0002 建的任何表，不加列、不改默认值、不动 auth_sessions。
--
-- 刻意**不用** `CREATE TABLE IF NOT EXISTS`：幂等由 drizzle 的 journal
-- （`__drizzle_migrations` 按 created_at 只应用一次）保证；而 IF NOT EXISTS
-- 会把「已经存在但结构不一致的表」静默当成成功，那是拿一致性换表面幂等。
--
-- 两条结构性决定（理由见设计 §10.8）：
--   1. client_id 一律不建外键 —— 与 mcp_grants 对齐，client 行是注册缓存而非归属。
--   2. mcp_refresh_tokens 上的部分唯一索引是本模型的核心约束，不是可选优化。

CREATE TABLE "mcp_auth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text[] NOT NULL,
	"resource" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text[] NOT NULL,
	"resource" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"csrf_hash" text NOT NULL,
	"browser_binding_hash" text,
	"user_id" uuid,
	"provider" text,
	"provider_state_hash" text,
	"nonce_hash" text DEFAULT '' NOT NULL,
	"provider_consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_auth_requests_provider_check" CHECK ("mcp_auth_requests"."provider" is null or "mcp_auth_requests"."provider" in ('google', 'github')),
	CONSTRAINT "mcp_auth_requests_pkce_method_check" CHECK ("mcp_auth_requests"."code_challenge_method" = 'S256')
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"redirect_uris" text[] NOT NULL,
	"grant_types" text[] DEFAULT ARRAY['authorization_code', 'refresh_token']::text[] NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"registration_source" text NOT NULL,
	"metadata_fetched_at" timestamp with time zone,
	"metadata_cache_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_source_check" CHECK ("mcp_oauth_clients"."registration_source" in ('pre_registered', 'cimd', 'dcr')),
	CONSTRAINT "mcp_oauth_clients_auth_method_check" CHECK ("mcp_oauth_clients"."token_endpoint_auth_method" = 'none'),
	CONSTRAINT "mcp_oauth_clients_redirect_uris_check" CHECK (cardinality("mcp_oauth_clients"."redirect_uris") between 1 and 5),
	CONSTRAINT "mcp_oauth_clients_grant_types_check" CHECK ("mcp_oauth_clients"."grant_types" <@ ARRAY['authorization_code', 'refresh_token']::text[])
);
--> statement-breakpoint
CREATE TABLE "mcp_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"replaced_by" uuid,
	"ip_hash" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	CONSTRAINT "mcp_refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "mcp_refresh_tokens_generation_check" CHECK ("mcp_refresh_tokens"."generation" >= 1),
	CONSTRAINT "mcp_refresh_tokens_expiry_check" CHECK ("mcp_refresh_tokens"."expires_at" > "mcp_refresh_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "mcp_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"issued_scope" text[] NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	CONSTRAINT "mcp_sessions_revoked_reason_check" CHECK ("mcp_sessions"."revoked_reason" is null or "mcp_sessions"."revoked_reason" in ('user_revoke', 'grant_revoked', 'refresh_reuse', 'client_revoke')),
	CONSTRAINT "mcp_sessions_absolute_expiry_check" CHECK ("mcp_sessions"."absolute_expires_at" > "mcp_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_requests" ADD CONSTRAINT "mcp_auth_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_session_id_mcp_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."mcp_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_auth_codes_expires_idx" ON "mcp_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_auth_codes_grant_idx" ON "mcp_auth_codes" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_auth_requests_provider_state_uq" ON "mcp_auth_requests" USING btree ("provider_state_hash");--> statement-breakpoint
CREATE INDEX "mcp_auth_requests_expires_idx" ON "mcp_auth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_auth_requests_user_idx" ON "mcp_auth_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_refresh_tokens_session_generation_uq" ON "mcp_refresh_tokens" USING btree ("session_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_refresh_tokens_session_active_uq" ON "mcp_refresh_tokens" USING btree ("session_id") WHERE "mcp_refresh_tokens"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_refresh_tokens_expires_idx" ON "mcp_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_sessions_user_idx" ON "mcp_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_sessions_grant_idx" ON "mcp_sessions" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "mcp_sessions_absolute_expires_idx" ON "mcp_sessions" USING btree ("absolute_expires_at");
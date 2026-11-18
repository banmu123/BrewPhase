ALTER TABLE "mcp_grants" ADD COLUMN "epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_epoch_check" CHECK ("mcp_grants"."epoch" >= 1);
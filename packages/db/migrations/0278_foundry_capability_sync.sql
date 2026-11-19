ALTER TABLE "foundry_versions" ADD COLUMN "sync_state" text;--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD COLUMN "sync_commit" text;--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD COLUMN "sync_reason" text;--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD COLUMN "sync_reported_at" timestamp with time zone;
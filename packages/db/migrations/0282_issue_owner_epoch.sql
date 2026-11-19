ALTER TABLE "agent_runs" ADD COLUMN "issue_epoch" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "owner_epoch" integer DEFAULT 0 NOT NULL;
ALTER TABLE "shared_budget_pools" ADD COLUMN "upstream_provider" text;--> statement-breakpoint
ALTER TABLE "shared_budget_pools" ADD COLUMN "upstream_account" text;--> statement-breakpoint
ALTER TABLE "shared_budget_pools" ADD COLUMN "upstream_pool" text;--> statement-breakpoint
ALTER TABLE "shared_budget_routes" ADD COLUMN "credential_version" text;--> statement-breakpoint
ALTER TABLE "shared_budget_pools" ADD CONSTRAINT "shared_budget_pools_upstreamProvider_upstreamAccount_upstreamPool_unique" UNIQUE("upstream_provider","upstream_account","upstream_pool");
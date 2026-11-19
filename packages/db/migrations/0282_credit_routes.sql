CREATE TABLE "credit_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"amount_nano_usd" bigint NOT NULL,
	"actual_nano_usd" bigint,
	"state" text DEFAULT 'held' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "credit_attempt_state" CHECK ("credit_attempts"."state" in ('held', 'settled', 'released', 'unknown')),
	CONSTRAINT "credit_attempt_nonnegative" CHECK ("credit_attempts"."amount_nano_usd" >= 0 and ("credit_attempts"."actual_nano_usd" is null or "credit_attempts"."actual_nano_usd" >= 0))
);
--> statement-breakpoint
CREATE TABLE "credit_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"upstream_namespace" text NOT NULL,
	"upstream_account" text NOT NULL,
	"enforcement" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"evidence_ref" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"grant_start" timestamp with time zone,
	"grant_end" timestamp with time zone,
	"allocation_nano_usd" bigint NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"held_nano_usd" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	CONSTRAINT "credit_pools_orgId_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "credit_pools_upstreamNamespace_upstreamAccount_unique" UNIQUE("upstream_namespace","upstream_account"),
	CONSTRAINT "credit_pool_enforcement" CHECK ("credit_pools"."enforcement" in ('prepaid_grant_only')),
	CONSTRAINT "credit_pool_status" CHECK ("credit_pools"."status" in ('available', 'exhausted', 'expired', 'billing_blocked', 'reconciliation_required')),
	CONSTRAINT "credit_pool_nonnegative" CHECK ("credit_pools"."allocation_nano_usd" >= 0 and "credit_pools"."spent_nano_usd" >= 0 and "credit_pools"."held_nano_usd" >= 0),
	CONSTRAINT "credit_pool_evidence_window" CHECK ("credit_pools"."verified_at" < "credit_pools"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "credit_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_version" text NOT NULL,
	"model" text NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"max_prompt_bytes" bigint NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "credit_routes_orgId_poolId_id_unique" UNIQUE("org_id","pool_id","id"),
	CONSTRAINT "credit_routes_orgId_credentialId_model_unique" UNIQUE("org_id","credential_id","model"),
	CONSTRAINT "credit_route_max_prompt" CHECK ("credit_routes"."max_prompt_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_org_id_pool_id_credit_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."credit_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_org_id_pool_id_route_id_credit_routes_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","route_id") REFERENCES "public"."credit_routes"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_pools" ADD CONSTRAINT "credit_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_routes" ADD CONSTRAINT "credit_routes_org_id_pool_id_credit_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."credit_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_attempts_org_id_pool_id_state_index" ON "credit_attempts" USING btree ("org_id","pool_id","state");--> statement-breakpoint
CREATE INDEX "credit_routes_org_id_credential_id_index" ON "credit_routes" USING btree ("org_id","credential_id");
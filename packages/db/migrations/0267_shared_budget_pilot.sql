CREATE TABLE "shared_budget_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_budget_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"approval_until" timestamp with time zone NOT NULL,
	"approved_by" text NOT NULL,
	"approval_ref" text NOT NULL,
	"ceiling_nano_usd" bigint NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"held_nano_usd" bigint DEFAULT 0 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	CONSTRAINT "shared_budget_pools_orgId_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "shared_budget_nonnegative" CHECK ("shared_budget_pools"."ceiling_nano_usd" >= 0 and "shared_budget_pools"."spent_nano_usd" >= 0 and "shared_budget_pools"."held_nano_usd" >= 0),
	CONSTRAINT "shared_budget_window" CHECK ("shared_budget_pools"."window_start" < "shared_budget_pools"."window_end")
);
--> statement-breakpoint
CREATE TABLE "shared_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"amount_nano_usd" bigint NOT NULL,
	"actual_nano_usd" bigint,
	"state" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "shared_reservation_nonnegative" CHECK ("shared_budget_reservations"."amount_nano_usd" >= 0 and ("shared_budget_reservations"."actual_nano_usd" is null or "shared_budget_reservations"."actual_nano_usd" >= 0)),
	CONSTRAINT "shared_reservation_state" CHECK ("shared_budget_reservations"."state" in ('held', 'settled'))
);
--> statement-breakpoint
CREATE TABLE "shared_budget_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"model" text NOT NULL,
	"subject" text NOT NULL,
	"data_class" text NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"max_prompt_bytes" bigint NOT NULL,
	"evidence_ref" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "shared_budget_routes_orgId_poolId_id_unique" UNIQUE("org_id","pool_id","id"),
	CONSTRAINT "shared_route_window" CHECK ("shared_budget_routes"."verified_at" < "shared_budget_routes"."valid_until"),
	CONSTRAINT "shared_route_max_prompt" CHECK ("shared_budget_routes"."max_prompt_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "shared_budget_policies" ADD CONSTRAINT "shared_budget_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_budget_pools" ADD CONSTRAINT "shared_budget_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_budget_reservations" ADD CONSTRAINT "shared_budget_reservations_org_id_pool_id_shared_budget_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."shared_budget_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_budget_reservations" ADD CONSTRAINT "shared_budget_reservations_org_id_pool_id_route_id_shared_budget_routes_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","route_id") REFERENCES "public"."shared_budget_routes"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_budget_routes" ADD CONSTRAINT "shared_budget_routes_org_id_pool_id_shared_budget_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."shared_budget_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_budget_routes_org_id_provider_credential_id_model_subject_index" ON "shared_budget_routes" USING btree ("org_id","provider","credential_id","model","subject");
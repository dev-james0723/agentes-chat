CREATE TABLE "context_item_events" (
	"org_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"item_id" uuid,
	"action" text,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_item_events_org_id_event_key_pk" PRIMARY KEY("org_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "context_items" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_items" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_items" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "context_items" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_item_events" ADD CONSTRAINT "context_item_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
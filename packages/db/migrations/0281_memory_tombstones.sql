CREATE TABLE "context_item_tombstones" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"deleted_by_kind" text NOT NULL,
	"deleted_by_id" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_item_tombstones_org_id_item_id_pk" PRIMARY KEY("org_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "context_item_tombstones" ADD CONSTRAINT "context_item_tombstones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_item_tombstones_item_id_index" ON "context_item_tombstones" USING btree ("item_id");
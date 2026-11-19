CREATE TABLE "context_item_deletions" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"deleted_by" text,
	"reason" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "context_item_deletions_org_id_index" ON "context_item_deletions" USING btree ("org_id");
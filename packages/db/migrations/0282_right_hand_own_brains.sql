ALTER TABLE "right_hand_brains" ALTER COLUMN "brain_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "right_hand_brains_org_id_machine_id_index" ON "right_hand_brains" USING btree ("org_id","machine_id");--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_route_check" CHECK ("right_hand_brains"."brain_account_id" is not null or "right_hand_brains"."machine_id" is not null);
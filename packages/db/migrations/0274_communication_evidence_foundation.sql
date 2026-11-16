ALTER TABLE "context_items" ADD COLUMN "lesson_verification" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "communication" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_activity_communication_admission" ON "issue_activity" USING btree ("org_id","issue_id",("data"->>'idempotencyKey')) WHERE "issue_activity"."event" = 'communication_handoff_admitted' and "issue_activity"."data"->>'schemaVersion' = '1.0' and jsonb_typeof("issue_activity"."data"->'idempotencyKey') = 'string';--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_revision_positive" CHECK ("issues"."revision" > 0);
--> statement-breakpoint
-- A generation begins at migration/enrollment. It is not historical test or release evidence.
-- Every existing writer advances it; adapter CAS still must bind owner, scope and capabilities.
CREATE FUNCTION "communication_issue_revision"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
  ELSE
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issues_communication_revision" BEFORE INSERT OR UPDATE ON "issues"
FOR EACH ROW EXECUTE FUNCTION "communication_issue_revision"();

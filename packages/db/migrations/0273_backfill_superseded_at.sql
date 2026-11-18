-- Superseded rows written before 0272 have no supersession time, so every known-time view leaves them out.
-- Set it to the later of the two rows' creation: exact for a correction (the successor is created in the
-- supersession's own transaction), a lower bound otherwise (an outweighed row is replaced no earlier than both exist).
-- Data only; rows that already have a time are untouched, so running it again changes nothing.
UPDATE "context_items" AS "old"
SET "superseded_at" = greatest("old"."created_at", "next"."created_at")
FROM "context_items" AS "next"
WHERE "next"."id" = "old"."superseded_by"
  AND "old"."superseded_by" IS NOT NULL
  AND "old"."superseded_at" IS NULL;

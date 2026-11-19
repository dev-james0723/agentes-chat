-- The live database already has this column: an unmerged build added it as 0274 before this was renumbered after
-- main's migrations, and that row was removed so main's migrations could apply. IF NOT EXISTS makes it a no-op there.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "avatar_url" text;

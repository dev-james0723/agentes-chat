-- REVIEW ONLY: post-restore reconstruction, not an automatic migration.
-- Run only after core restore/migrations and review of restored view definitions.
-- Existing role names or an unexpected metrics schema cause an abort, never an overwrite.
-- Uses a separate authorized administrator session; no app secret or old reader password is reused.
\set ON_ERROR_STOP on
BEGIN;
SELECT 1 / (CASE WHEN current_database() = :'database_name' THEN 1 ELSE 0 END) AS expected_database;
SELECT :'organization_id'::uuid AS approved_organization;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('ac_engineering_reader','ac_engineering_view_owner')) THEN
  RAISE EXCEPTION 'Review existing metrics roles before recovery; nothing was changed';
 END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='engineering_ro' AND c.relkind='v'
       AND c.relname IN ('agent_inventory','issue_status_counts','run_status_counts')) <> 3
 OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='engineering_ro' AND c.relkind IN ('r','p','v','m','f','S')
       AND c.relname NOT IN ('agent_inventory','issue_status_counts','run_status_counts')) THEN
  RAISE EXCEPTION 'Expected exactly the restored metrics views; review the restore first';
 END IF;
END $$;
CREATE ROLE ac_engineering_view_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE ac_engineering_reader LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE ac_engineering_reader SET default_transaction_read_only = on;
ALTER ROLE ac_engineering_reader SET statement_timeout = '10s';
ALTER ROLE ac_engineering_reader SET lock_timeout = '2s';
GRANT CONNECT ON DATABASE :"database_name" TO ac_engineering_reader;
ALTER SCHEMA engineering_ro OWNER TO ac_engineering_view_owner;
GRANT USAGE ON SCHEMA public TO ac_engineering_view_owner;
GRANT SELECT (id,org_id,name,handle,role,model,brain,brain_model,deleted_at) ON public.agents TO ac_engineering_view_owner;
GRANT SELECT (org_id,status,priority,restricted,channel_id) ON public.issues TO ac_engineering_view_owner;
GRANT SELECT (id,org_id,visibility,kind,deleted_at) ON public.channels TO ac_engineering_view_owner;
GRANT SELECT (org_id,status,channel_id) ON public.agent_runs TO ac_engineering_view_owner;
ALTER VIEW engineering_ro.agent_inventory OWNER TO ac_engineering_view_owner;
ALTER VIEW engineering_ro.issue_status_counts OWNER TO ac_engineering_view_owner;
ALTER VIEW engineering_ro.run_status_counts OWNER TO ac_engineering_view_owner;
GRANT USAGE ON SCHEMA engineering_ro TO ac_engineering_reader;
GRANT SELECT ON engineering_ro.agent_inventory,engineering_ro.issue_status_counts,engineering_ro.run_status_counts TO ac_engineering_reader;
COMMIT;
-- No broad base-table grants, no default grants for future relations, no privileged membership, no auth/credential access.
-- Activation remains separate: review transport/pinned addresses, set a new reader password securely, then connect normally.

-- REVIEW BEFORE EXECUTION. Never run as an automatic migration.
-- psql -v organization_id='<approved UUID>' -v database_name='<exact database>' -f this-file.sql
-- Uses the operator's separately authorized administrative session, never an agent or saved app credential.
-- No password is generated here. The new reader has PASSWORD NULL until an operator uses a secure password flow.
-- Existing roles/schema cause the transaction to abort rather than changing their privileges.
-- PUBLIC may retain CONNECT/TEMP privileges; the server's exact database profile is an independent boundary.
\set ON_ERROR_STOP on
BEGIN;
-- Abort before creating anything if the operator connected to a different database.
SELECT 1 / (CASE WHEN current_database() = :'database_name' THEN 1 ELSE 0 END) AS expected_database;
SELECT :'organization_id'::uuid AS approved_organization;
CREATE ROLE ac_engineering_view_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE ac_engineering_reader LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE ac_engineering_reader SET default_transaction_read_only = on;
ALTER ROLE ac_engineering_reader SET statement_timeout = '10s';
ALTER ROLE ac_engineering_reader SET lock_timeout = '2s';
GRANT CONNECT ON DATABASE :"database_name" TO ac_engineering_reader;
CREATE SCHEMA engineering_ro AUTHORIZATION ac_engineering_view_owner;
GRANT USAGE ON SCHEMA public TO ac_engineering_view_owner;
GRANT SELECT (id,org_id,name,handle,role,model,brain,brain_model,deleted_at) ON public.agents TO ac_engineering_view_owner;
GRANT SELECT (org_id,status,priority,restricted,channel_id) ON public.issues TO ac_engineering_view_owner;
GRANT SELECT (id,org_id,visibility,kind,deleted_at) ON public.channels TO ac_engineering_view_owner;
GRANT SELECT (org_id,status,channel_id) ON public.agent_runs TO ac_engineering_view_owner;
CREATE VIEW engineering_ro.agent_inventory WITH (security_barrier=true) AS
 SELECT id,name,handle,role,model,brain,brain_model
 FROM public.agents WHERE org_id=:'organization_id'::uuid AND deleted_at IS NULL;
CREATE VIEW engineering_ro.issue_status_counts WITH (security_barrier=true) AS
 SELECT i.status,i.priority,count(*)::bigint AS total
 FROM public.issues i
 WHERE i.org_id=:'organization_id'::uuid AND NOT i.restricted
   AND (i.channel_id IS NULL OR EXISTS (SELECT 1 FROM public.channels c
     WHERE c.id=i.channel_id AND c.org_id=:'organization_id'::uuid
       AND c.visibility='public' AND c.kind='channel' AND c.deleted_at IS NULL))
 GROUP BY i.status,i.priority;
CREATE VIEW engineering_ro.run_status_counts WITH (security_barrier=true) AS
 SELECT r.status,count(*)::bigint AS total
 FROM public.agent_runs r JOIN public.channels c ON c.id=r.channel_id AND c.org_id=r.org_id
 WHERE r.org_id=:'organization_id'::uuid AND c.visibility='public' AND c.kind='channel' AND c.deleted_at IS NULL
 GROUP BY r.status;
ALTER VIEW engineering_ro.agent_inventory OWNER TO ac_engineering_view_owner;
ALTER VIEW engineering_ro.issue_status_counts OWNER TO ac_engineering_view_owner;
ALTER VIEW engineering_ro.run_status_counts OWNER TO ac_engineering_view_owner;
GRANT USAGE ON SCHEMA engineering_ro TO ac_engineering_reader;
GRANT SELECT ON engineering_ro.agent_inventory,engineering_ro.issue_status_counts,engineering_ro.run_status_counts TO ac_engineering_reader;
COMMIT;
-- No broad base-table grants, no default grants for future relations, no privileged membership, no auth/credential access.
-- Activation remains separate: review transport/pinned addresses, set a new reader password securely, then connect normally.

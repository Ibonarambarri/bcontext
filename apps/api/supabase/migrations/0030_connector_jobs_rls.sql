-- 0030_connector_jobs_rls.sql
--
-- connector_jobs was the only table without row level security: with RLS
-- disabled it was readable AND writable through PostgREST with the public
-- anon key (2026-07-07 audit, P14-04). Only the connector worker — which
-- runs on the service-role client and bypasses RLS — should ever touch
-- this queue, so enabling RLS with no policies is the whole fix: anon and
-- authenticated roles get denied everything, the service role is exempt.

alter table connector_jobs enable row level security;

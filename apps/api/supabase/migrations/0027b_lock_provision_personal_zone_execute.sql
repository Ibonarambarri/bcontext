-- 0027b_lock_provision_personal_zone_execute.sql
--
-- Trigger functions must not be reachable via PostgREST RPC. provision_personal_zone
-- is SECURITY DEFINER (it writes across orgs/workspaces/nodes) and would otherwise be
-- callable by anon/authenticated at /rest/v1/rpc/provision_personal_zone — flagged by
-- the Supabase security linter. Revoke EXECUTE so only the trigger path runs it.

revoke all on function public.provision_personal_zone() from public, anon, authenticated;
revoke all on function public.reject_personal_zone_invite() from public, anon, authenticated;

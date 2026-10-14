-- The sweep of abandoned capability OAuth attempts moves from pg_cron to the
-- pg-boss worker (queue `capability.oauth-expire`,
-- src/lib/capabilities/oauth-expiry.ts), the one scheduler the product runs.
-- Migration 0034 scheduled it with pg_cron; this removes that job so the two
-- do not both run, and so a Supabase without pg_cron needs nothing here.
--
-- Idempotent and safe everywhere: it does nothing unless the `cron` schema
-- exists AND the job is there. It never drops the extension — other things
-- on a shared Postgres may use it.
do $$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron')
     and exists (
       select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'cron' and c.relname = 'job'
     ) then
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'bcontext-expire-capability-oauth-attempts';
  end if;
end;
$$;

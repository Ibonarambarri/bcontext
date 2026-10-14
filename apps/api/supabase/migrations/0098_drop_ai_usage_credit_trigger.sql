-- Nothing sells AI credit any more: usage is counted in ai_usage_events for
-- the instance's administrators and never refused, and each Nexo carries its
-- own monthly budget. The trigger from 0088 still added every call's cost to
-- organization_credits.spent_usd, a balance nobody reads; drop it and its
-- function so an insert into ai_usage_events is one write again.
--
-- The commercial tables of 0070/0087/0088 (organization_credits and the
-- rest) stay: dropping data is a separate decision from stopping a write.
-- Idempotent: safe on a database that never had the trigger.
drop trigger if exists ai_usage_events_spend_credit on public.ai_usage_events;
drop function if exists public.spend_org_credit_from_usage();

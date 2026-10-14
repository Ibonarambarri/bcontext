-- 0061 — allow status='running' on webhook_deliveries (F01)
--
-- NOT APPLIED.
--
-- Bug found while wiring the worker: `processDeliveries`
-- (src/lib/webhooks/worker.ts) takes its CAS lock by flipping a row to
-- status='running', but 0008's check constraint only allows
-- ('pending','retrying','sent','failed','dead'). The UPDATE therefore fails
-- the constraint, supabase-js returns an error, `locked.data` is null and the
-- worker's `continue` skips the row — silently. The webhook retry worker has
-- never been able to lock a single delivery.
--
-- `connector_jobs` (0011) already allows 'running'; this brings
-- `webhook_deliveries` in line. No data migration needed — no row can
-- currently be in 'running'.
--
-- Apply with:
--   psql "$DATABASE_URL" -f supabase/migrations/0061_webhook_delivery_running_status.sql

alter table webhook_deliveries
  drop constraint if exists webhook_deliveries_status_check;

alter table webhook_deliveries
  add constraint webhook_deliveries_status_check
  check (status in ('pending','running','retrying','sent','failed','dead'));

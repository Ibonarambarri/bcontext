-- 0050_ingest_candidates_reprocess.sql
--
-- UIX-NEXO Phase B.2 — the new Procesamiento board adds a "Reprocesar"
-- column: a reviewer can send a candidate back with feedback instead of a
-- binary accept/dismiss. Widen the status check and carry the feedback text.
-- No RLS change: the existing member-read / service-role-write policies on
-- ingest_candidates already cover the new status value.

alter table ingest_candidates drop constraint ingest_candidates_status_check;
alter table ingest_candidates add constraint ingest_candidates_status_check
  check (status in ('pending', 'accepted', 'dismissed', 'reprocess'));

alter table ingest_candidates add column reprocess_feedback text;

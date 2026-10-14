-- 0056_data_credential_kinds.sql
-- Add two new node kinds:
--   'data'       — a CSV table, rendered as a grid.
--   'credential' — an account/key with arbitrary masked fields (values live in
--                  node.data, never in content_md, and are excluded from the
--                  embedding/RAG/agent surfaces in app code).
-- Widen the nodes kind CHECK to allow them. Idempotent.

alter table public.nodes drop constraint if exists nodes_kind_check;
alter table public.nodes add constraint nodes_kind_check check (
  kind = any (array['doc','task','decision','meeting','bug','adr','entity','skill','data','credential'])
);

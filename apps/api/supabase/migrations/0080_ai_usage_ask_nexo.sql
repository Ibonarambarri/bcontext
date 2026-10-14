-- 0080_ai_usage_ask_nexo.sql
--
-- `ask_nexo` meters its synthesis call like every other LLM surface. The
-- surface list is a CHECK constraint (0047, widened in 0048 and 0053), so a
-- new surface is a migration or the ledger silently drops the row.

alter table ai_usage_events drop constraint ai_usage_events_surface_check;
alter table ai_usage_events add constraint ai_usage_events_surface_check
  check (surface in (
    'chat',
    'autofix',
    'skill_run',
    'meeting_refine',
    'ask_rag',
    'ask_nexo',
    'contextualize',
    'embed',
    'query_embed',
    'rerank',
    'ingest_extract',
    'integration_setup'
  ));

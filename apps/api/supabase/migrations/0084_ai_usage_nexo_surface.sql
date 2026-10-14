-- 0084_ai_usage_nexo_surface.sql
--
-- Nexo, the in-app assistant, replaces the old chat surface. Its turns are
-- metered like every other LLM call, and the surface list is a CHECK
-- constraint (0047, widened in 0048, 0053 and 0080) — without this the ledger
-- would silently drop every Nexo row.
--
-- 'chat' stays in the list: the historical rows written by the old surface are
-- still there and still true.

alter table ai_usage_events drop constraint ai_usage_events_surface_check;
alter table ai_usage_events add constraint ai_usage_events_surface_check
  check (surface in (
    'chat',
    'nexo',
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

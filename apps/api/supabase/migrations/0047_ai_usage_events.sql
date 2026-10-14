-- 0047_ai_usage_events.sql
--
-- NOW-01 — per-call AI usage/cost telemetry. Purely observability during the
-- MVP: which models are used, what they cost, where regressions show up.
-- Never stores prompts or responses — only counts, identifiers and cost.

create table ai_usage_events (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  subject_user_id uuid references auth.users(id) on delete set null,
  surface text not null check (surface in (
    'chat',
    'autofix',
    'skill_run',
    'meeting_refine',
    'ask_rag',
    'contextualize',
    'embed',
    'query_embed',
    'rerank'
  )),
  model text not null,
  tokens_input integer not null default 0,
  tokens_output integer not null default 0,
  tokens_cached integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  cost_source text not null default 'fallback' check (cost_source in ('provider', 'fallback')),
  success boolean not null default true,
  request_id text,
  -- Free-form but non-prompt metadata only (e.g. node_id, skill_slug,
  -- finish_reason). Application code must never place prompt/response text
  -- here — enforced by the recordAiUsageEvent() helper's typed input, not by
  -- the database.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Idempotency: a caller retrying the same logical AI call (e.g. after a
-- timeout) passes the same request_id and must not double-count usage.
-- Not partial: Postgres treats each NULL as distinct, so rows without a
-- request_id never collide, and this stays a plain upsert-friendly index.
create unique index ai_usage_events_workspace_request_idx
  on ai_usage_events(workspace_id, request_id);

create index ai_usage_events_workspace_created_idx
  on ai_usage_events(workspace_id, created_at desc);
create index ai_usage_events_workspace_surface_created_idx
  on ai_usage_events(workspace_id, surface, created_at desc);

-- Append-only audit trail: workspace members can read it, nobody writes
-- through the authenticated role — all inserts go through the service-role
-- client (recordAiUsageEvent()), which bypasses RLS entirely. The explicit
-- `with check (false)` documents that intent even though it's redundant for
-- service-role writes.
alter table ai_usage_events enable row level security;

create policy ai_usage_events_member_read on ai_usage_events
  for select using (is_workspace_member(workspace_id));
create policy ai_usage_events_no_client_insert on ai_usage_events
  for insert with check (false);

-- Rollups by workspace, surface and month — no prompts/responses to leak,
-- and security_invoker so the view is subject to the same RLS as the table.
create view ai_usage_rollup_monthly
  with (security_invoker = true) as
select
  workspace_id,
  surface,
  date_trunc('month', created_at) as month,
  count(*) as event_count,
  sum(tokens_input) as tokens_input,
  sum(tokens_output) as tokens_output,
  sum(tokens_cached) as tokens_cached,
  sum(cost_usd) as cost_usd
from ai_usage_events
group by workspace_id, surface, date_trunc('month', created_at);

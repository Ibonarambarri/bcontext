-- 0048_ingest_candidates.sql
--
-- NEXO-01 — entry queue: signals -> typed node candidates, reviewed via an
-- inbox (accept/dismiss) before becoming real nodes. This is the generic,
-- connector-agnostic pipeline; NEXO-02/03/04 wire specific sources
-- (GitHub, meetings, Slack) into it.

create table ingest_candidates (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source text not null,
  external_id text not null,
  kind text not null check (kind in ('decision', 'task', 'bug', 'adr')),
  title text not null,
  content_md text not null default '',
  links jsonb not null default '[]'::jsonb,
  confidence numeric(3, 2),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  -- Signal metadata (connector, install, raw event id, extractor version...).
  -- Never raw prompt/response text — see recordAiUsageEvent for that rule.
  provenance jsonb not null default '{}'::jsonb,
  created_node_id uuid references nodes(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Re-delivered signals resolve to the same candidate row instead of
-- duplicating it; proposeCandidate() only overwrites while still 'pending'
-- so a dismissed/accepted decision is never silently resurrected.
create unique index ingest_candidates_workspace_source_external_idx
  on ingest_candidates(workspace_id, source, external_id);

create index ingest_candidates_workspace_status_created_idx
  on ingest_candidates(workspace_id, status, created_at desc);

-- Members read their workspace's inbox; all writes (propose/accept/dismiss)
-- go through the service-role client in src/lib/ingest/candidates.ts.
alter table ingest_candidates enable row level security;

create policy ingest_candidates_member_read on ingest_candidates
  for select using (is_workspace_member(workspace_id));
create policy ingest_candidates_no_client_insert on ingest_candidates
  for insert with check (false);

-- Day-one health metric: what fraction of the graph carries ingest
-- provenance. A node is "from ingestion" when its `data` bag carries the
-- `ingest_candidate_id` key that acceptCandidate() stamps on creation.
create view ingest_provenance_ratio
  with (security_invoker = true) as
select
  workspace_id,
  count(*) filter (where data ? 'ingest_candidate_id') as nodes_with_provenance,
  count(*) as total_nodes,
  round(
    100.0 * count(*) filter (where data ? 'ingest_candidate_id') / nullif(count(*), 0),
    2
  ) as provenance_pct
from nodes
group by workspace_id;

-- NOW-01: every extractor LLM call must be recorded. Add the new surface.
alter table ai_usage_events drop constraint ai_usage_events_surface_check;
alter table ai_usage_events add constraint ai_usage_events_surface_check
  check (surface in (
    'chat',
    'autofix',
    'skill_run',
    'meeting_refine',
    'ask_rag',
    'contextualize',
    'embed',
    'query_embed',
    'rerank',
    'ingest_extract'
  ));

-- 0077_nexo_conflicts.sql
--
-- NEXO conflicts — the one human-review surface left. Candidates above the
-- auto-accept threshold become nodes on their own; what NEXO is unsure
-- about (a contradiction with the graph that does not say "this changed",
-- a low-confidence extraction, a stale node) lands here with the evidence,
-- and the human answers in free text that NEXO turns into node operations.
--
-- Members read their workspace's conflicts; every write (open / resolve /
-- dismiss) goes through the service-role client in src/lib/nexo/conflicts.ts.

create table nexo_conflicts (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('contradiction', 'doubt', 'stale')),
  summary text not null check (char_length(summary) between 1 and 400),
  context_md text not null default '',
  evidence jsonb not null default '[]'::jsonb,
  related_node_ids uuid[] not null default '{}',
  candidate_id uuid references ingest_candidates(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  decision_text text,
  resolution jsonb,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index nexo_conflicts_workspace_status_created_idx
  on nexo_conflicts(workspace_id, status, created_at desc);

-- One open conflict per candidate: a redelivered signal refreshes it
-- instead of stacking duplicates in the list.
create unique index nexo_conflicts_open_candidate_idx
  on nexo_conflicts(candidate_id) where candidate_id is not null and status = 'open';

alter table nexo_conflicts enable row level security;

create policy nexo_conflicts_member_read on nexo_conflicts
  for select using (is_workspace_member(workspace_id));
create policy nexo_conflicts_no_client_insert on nexo_conflicts
  for insert with check (false);

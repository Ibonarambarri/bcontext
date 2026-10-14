-- 0049_node_read_activity.sql
--
-- NEXO-05 — lightweight read-activity counter feeding the staleness score
-- (edit age vs. query frequency). Kept as a standalone table rather than
-- columns on `nodes` so every existing `nodes` select stays untouched;
-- callers that want the signal look it up explicitly (see
-- src/lib/rag/staleness.ts).

create table node_read_activity (
  node_id uuid primary key references nodes(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  read_count integer not null default 0,
  last_read_at timestamptz,
  updated_at timestamptz not null default now()
);

create index node_read_activity_workspace_idx on node_read_activity(workspace_id);

-- Members read activity for their own workspace; all writes (increment on
-- retrieval) go through the service-role client in src/lib/rag/staleness.ts.
alter table node_read_activity enable row level security;

create policy node_read_activity_member_read on node_read_activity
  for select using (is_workspace_member(workspace_id));
create policy node_read_activity_no_client_insert on node_read_activity
  for insert with check (false);

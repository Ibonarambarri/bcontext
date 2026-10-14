-- UIX-08 — operational Changes feed retention and query indexes.
--
-- `activity` contains redacted before/after snapshots for human supervision.
-- They are intentionally retained for 180 days. `audit_log` remains the
-- indefinite append-only evidence layer and stores hashes, never arguments.

alter table public.activity
  add column if not exists expires_at timestamptz;

update public.activity
set expires_at = created_at + interval '180 days'
where expires_at is null;

alter table public.activity
  alter column expires_at set default (now() + interval '180 days'),
  alter column expires_at set not null;

comment on table public.activity is
  'Redacted operational Changes feed. Rows and snapshots expire after 180 days; audit_log hashes are retained indefinitely.';
comment on column public.activity.payload is
  'Redacted UI/MCP change context. Credentials and private model reasoning are forbidden at the application boundary.';

create index if not exists activity_workspace_actor_created_idx
  on public.activity(workspace_id, actor_kind, created_at desc, id desc);
create index if not exists activity_workspace_verb_created_idx
  on public.activity(workspace_id, verb, created_at desc, id desc);
create index if not exists activity_expires_idx
  on public.activity(expires_at);
create index if not exists activity_payload_gin_idx
  on public.activity using gin(payload jsonb_path_ops);

-- Amortized retention: every durable activity insert removes expired feed
-- rows. The function is not exposed to authenticated clients and its pinned
-- search_path prevents object-shadowing in a SECURITY DEFINER function.
create or replace function public.prune_expired_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  delete from public.activity where expires_at <= pg_catalog.now();
  return null;
end;
$$;

revoke all on function public.prune_expired_activity() from public, anon, authenticated;

drop trigger if exists activity_retention_after_insert on public.activity;
create trigger activity_retention_after_insert
after insert on public.activity
for each statement execute function public.prune_expired_activity();


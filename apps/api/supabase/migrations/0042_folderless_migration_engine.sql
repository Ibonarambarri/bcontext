-- UIX-21 — audited, resumable folder-to-tags migration engine.
--
-- This is an expand migration. It does not remove `kind=folder`, category, or
-- any public writer contract. UIX-22 activates the workspace guard before an
-- approved run is applied and performs the later contract migration.

create table if not exists public.folderless_migration_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version = 1),
  status text not null check (status in (
    'draft', 'needs_review', 'approved', 'applying', 'applied', 'rolling_back', 'rolled_back', 'failed'
  )),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  post_apply_fingerprint text check (post_apply_fingerprint is null or post_apply_fingerprint ~ '^[0-9a-f]{64}$'),
  rollback_snapshot jsonb not null check (jsonb_typeof(rollback_snapshot) = 'object'),
  require_tagged boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  applied_at timestamptz,
  rolled_back_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, manifest_sha256)
);

comment on table public.folderless_migration_runs is
  'Immutable reviewed UIX-21 plans plus exact source and rollback evidence. Full snapshots are admin-only and must never be exposed as public resources.';

create index if not exists folderless_runs_workspace_created_idx
  on public.folderless_migration_runs(workspace_id, created_at desc);

create table if not exists public.folderless_migration_items (
  run_id uuid not null references public.folderless_migration_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  folder_id uuid not null,
  depth integer,
  entry jsonb not null check (jsonb_typeof(entry) = 'object'),
  resolved_tag_id uuid,
  applied_at timestamptz,
  rolled_back_at timestamptz,
  primary key (run_id, folder_id)
);

create index if not exists folderless_items_workspace_folder_idx
  on public.folderless_migration_items(workspace_id, folder_id);

create table if not exists public.folderless_migration_ledger (
  sequence bigint generated always as identity primary key,
  run_id uuid not null references public.folderless_migration_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operation text not null,
  resource_type text not null,
  resource_id text not null,
  owned_by_run boolean not null default false,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists folderless_ledger_run_sequence_idx
  on public.folderless_migration_ledger(run_id, sequence);

create table if not exists public.node_redirects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  legacy_node_id uuid not null,
  legacy_slug text not null,
  target_type text not null check (target_type in ('node', 'tag', 'gone')),
  target_id uuid,
  run_id uuid not null references public.folderless_migration_runs(id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint node_redirect_target_shape check (
    (target_type in ('node', 'tag') and target_id is not null)
    or (target_type = 'gone' and target_id is null)
  ),
  unique (workspace_id, legacy_node_id),
  unique (workspace_id, legacy_slug)
);

comment on table public.node_redirects is
  'Legacy folder IDs/slugs. Tag target_id stores the raw tag UUID; tag:<uuid> exists only in graph payloads.';

create index if not exists node_redirects_target_idx
  on public.node_redirects(workspace_id, target_type, target_id);

create table if not exists public.folderless_workspace_guards (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  block_new_folders boolean not null default false,
  legacy_folders_read_only boolean not null default false,
  activated_by_run_id uuid references public.folderless_migration_runs(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Rollback restores captured timestamps/version counters exactly. The setting
-- is transaction-local and only the service-role rollback RPC enables it.
create or replace function public.set_updated_at() returns trigger as $$
begin
  if current_setting('bcontext.folderless_restore', true) = 'on' then
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace function public.bump_saved_view_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_setting('bcontext.folderless_restore', true) = 'on' then
    return new;
  end if;
  new.updated_at = clock_timestamp();
  new.version = old.version + 1;
  return new;
end;
$$;

alter table public.folderless_migration_runs enable row level security;
alter table public.folderless_migration_items enable row level security;
alter table public.folderless_migration_ledger enable row level security;
alter table public.node_redirects enable row level security;
alter table public.folderless_workspace_guards enable row level security;

create policy folderless_runs_admin_read on public.folderless_migration_runs
  for select using (public.is_workspace_admin(workspace_id));
create policy folderless_items_admin_read on public.folderless_migration_items
  for select using (public.is_workspace_admin(workspace_id));
create policy folderless_ledger_admin_read on public.folderless_migration_ledger
  for select using (public.is_workspace_admin(workspace_id));
create policy node_redirects_member_read on public.node_redirects
  for select using (public.is_workspace_member(workspace_id));
create policy folderless_guards_member_read on public.folderless_workspace_guards
  for select using (public.is_workspace_member(workspace_id));

create or replace function public.folderless_guard_node_writes()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  guard_row public.folderless_workspace_guards%rowtype;
  guard_workspace uuid := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
begin
  if current_setting('bcontext.folderless_migration_bypass', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select * into guard_row
  from public.folderless_workspace_guards
  where workspace_id = guard_workspace;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' and guard_row.block_new_folders and new.kind = 'folder' then
    raise exception using errcode = '23514', message = 'folder_kind_retired';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and guard_row.legacy_folders_read_only and old.kind = 'folder' then
    raise exception using errcode = '55000', message = 'legacy_folder_read_only';
  end if;
  if tg_op = 'UPDATE' and guard_row.block_new_folders and new.kind = 'folder' and old.kind <> 'folder' then
    raise exception using errcode = '23514', message = 'folder_kind_retired';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists nodes_folderless_guard on public.nodes;
create trigger nodes_folderless_guard
before insert or update or delete on public.nodes
for each row execute function public.folderless_guard_node_writes();

create or replace function public.folderless_workspace_fingerprint(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'nodes', coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from public.nodes n where n.workspace_id = p_workspace_id), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.tags t where t.workspace_id = p_workspace_id), '[]'::jsonb),
    'tag_aliases', coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.tag_aliases a where a.workspace_id = p_workspace_id), '[]'::jsonb),
    'node_tags', coalesce((select jsonb_agg(to_jsonb(nt) order by nt.node_id, nt.tag_id) from public.node_tags nt where nt.workspace_id = p_workspace_id), '[]'::jsonb),
    'embeddings', coalesce((select jsonb_agg(to_jsonb(em) order by em.id) from public.embeddings em where em.workspace_id = p_workspace_id), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.edges e where e.workspace_id = p_workspace_id), '[]'::jsonb),
    'node_links', coalesce((select jsonb_agg(to_jsonb(nl) order by nl.source_node, nl.target_node, nl.origin, nl.block_id) from public.node_links nl where nl.workspace_id = p_workspace_id), '[]'::jsonb),
    'saved_views', coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.saved_views v where v.workspace_id = p_workspace_id), '[]'::jsonb)
  )::text, 'utf8'), 'sha256'), 'hex');
$$;

create or replace function public.capture_folderless_workspace(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'schema_version', 1,
    'captured_at', now(),
    'database_fingerprint', public.folderless_workspace_fingerprint(p_workspace_id),
    'workspace', jsonb_build_object('id', w.id, 'slug', w.slug, 'name', w.name),
    'nodes', coalesce((select jsonb_agg(jsonb_build_object(
      'id', n.id, 'workspace_id', n.workspace_id, 'parent_id', n.parent_id,
      'kind', n.kind, 'category', n.category, 'slug', n.slug, 'title', n.title,
      'content_md', coalesce(n.content_md, ''), 'data', coalesce(n.data, '{}'::jsonb), 'status', n.status
    ) order by n.id) from public.nodes n where n.workspace_id = w.id), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'workspace_id', t.workspace_id, 'name', t.name,
      'normalized_name', t.normalized_name, 'slug', t.slug, 'description', t.description,
      'merged_into_id', t.merged_into_id, 'deleted_at', t.deleted_at
    ) order by t.id) from public.tags t where t.workspace_id = w.id), '[]'::jsonb),
    'node_tags', coalesce((select jsonb_agg(jsonb_build_object(
      'workspace_id', nt.workspace_id, 'node_id', nt.node_id, 'tag_id', nt.tag_id
    ) order by nt.node_id, nt.tag_id) from public.node_tags nt where nt.workspace_id = w.id), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(jsonb_build_object(
      'workspace_id', e.workspace_id, 'from_node', e.from_node, 'to_node', e.to_node, 'relation', e.relation
    ) order by e.id) from public.edges e where e.workspace_id = w.id), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_object(
      'workspace_id', nl.workspace_id, 'source_node', nl.source_node, 'target_node', nl.target_node,
      'origin', nl.origin, 'block_id', nullif(nl.block_id, '')
    ) order by nl.source_node, nl.target_node, nl.origin, nl.block_id) from public.node_links nl where nl.workspace_id = w.id), '[]'::jsonb),
    'saved_views', coalesce((select jsonb_agg(jsonb_build_object(
      'id', v.id, 'workspace_id', v.workspace_id, 'name', v.name, 'slug', v.slug,
      'query', v.query, 'presentation', v.presentation
    ) order by v.id) from public.saved_views v where v.workspace_id = w.id), '[]'::jsonb)
  )
  from public.workspaces w
  where w.id = p_workspace_id;
$$;

create or replace function public.folderless_rollback_snapshot(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'nodes', coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from public.nodes n where n.workspace_id = p_workspace_id), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.tags t where t.workspace_id = p_workspace_id), '[]'::jsonb),
    'tag_aliases', coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.tag_aliases a where a.workspace_id = p_workspace_id), '[]'::jsonb),
    'node_tags', coalesce((select jsonb_agg(to_jsonb(nt) order by nt.node_id, nt.tag_id) from public.node_tags nt where nt.workspace_id = p_workspace_id), '[]'::jsonb),
    'embeddings', coalesce((select jsonb_agg(to_jsonb(em) order by em.id) from public.embeddings em where em.workspace_id = p_workspace_id), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.edges e where e.workspace_id = p_workspace_id), '[]'::jsonb),
    'node_links', coalesce((select jsonb_agg(to_jsonb(nl) order by nl.source_node, nl.target_node, nl.origin, nl.block_id) from public.node_links nl where nl.workspace_id = p_workspace_id), '[]'::jsonb),
    'saved_views', coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.saved_views v where v.workspace_id = p_workspace_id), '[]'::jsonb),
    'guard', (select to_jsonb(g) from public.folderless_workspace_guards g where g.workspace_id = p_workspace_id)
  );
$$;

create or replace function public.register_folderless_migration_plan(
  p_workspace_id uuid,
  p_plan jsonb,
  p_manifest_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  run_row public.folderless_migration_runs%rowtype;
  plan_status text;
begin
  if p_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_manifest_sha256';
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id) then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;
  if p_plan #>> '{workspace,id}' is distinct from p_workspace_id::text then
    raise exception using errcode = '22023', message = 'plan_workspace_mismatch';
  end if;
  if coalesce((p_plan ->> 'manifest_sha256') = p_manifest_sha256, false) is false then
    raise exception using errcode = '22023', message = 'plan_sha_mismatch';
  end if;
  if coalesce(p_plan ->> 'source_fingerprint', '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_source_fingerprint';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 21021));
  lock table public.nodes, public.tags, public.tag_aliases, public.node_tags,
    public.embeddings, public.edges, public.node_links, public.saved_views,
    public.meeting_bots in share row exclusive mode;
  if public.folderless_workspace_fingerprint(p_workspace_id) <> (p_plan ->> 'source_fingerprint') then
    raise exception using errcode = '40001', message = 'folderless_source_changed_since_dry_run';
  end if;
  plan_status := case when coalesce((p_plan ->> 'approval_ready')::boolean, false)
    then 'draft' else 'needs_review' end;

  select * into run_row
  from public.folderless_migration_runs
  where workspace_id = p_workspace_id and manifest_sha256 = p_manifest_sha256;
  if found then
    return jsonb_build_object('id', run_row.id, 'status', run_row.status, 'manifest_sha256', run_row.manifest_sha256, 'reused', true);
  end if;

  insert into public.folderless_migration_runs(
    workspace_id, status, manifest_sha256, plan, source_fingerprint,
    rollback_snapshot, require_tagged
  ) values (
    p_workspace_id, plan_status, p_manifest_sha256, p_plan,
    p_plan ->> 'source_fingerprint',
    public.folderless_rollback_snapshot(p_workspace_id),
    coalesce((p_plan ->> 'require_tagged')::boolean, false)
  ) returning * into run_row;

  insert into public.folderless_migration_items(run_id, workspace_id, folder_id, depth, entry)
  select run_row.id, p_workspace_id, (entry ->> 'folder_id')::uuid,
    nullif(entry ->> 'depth', '')::integer, entry
  from jsonb_array_elements(coalesce(p_plan #> '{manifest,folders}', '[]'::jsonb)) entry;

  return jsonb_build_object('id', run_row.id, 'status', run_row.status, 'manifest_sha256', run_row.manifest_sha256, 'reused', false);
end;
$$;

create or replace function public.resolve_node_redirect(
  p_workspace_id uuid,
  p_legacy_node_id uuid default null,
  p_legacy_slug text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select to_jsonb(r)
  from public.node_redirects r
  where r.workspace_id = p_workspace_id
    and num_nonnulls(p_legacy_node_id, p_legacy_slug) = 1
    and (p_legacy_node_id is null or r.legacy_node_id = p_legacy_node_id)
    and (p_legacy_slug is null or r.legacy_slug = p_legacy_slug)
  limit 1;
$$;

create or replace function public.approve_folderless_migration_plan(
  p_run_id uuid,
  p_expected_manifest_sha256 text,
  p_approved_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare run_row public.folderless_migration_runs%rowtype;
begin
  select * into run_row from public.folderless_migration_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'folderless_run_not_found'; end if;
  if run_row.status = 'approved' then
    if run_row.manifest_sha256 <> p_expected_manifest_sha256 then
      raise exception using errcode = '40001', message = 'approved_manifest_sha_mismatch';
    end if;
    return jsonb_build_object('id', run_row.id, 'status', run_row.status, 'manifest_sha256', run_row.manifest_sha256, 'reused', true);
  end if;
  if run_row.status not in ('draft', 'needs_review') then
    raise exception using errcode = '55000', message = 'folderless_run_not_approvable';
  end if;
  if run_row.manifest_sha256 <> p_expected_manifest_sha256 then
    raise exception using errcode = '40001', message = 'approved_manifest_sha_mismatch';
  end if;
  if not coalesce((run_row.plan ->> 'approval_ready')::boolean, false)
     or exists (select 1 from jsonb_array_elements(coalesce(run_row.plan -> 'blockers', '[]'::jsonb)) blocker where not coalesce((blocker ->> 'waived')::boolean, false)) then
    raise exception using errcode = '55000', message = 'folderless_plan_has_unresolved_review';
  end if;
  if public.folderless_workspace_fingerprint(run_row.workspace_id) <> run_row.source_fingerprint then
    raise exception using errcode = '40001', message = 'folderless_source_changed_since_dry_run';
  end if;

  update public.folderless_migration_runs
  set status = 'approved', approved_by = p_approved_by, approved_at = now(), updated_at = now(), error = null
  where id = p_run_id returning * into run_row;
  return jsonb_build_object('id', run_row.id, 'status', run_row.status, 'manifest_sha256', run_row.manifest_sha256, 'reused', false);
end;
$$;

create or replace function public.set_folderless_workspace_guard(
  p_workspace_id uuid,
  p_block_new_folders boolean,
  p_legacy_folders_read_only boolean default false,
  p_run_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 21021));
  if p_run_id is not null and not exists (
    select 1 from public.folderless_migration_runs where id = p_run_id and workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '22023', message = 'folderless_guard_run_mismatch';
  end if;
  insert into public.folderless_workspace_guards(
    workspace_id, block_new_folders, legacy_folders_read_only, activated_by_run_id, updated_at
  ) values (p_workspace_id, p_block_new_folders, p_legacy_folders_read_only, p_run_id, now())
  on conflict (workspace_id) do update set
    block_new_folders = excluded.block_new_folders,
    legacy_folders_read_only = excluded.legacy_folders_read_only,
    activated_by_run_id = excluded.activated_by_run_id,
    updated_at = now();
  return (select to_jsonb(g) from public.folderless_workspace_guards g where g.workspace_id = p_workspace_id);
end;
$$;

create or replace function public.resolve_folderless_reviewed_tag(
  p_workspace_id uuid,
  p_name text,
  p_normalized_name text,
  p_candidate_tag_ids jsonb default '[]'::jsonb,
  p_description text default null
)
returns table (tag_id uuid, created boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare candidate_count integer := jsonb_array_length(coalesce(p_candidate_tag_ids, '[]'::jsonb));
begin
  if candidate_count > 1 then
    raise exception using errcode = '55000', message = 'ambiguous_folder_tag_not_reviewed';
  end if;
  if candidate_count = 1 then
    tag_id := (p_candidate_tag_ids ->> 0)::uuid;
    if not exists (
      select 1 from public.tags t where t.id = tag_id and t.workspace_id = p_workspace_id
        and t.deleted_at is null and t.merged_into_id is null
    ) then raise exception using errcode = '23503', message = 'reviewed_tag_not_active'; end if;
    created := false;
    return next;
    return;
  end if;

  select t.id into tag_id from public.tags t
  where t.workspace_id = p_workspace_id
    and t.normalized_name = public.normalize_tag_name(p_normalized_name)
    and t.deleted_at is null and t.merged_into_id is null;
  if tag_id is not null then
    created := false;
    return next;
    return;
  end if;

  insert into public.tags(workspace_id, name, normalized_name, slug, description)
  values (p_workspace_id, p_name, p_normalized_name, public.tag_slug_base(p_normalized_name), p_description)
  returning id into tag_id;
  created := true;
  return next;
end;
$$;

create or replace function public.apply_folderless_migration_plan(
  p_run_id uuid,
  p_expected_manifest_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  run_row public.folderless_migration_runs%rowtype;
  item_row record;
  changed_row record;
  aboutness_row jsonb;
  aboutness_tag jsonb;
  target_parent uuid;
  resolved_tag uuid;
  target_kind text;
  target_status text;
  redirect_type text;
  redirect_target uuid;
  created_tag boolean;
  changed_count integer;
  created_tags integer := 0;
  assignments integer := 0;
  converted integer := 0;
  dropped integer := 0;
  reparented integer := 0;
  views_changed integer := 0;
  result_json jsonb;
begin
  select * into run_row from public.folderless_migration_runs where id = p_run_id;
  if not found then raise exception using errcode = 'P0002', message = 'folderless_run_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(run_row.workspace_id::text, 21021));
  lock table public.nodes, public.tags, public.tag_aliases, public.node_tags,
    public.embeddings, public.edges, public.node_links, public.saved_views,
    public.meeting_bots in share row exclusive mode;
  select * into run_row from public.folderless_migration_runs where id = p_run_id for update;

  if run_row.status = 'applied' then
    if run_row.manifest_sha256 <> p_expected_manifest_sha256 then
      raise exception using errcode = '40001', message = 'approved_manifest_sha_mismatch';
    end if;
    return run_row.result || jsonb_build_object('reused', true);
  end if;
  if run_row.status <> 'approved' then raise exception using errcode = '55000', message = 'folderless_run_not_approved'; end if;
  if run_row.manifest_sha256 <> p_expected_manifest_sha256 then raise exception using errcode = '40001', message = 'approved_manifest_sha_mismatch'; end if;
  if not exists (
    select 1 from public.folderless_workspace_guards g
    where g.workspace_id = run_row.workspace_id and g.block_new_folders
  ) then
    raise exception using errcode = '55000', message = 'folderless_write_guard_required';
  end if;
  if public.folderless_workspace_fingerprint(run_row.workspace_id) <> run_row.source_fingerprint then
    raise exception using errcode = '40001', message = 'folderless_source_changed_since_dry_run';
  end if;
  if exists (
    select 1 from public.folderless_migration_items i
    left join public.nodes n on n.id = i.folder_id and n.workspace_id = i.workspace_id
    where i.run_id = p_run_id and (n.id is null or n.kind <> 'folder')
  ) then raise exception using errcode = '40001', message = 'folderless_manifest_folder_mismatch'; end if;

  update public.folderless_migration_runs set status = 'applying', updated_at = now() where id = p_run_id;
  perform set_config('bcontext.folderless_migration_bypass', 'on', true);
  perform set_config('bcontext.syncing_tags', 'on', true);

  -- Resolve/create semantic tags, then assign each one to every surviving
  -- descendant and to the folder itself when it materializes as a real doc.
  -- Running this for every semantic ancestor naturally produces the required
  -- accumulated union while ON CONFLICT preserves current tags.
  for item_row in
    select i.* from public.folderless_migration_items i
    where i.run_id = p_run_id and i.entry #>> '{taxonomy_action,action}' = 'tag'
    order by coalesce(i.depth, 0), i.folder_id
  loop
    resolved_tag := null;
    created_tag := false;
    if jsonb_array_length(coalesce(item_row.entry #> '{taxonomy_action,candidate_tag_ids}', '[]'::jsonb)) > 1 then
      raise exception using errcode = '55000', message = 'ambiguous_folder_tag_not_reviewed';
    end if;
    if jsonb_array_length(coalesce(item_row.entry #> '{taxonomy_action,candidate_tag_ids}', '[]'::jsonb)) = 1 then
      resolved_tag := (item_row.entry #>> '{taxonomy_action,candidate_tag_ids,0}')::uuid;
      if not exists (
        select 1 from public.tags t where t.id = resolved_tag and t.workspace_id = run_row.workspace_id
          and t.deleted_at is null and t.merged_into_id is null
      ) then raise exception using errcode = '23503', message = 'reviewed_tag_not_active'; end if;
    else
      select t.id into resolved_tag from public.tags t
      where t.workspace_id = run_row.workspace_id
        and t.normalized_name = public.normalize_tag_name(item_row.entry #>> '{taxonomy_action,normalized_name}')
        and t.deleted_at is null and t.merged_into_id is null;
      if resolved_tag is null then
        insert into public.tags(workspace_id, name, normalized_name, slug, description)
        values (
          run_row.workspace_id,
          item_row.entry #>> '{taxonomy_action,normalized_name}',
          item_row.entry #>> '{taxonomy_action,normalized_name}',
          public.tag_slug_base(item_row.entry #>> '{taxonomy_action,normalized_name}'),
          'Migrated from legacy folder ' || quote_literal(coalesce(item_row.entry ->> 'title', item_row.entry ->> 'slug')) || '.'
        ) returning id into resolved_tag;
        created_tag := true;
        created_tags := created_tags + 1;
        insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, owned_by_run, after_state)
        select p_run_id, run_row.workspace_id, 'create', 'tag', resolved_tag::text, true, to_jsonb(t)
        from public.tags t where t.id = resolved_tag;
      end if;
    end if;
    update public.folderless_migration_items set resolved_tag_id = resolved_tag where run_id = p_run_id and folder_id = item_row.folder_id;

    for changed_row in
      with candidates as (
        select jsonb_array_elements_text(coalesce(item_row.entry -> 'descendant_ids', '[]'::jsonb))::uuid as node_id
        union
        select item_row.folder_id
        where item_row.entry ->> 'content_action' = 'convert_in_place'
      ), surviving as (
        select n.id
        from candidates c join public.nodes n on n.id = c.node_id and n.workspace_id = run_row.workspace_id
        where n.kind <> 'folder' or exists (
          select 1 from public.folderless_migration_items survivor
          where survivor.run_id = p_run_id and survivor.folder_id = n.id
            and survivor.entry ->> 'content_action' = 'convert_in_place'
        )
      ), inserted as (
        insert into public.node_tags(workspace_id, node_id, tag_id)
        select run_row.workspace_id, s.id, resolved_tag from surviving s
        on conflict (node_id, tag_id) do nothing
        returning node_id
      ) select node_id from inserted
    loop
      assignments := assignments + 1;
      insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, owned_by_run, after_state)
      values (p_run_id, run_row.workspace_id, 'assign_tag', 'node_tag', changed_row.node_id::text || ':' || resolved_tag::text, true,
        jsonb_build_object('node_id', changed_row.node_id, 'tag_id', resolved_tag));
    end loop;
  end loop;

  -- Optional second aboutness pass. Every assignment is a reviewed node/tag
  -- decision included in the approved SHA; the engine performs no inference.
  for aboutness_row in
    select value from jsonb_array_elements(coalesce(run_row.plan -> 'aboutness_assignments', '[]'::jsonb))
  loop
    if not exists (
      select 1 from public.nodes n where n.id = (aboutness_row ->> 'node_id')::uuid
        and n.workspace_id = run_row.workspace_id and n.kind <> 'folder'
    ) then raise exception using errcode = '23503', message = 'aboutness_node_not_real'; end if;
    for aboutness_tag in select value from jsonb_array_elements(aboutness_row -> 'tags') loop
      select resolved.tag_id, resolved.created into resolved_tag, created_tag
      from public.resolve_folderless_reviewed_tag(
        run_row.workspace_id,
        aboutness_tag ->> 'normalized_name',
        aboutness_tag ->> 'normalized_name',
        coalesce(aboutness_tag -> 'candidate_tag_ids', '[]'::jsonb),
        'Created by an explicitly reviewed folderless aboutness assignment.'
      ) resolved;
      if created_tag then
        created_tags := created_tags + 1;
        insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, owned_by_run, after_state)
        select p_run_id, run_row.workspace_id, 'create', 'tag', resolved_tag::text, true, to_jsonb(t)
        from public.tags t where t.id = resolved_tag;
      end if;
      insert into public.node_tags(workspace_id, node_id, tag_id)
      values (run_row.workspace_id, (aboutness_row ->> 'node_id')::uuid, resolved_tag)
      on conflict (node_id, tag_id) do nothing;
      get diagnostics changed_count = row_count;
      if changed_count > 0 then
        assignments := assignments + 1;
        insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, owned_by_run, after_state)
        values (
          p_run_id, run_row.workspace_id, 'assign_tag', 'node_tag',
          (aboutness_row ->> 'node_id') || ':' || resolved_tag::text, true,
          jsonb_build_object('node_id', aboutness_row ->> 'node_id', 'tag_id', resolved_tag, 'reason', aboutness_row ->> 'reason')
        );
      end if;
    end loop;
  end loop;

  -- Canonical workflow folders project onto existing node fields. Explicit
  -- non-generic kinds are never guessed over; they block the transaction.
  for item_row in select i.* from public.folderless_migration_items i where i.run_id = p_run_id order by coalesce(i.depth, 0), i.folder_id loop
    if item_row.entry #>> '{taxonomy_action,action}' = 'kind_view' then
      target_kind := item_row.entry #>> '{taxonomy_action,kind}';
      if exists (
        select 1 from public.nodes n
        where n.workspace_id = run_row.workspace_id and n.kind <> 'folder'
          and n.id in (select jsonb_array_elements_text(coalesce(item_row.entry -> 'descendant_ids', '[]'::jsonb))::uuid)
          and n.kind not in ('doc', 'entity', target_kind)
      ) then raise exception using errcode = '55000', message = 'kind_bucket_contains_explicit_kind'; end if;
      update public.nodes n set kind = target_kind
      where n.workspace_id = run_row.workspace_id and n.kind in ('doc', 'entity')
        and n.id in (select jsonb_array_elements_text(coalesce(item_row.entry -> 'descendant_ids', '[]'::jsonb))::uuid);
      get diagnostics changed_count = row_count;
      if changed_count > 0 then
        insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, after_state)
        values (p_run_id, run_row.workspace_id, 'project_kind', 'folder', item_row.folder_id::text,
          jsonb_build_object('kind', target_kind, 'count', changed_count));
      end if;
    elsif item_row.entry #>> '{taxonomy_action,action}' = 'status_view' then
      target_status := item_row.entry #>> '{taxonomy_action,status}';
      update public.nodes n set status = target_status
      where n.workspace_id = run_row.workspace_id and n.kind in ('task', 'bug')
        and n.id in (select jsonb_array_elements_text(coalesce(item_row.entry -> 'descendant_ids', '[]'::jsonb))::uuid)
        and n.status is distinct from target_status;
      get diagnostics changed_count = row_count;
      if changed_count > 0 then
        insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, after_state)
        values (p_run_id, run_row.workspace_id, 'project_status', 'folder', item_row.folder_id::text,
          jsonb_build_object('status', target_status, 'count', changed_count));
      end if;
    end if;
  end loop;

  update public.nodes n set kind = 'doc'
  from public.folderless_migration_items i
  where i.run_id = p_run_id and i.folder_id = n.id and n.workspace_id = run_row.workspace_id
    and i.entry ->> 'content_action' = 'convert_in_place' and n.kind = 'folder';
  get diagnostics converted = row_count;

  insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, after_state)
  select p_run_id, run_row.workspace_id, 'convert_in_place', 'node', i.folder_id::text, jsonb_build_object('kind', 'doc')
  from public.folderless_migration_items i where i.run_id = p_run_id and i.entry ->> 'content_action' = 'convert_in_place';

  -- A reviewed materialized folder can become a semantic child of another
  -- real node. For converted rows the reparent action moves the surviving
  -- node itself; `preserve` leaves its captured parent untouched. Dropped
  -- rows use the same action below to promote their direct children.
  for item_row in
    select i.* from public.folderless_migration_items i
    where i.run_id = p_run_id
      and i.entry ->> 'content_action' = 'convert_in_place'
      and i.entry #>> '{reparent_action,action}' <> 'preserve'
    order by coalesce(i.depth, 0), i.folder_id
  loop
    if item_row.entry #>> '{reparent_action,action}' = 'review' then
      raise exception using errcode = '55000', message = 'folder_reparent_still_needs_review';
    end if;
    target_parent := nullif(item_row.entry #>> '{reparent_action,target_parent_id}', '')::uuid;
    if target_parent = item_row.folder_id then
      raise exception using errcode = '23514', message = 'reviewed_reparent_target_is_self';
    end if;
    if target_parent is not null and not exists (
      select 1 from public.nodes n where n.id = target_parent and n.workspace_id = run_row.workspace_id and n.kind <> 'folder'
    ) then raise exception using errcode = '23503', message = 'reviewed_reparent_target_not_real'; end if;

    update public.nodes
    set parent_id = target_parent
    where id = item_row.folder_id and workspace_id = run_row.workspace_id
      and parent_id is distinct from target_parent;
    get diagnostics changed_count = row_count;
    reparented := reparented + changed_count;
    if changed_count > 0 then
      insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, after_state)
      values (p_run_id, run_row.workspace_id, 'reparent_node', 'node', item_row.folder_id::text,
        jsonb_build_object('target_parent_id', target_parent));
    end if;
  end loop;

  -- Durable typed edges/links must retain a node endpoint. The reviewed plan
  -- must convert such folders in place; apply never silently cascades them.
  if exists (
    select 1 from public.folderless_migration_items i
    where i.run_id = p_run_id and i.entry ->> 'content_action' = 'drop'
      and (
        exists (select 1 from public.edges e where e.workspace_id = run_row.workspace_id and (e.from_node = i.folder_id or e.to_node = i.folder_id))
        or exists (select 1 from public.node_links nl where nl.workspace_id = run_row.workspace_id and (nl.source_node = i.folder_id or nl.target_node = i.folder_id))
      )
  ) then raise exception using errcode = '55000', message = 'referenced_folder_requires_conversion'; end if;

  if to_regclass('public.meeting_bots') is not null and exists (
    select 1 from public.folderless_migration_items i
    join public.meeting_bots mb on mb.transcript_node_id = i.folder_id
    where i.run_id = p_run_id and i.entry ->> 'content_action' = 'drop'
  ) then raise exception using errcode = '55000', message = 'meeting_transcript_folder_requires_conversion'; end if;

  -- Promote direct children before any delete. Target ids are reviewed and
  -- must already be real nodes after the conversion step above.
  for item_row in
    select i.* from public.folderless_migration_items i
    where i.run_id = p_run_id and i.entry ->> 'content_action' = 'drop'
    order by coalesce(i.depth, 0) desc, i.folder_id
  loop
    target_parent := nullif(item_row.entry #>> '{reparent_action,target_parent_id}', '')::uuid;
    if target_parent is not null and not exists (
      select 1 from public.nodes n where n.id = target_parent and n.workspace_id = run_row.workspace_id and n.kind <> 'folder'
    ) then raise exception using errcode = '23503', message = 'reviewed_reparent_target_not_real'; end if;

    update public.nodes set parent_id = target_parent
    where workspace_id = run_row.workspace_id and parent_id = item_row.folder_id;
    get diagnostics changed_count = row_count;
    reparented := reparented + changed_count;
    if changed_count > 0 then
      insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, after_state)
      values (p_run_id, run_row.workspace_id, 'reparent_children', 'folder', item_row.folder_id::text,
        jsonb_build_object('target_parent_id', target_parent, 'count', changed_count));
    end if;

    update public.saved_views v
    set query = jsonb_set(v.query, '{root_node_ids}', coalesce((
      select jsonb_agg(to_jsonb(dedup.root_id) order by dedup.first_ordinal)
      from (
        select candidate.root_id, min(candidate.ordinality) as first_ordinal
        from (
          select case
            when root.value #>> '{}' = item_row.folder_id::text then target_parent::text
            else root.value #>> '{}'
          end as root_id, root.ordinality
          from jsonb_array_elements(coalesce(v.query -> 'root_node_ids', '[]'::jsonb)) with ordinality root(value, ordinality)
        ) candidate
        where candidate.root_id is not null
        group by candidate.root_id
      ) dedup
    ), '[]'::jsonb), true)
    where v.workspace_id = run_row.workspace_id
      and coalesce(v.query -> 'root_node_ids', '[]'::jsonb) @> jsonb_build_array(item_row.folder_id::text);
    get diagnostics changed_count = row_count;
    views_changed := views_changed + changed_count;

    resolved_tag := (select i.resolved_tag_id from public.folderless_migration_items i where i.run_id = p_run_id and i.folder_id = item_row.folder_id);
    if resolved_tag is not null then redirect_type := 'tag'; redirect_target := resolved_tag;
    elsif target_parent is not null then redirect_type := 'node'; redirect_target := target_parent;
    else redirect_type := 'gone'; redirect_target := null;
    end if;
    insert into public.node_redirects(workspace_id, legacy_node_id, legacy_slug, target_type, target_id, run_id, metadata)
    values (run_row.workspace_id, item_row.folder_id, item_row.entry ->> 'slug', redirect_type, redirect_target, p_run_id,
      jsonb_build_object('manifest_sha256', run_row.manifest_sha256, 'title', item_row.entry ->> 'title'))
    on conflict (workspace_id, legacy_node_id) do nothing;
  end loop;

  delete from public.nodes n using public.folderless_migration_items i
  where i.run_id = p_run_id and i.folder_id = n.id and n.workspace_id = run_row.workspace_id
    and i.entry ->> 'content_action' = 'drop';
  get diagnostics dropped = row_count;

  if exists (select 1 from public.nodes where workspace_id = run_row.workspace_id and kind = 'folder') then
    raise exception using errcode = '55000', message = 'folderless_apply_left_unplanned_folders';
  end if;
  if run_row.require_tagged and exists (
    select 1 from public.nodes n where n.workspace_id = run_row.workspace_id
      and not exists (select 1 from public.node_tags nt where nt.workspace_id = n.workspace_id and nt.node_id = n.id)
  ) then raise exception using errcode = '55000', message = 'folderless_require_tagged_failed'; end if;

  perform set_config('bcontext.syncing_tags', 'off', true);
  for changed_row in
    select distinct split_part(l.resource_id, ':', 1)::uuid as node_id
    from public.folderless_migration_ledger l
    where l.run_id = p_run_id and l.operation = 'assign_tag'
  loop
    perform public.sync_node_legacy_tag_fields(changed_row.node_id);
  end loop;

  update public.folderless_migration_items set applied_at = now() where run_id = p_run_id;
  result_json := jsonb_build_object(
    'id', p_run_id, 'status', 'applied', 'manifest_sha256', run_row.manifest_sha256,
    'created_tags', created_tags, 'created_assignments', assignments,
    'converted_folders', converted, 'dropped_folders', dropped,
    'reparented_nodes', reparented, 'saved_views_changed', views_changed,
    'reused', false
  );
  update public.folderless_migration_runs
  set status = 'applied', applied_at = now(), updated_at = now(), result = result_json,
      post_apply_fingerprint = public.folderless_workspace_fingerprint(run_row.workspace_id), error = null
  where id = p_run_id;
  insert into public.activity(workspace_id, actor_kind, verb, payload)
  values (run_row.workspace_id, 'system', 'folderless_migrated', result_json - 'reused');
  perform set_config('bcontext.folderless_migration_bypass', 'off', true);
  return result_json;
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  perform set_config('bcontext.folderless_migration_bypass', 'off', true);
  raise;
end;
$$;

create or replace function public.rollback_folderless_migration_plan(
  p_run_id uuid,
  p_expected_manifest_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  run_row public.folderless_migration_runs%rowtype;
  node_json jsonb;
  tag_json jsonb;
  view_json jsonb;
  edge_json jsonb;
  link_json jsonb;
  assignment_json jsonb;
  embedding_json jsonb;
  result_json jsonb;
begin
  select * into run_row from public.folderless_migration_runs where id = p_run_id;
  if not found then raise exception using errcode = 'P0002', message = 'folderless_run_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(run_row.workspace_id::text, 21021));
  lock table public.nodes, public.tags, public.tag_aliases, public.node_tags,
    public.embeddings, public.edges, public.node_links, public.saved_views,
    public.meeting_bots in share row exclusive mode;
  select * into run_row from public.folderless_migration_runs where id = p_run_id for update;
  if run_row.status = 'rolled_back' then
    if run_row.manifest_sha256 <> p_expected_manifest_sha256 then raise exception using errcode = '40001', message = 'approved_manifest_sha_mismatch'; end if;
    return run_row.result || jsonb_build_object('reused', true);
  end if;
  if run_row.status <> 'applied' then raise exception using errcode = '55000', message = 'folderless_run_not_applied'; end if;
  if run_row.manifest_sha256 <> p_expected_manifest_sha256 then raise exception using errcode = '40001', message = 'approved_manifest_sha_mismatch'; end if;
  if public.folderless_workspace_fingerprint(run_row.workspace_id) <> run_row.post_apply_fingerprint then
    raise exception using errcode = '40001', message = 'folderless_rollback_conflicts_with_later_writes';
  end if;

  update public.folderless_migration_runs set status = 'rolling_back', updated_at = now() where id = p_run_id;
  perform set_config('bcontext.folderless_migration_bypass', 'on', true);
  perform set_config('bcontext.syncing_tags', 'on', true);
  perform set_config('bcontext.folderless_restore', 'on', true);

  delete from public.node_tags where workspace_id = run_row.workspace_id;
  delete from public.node_links where workspace_id = run_row.workspace_id;
  delete from public.edges where workspace_id = run_row.workspace_id;
  delete from public.embeddings where workspace_id = run_row.workspace_id;

  -- Restore every missing row with a null parent first, then restore exact
  -- fields and parent links once all stable ids exist.
  for node_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'nodes') loop
    insert into public.nodes(
      id, workspace_id, parent_id, kind, category, slug, title, content_md, data,
      status, priority, assignee_id, due_date, position, created_by, created_at, updated_at
    ) values (
      (node_json ->> 'id')::uuid, (node_json ->> 'workspace_id')::uuid, null,
      node_json ->> 'kind', node_json ->> 'category', node_json ->> 'slug', node_json ->> 'title',
      coalesce(node_json ->> 'content_md', ''), coalesce(node_json -> 'data', '{}'::jsonb),
      node_json ->> 'status', node_json ->> 'priority', nullif(node_json ->> 'assignee_id', '')::uuid,
      nullif(node_json ->> 'due_date', '')::timestamptz, coalesce((node_json ->> 'position')::integer, 0),
      nullif(node_json ->> 'created_by', '')::uuid, (node_json ->> 'created_at')::timestamptz,
      (node_json ->> 'updated_at')::timestamptz
    ) on conflict (id) do update set
      parent_id = null, kind = excluded.kind, category = excluded.category, slug = excluded.slug,
      title = excluded.title, content_md = excluded.content_md, data = excluded.data,
      status = excluded.status, priority = excluded.priority, assignee_id = excluded.assignee_id,
      due_date = excluded.due_date, position = excluded.position, created_by = excluded.created_by,
      created_at = excluded.created_at, updated_at = excluded.updated_at;
  end loop;
  for node_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'nodes') loop
    update public.nodes set
      parent_id = nullif(node_json ->> 'parent_id', '')::uuid,
      updated_at = (node_json ->> 'updated_at')::timestamptz
    where id = (node_json ->> 'id')::uuid and workspace_id = run_row.workspace_id;
  end loop;

  delete from public.tags t
  where t.workspace_id = run_row.workspace_id
    and not exists (
      select 1 from jsonb_array_elements(run_row.rollback_snapshot -> 'tags') original
      where original ->> 'id' = t.id::text
    );
  for tag_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'tags') loop
    update public.tags set
      name = tag_json ->> 'name', normalized_name = tag_json ->> 'normalized_name', slug = tag_json ->> 'slug',
      description = tag_json ->> 'description', merged_into_id = nullif(tag_json ->> 'merged_into_id', '')::uuid,
      deleted_at = nullif(tag_json ->> 'deleted_at', '')::timestamptz,
      created_by = nullif(tag_json ->> 'created_by', '')::uuid,
      created_at = (tag_json ->> 'created_at')::timestamptz,
      updated_at = (tag_json ->> 'updated_at')::timestamptz
    where id = (tag_json ->> 'id')::uuid and workspace_id = run_row.workspace_id;
  end loop;

  for assignment_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'node_tags') loop
    insert into public.node_tags(workspace_id, node_id, tag_id, created_at)
    values (
      (assignment_json ->> 'workspace_id')::uuid, (assignment_json ->> 'node_id')::uuid,
      (assignment_json ->> 'tag_id')::uuid, (assignment_json ->> 'created_at')::timestamptz
    ) on conflict (node_id, tag_id) do nothing;
  end loop;
  for embedding_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'embeddings') loop
    insert into public.embeddings(
      id, workspace_id, node_id, chunk_index, content, embedding, metadata,
      created_at, embedding_version, context_prefix
    ) values (
      (embedding_json ->> 'id')::uuid, (embedding_json ->> 'workspace_id')::uuid,
      (embedding_json ->> 'node_id')::uuid, (embedding_json ->> 'chunk_index')::integer,
      embedding_json ->> 'content', nullif(embedding_json ->> 'embedding', '')::vector,
      coalesce(embedding_json -> 'metadata', '{}'::jsonb), (embedding_json ->> 'created_at')::timestamptz,
      coalesce(embedding_json ->> 'embedding_version', 'legacy'),
      coalesce(embedding_json ->> 'context_prefix', '')
    ) on conflict (id) do nothing;
  end loop;
  for edge_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'edges') loop
    insert into public.edges(id, workspace_id, from_node, to_node, relation, created_at)
    values (
      (edge_json ->> 'id')::uuid, (edge_json ->> 'workspace_id')::uuid,
      (edge_json ->> 'from_node')::uuid, (edge_json ->> 'to_node')::uuid,
      edge_json ->> 'relation', (edge_json ->> 'created_at')::timestamptz
    ) on conflict (id) do nothing;
  end loop;
  -- Node content/data restore triggers rebuild the link projection with fresh
  -- timestamps. Replace that derived projection with the captured rows.
  delete from public.node_links where workspace_id = run_row.workspace_id;
  for link_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'node_links') loop
    insert into public.node_links(workspace_id, source_node, target_node, block_id, origin, created_at)
    values (
      (link_json ->> 'workspace_id')::uuid, (link_json ->> 'source_node')::uuid,
      (link_json ->> 'target_node')::uuid, coalesce(link_json ->> 'block_id', ''),
      link_json ->> 'origin', (link_json ->> 'created_at')::timestamptz
    ) on conflict (source_node, target_node, origin, block_id) do nothing;
  end loop;
  for view_json in select value from jsonb_array_elements(run_row.rollback_snapshot -> 'saved_views') loop
    update public.saved_views set
      query = view_json -> 'query', presentation = view_json -> 'presentation',
      version = (view_json ->> 'version')::bigint,
      updated_at = (view_json ->> 'updated_at')::timestamptz
    where id = (view_json ->> 'id')::uuid and workspace_id = run_row.workspace_id;
  end loop;

  delete from public.node_redirects where run_id = p_run_id;
  if run_row.rollback_snapshot -> 'guard' = 'null'::jsonb then
    delete from public.folderless_workspace_guards where workspace_id = run_row.workspace_id;
  else
    insert into public.folderless_workspace_guards(
      workspace_id, block_new_folders, legacy_folders_read_only, activated_by_run_id, updated_at
    ) values (
      run_row.workspace_id,
      coalesce((run_row.rollback_snapshot #>> '{guard,block_new_folders}')::boolean, false),
      coalesce((run_row.rollback_snapshot #>> '{guard,legacy_folders_read_only}')::boolean, false),
      nullif(run_row.rollback_snapshot #>> '{guard,activated_by_run_id}', '')::uuid,
      coalesce((run_row.rollback_snapshot #>> '{guard,updated_at}')::timestamptz, now())
    ) on conflict (workspace_id) do update set
      block_new_folders = excluded.block_new_folders,
      legacy_folders_read_only = excluded.legacy_folders_read_only,
      activated_by_run_id = excluded.activated_by_run_id,
      updated_at = excluded.updated_at;
  end if;

  perform set_config('bcontext.syncing_tags', 'off', true);
  perform set_config('bcontext.folderless_restore', 'off', true);
  result_json := jsonb_build_object(
    'id', p_run_id, 'status', 'rolled_back', 'manifest_sha256', run_row.manifest_sha256, 'reused', false
  );
  update public.folderless_migration_items set rolled_back_at = now() where run_id = p_run_id;
  update public.folderless_migration_runs
  set status = 'rolled_back', rolled_back_at = now(), updated_at = now(), result = result_json, error = null
  where id = p_run_id;
  insert into public.folderless_migration_ledger(run_id, workspace_id, operation, resource_type, resource_id, after_state)
  values (p_run_id, run_row.workspace_id, 'rollback', 'workspace', run_row.workspace_id::text, result_json);
  insert into public.activity(workspace_id, actor_kind, verb, payload)
  values (run_row.workspace_id, 'system', 'folderless_rolled_back', result_json - 'reused');
  perform set_config('bcontext.folderless_migration_bypass', 'off', true);
  return result_json;
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  perform set_config('bcontext.folderless_restore', 'off', true);
  perform set_config('bcontext.folderless_migration_bypass', 'off', true);
  raise;
end;
$$;

revoke all on function public.folderless_workspace_fingerprint(uuid) from public, anon, authenticated;
revoke all on function public.capture_folderless_workspace(uuid) from public, anon, authenticated;
revoke all on function public.folderless_rollback_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.resolve_node_redirect(uuid, uuid, text) from public, anon;
revoke all on function public.register_folderless_migration_plan(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.approve_folderless_migration_plan(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.set_folderless_workspace_guard(uuid, boolean, boolean, uuid) from public, anon, authenticated;
revoke all on function public.resolve_folderless_reviewed_tag(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.apply_folderless_migration_plan(uuid, text) from public, anon, authenticated;
revoke all on function public.rollback_folderless_migration_plan(uuid, text) from public, anon, authenticated;

grant execute on function public.folderless_workspace_fingerprint(uuid) to service_role;
grant execute on function public.capture_folderless_workspace(uuid) to service_role;
grant execute on function public.resolve_node_redirect(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.register_folderless_migration_plan(uuid, jsonb, text) to service_role;
grant execute on function public.approve_folderless_migration_plan(uuid, text, uuid) to service_role;
grant execute on function public.set_folderless_workspace_guard(uuid, boolean, boolean, uuid) to service_role;
grant execute on function public.apply_folderless_migration_plan(uuid, text) to service_role;
grant execute on function public.rollback_folderless_migration_plan(uuid, text) to service_role;

revoke insert, update, delete on public.folderless_migration_runs from anon, authenticated;
revoke insert, update, delete on public.folderless_migration_items from anon, authenticated;
revoke insert, update, delete on public.folderless_migration_ledger from anon, authenticated;
revoke insert, update, delete on public.node_redirects from anon, authenticated;
revoke insert, update, delete on public.folderless_workspace_guards from anon, authenticated;

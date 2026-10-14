-- UIX-22 — close every non-migration write path after the folderless cutover.
--
-- UIX-21 owns the migration engine, workspace ledger and the transaction-local
-- `bcontext.folderless_migration_bypass` switch in 0042. This migration only
-- hardens normal writes. Legacy folder/category values remain readable.

create or replace function public.enforce_folderless_node_mutability()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if current_setting('bcontext.folderless_migration_bypass', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.kind = 'folder' then
      raise exception using errcode = '23514', message = 'folder_kind_retired';
    end if;
    return new;
  end if;

  if old.kind = 'folder' then
    raise exception using errcode = '55000', message = 'legacy_folder_read_only';
  end if;
  if tg_op = 'UPDATE' and new.kind = 'folder' then
    raise exception using errcode = '23514', message = 'folder_kind_retired';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists nodes_folderless_contract_guard on public.nodes;
create trigger nodes_folderless_contract_guard
before insert or update or delete on public.nodes
for each row execute function public.enforce_folderless_node_mutability();

create or replace function public.enforce_folderless_hierarchy()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  parent_workspace uuid;
  parent_kind text;
  closes_cycle boolean;
begin
  if current_setting('bcontext.folderless_migration_bypass', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' and new.category is not null then
    raise exception using errcode = '23514', message = 'category_retired';
  end if;
  if tg_op = 'UPDATE' and new.category is distinct from old.category then
    raise exception using errcode = '23514', message = 'category_retired';
  end if;

  if new.parent_id is null
    or (tg_op = 'UPDATE' and new.parent_id is not distinct from old.parent_id) then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception using errcode = '23514', message = 'parent_cycle';
  end if;

  select n.workspace_id, n.kind
    into parent_workspace, parent_kind
  from public.nodes n
  where n.id = new.parent_id;
  if not found
    or parent_workspace is distinct from new.workspace_id
    or parent_kind = 'folder' then
    raise exception using errcode = '23503', message = 'invalid_parent';
  end if;

  with recursive ancestors(id, parent_id, path) as (
    select n.id, n.parent_id, array[n.id]
    from public.nodes n
    where n.id = new.parent_id
    union all
    select n.id, n.parent_id, a.path || n.id
    from ancestors a
    join public.nodes n on n.id = a.parent_id
    where not n.id = any(a.path)
  )
  select exists(select 1 from ancestors where id = new.id)
    into closes_cycle;
  if closes_cycle then
    raise exception using errcode = '23514', message = 'parent_cycle';
  end if;

  return new;
end;
$$;

drop trigger if exists nodes_folderless_hierarchy_guard on public.nodes;
create trigger nodes_folderless_hierarchy_guard
before insert or update of parent_id, category on public.nodes
for each row execute function public.enforce_folderless_hierarchy();

create or replace function public.enforce_folderless_node_tag_target()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  target_node uuid;
  target_workspace uuid;
begin
  if tg_op = 'DELETE' then
    target_node := old.node_id;
    target_workspace := old.workspace_id;
  else
    target_node := new.node_id;
    target_workspace := new.workspace_id;
  end if;
  if current_setting('bcontext.folderless_migration_bypass', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if exists (
    select 1
    from public.nodes n
    where n.id = target_node
      and n.workspace_id = target_workspace
      and n.kind = 'folder'
  ) then
    raise exception using errcode = '55000', message = 'legacy_folder_read_only';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists node_tags_folderless_guard on public.node_tags;
create trigger node_tags_folderless_guard
before insert or update or delete on public.node_tags
for each row execute function public.enforce_folderless_node_tag_target();

-- Keep data.tags as a temporary read mirror for old clients, but never infer
-- or mutate nodes.category. Folder rows are never touched by tag lifecycle
-- side effects once 0042 marks them read-only.
create or replace function public.sync_node_legacy_tag_fields(p_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  next_tags jsonb;
  target_kind text;
begin
  select n.kind into target_kind
  from public.nodes n
  where n.id = p_node_id;
  if not found or target_kind = 'folder' then return; end if;

  select coalesce(jsonb_agg(to_jsonb(x.normalized_name) order by x.normalized_name), '[]'::jsonb)
  into next_tags
  from (
    select distinct t.normalized_name
    from public.node_tags nt
    join public.tags t
      on t.id = nt.tag_id
     and t.workspace_id = nt.workspace_id
    where nt.node_id = p_node_id
      and t.deleted_at is null
      and t.merged_into_id is null
  ) x;

  perform set_config('bcontext.syncing_tags', 'on', true);
  update public.nodes
  set data = jsonb_set(coalesce(data, '{}'::jsonb), '{tags}', next_tags, true)
  where id = p_node_id
    and coalesce(data->'tags', 'null'::jsonb) is distinct from next_tags;
  perform set_config('bcontext.syncing_tags', 'off', true);
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  raise;
end;
$$;

-- Replace the service-role assignment RPC so even an empty assignment is a
-- real guarded operation against a legacy folder (a row trigger alone would
-- miss the no-op case). The whole function remains transactional.
create or replace function public.assign_node_tags(
  p_workspace_id uuid,
  p_node_id uuid,
  p_tag_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  requested_count integer;
  valid_count integer;
  target_kind text;
begin
  select n.kind into target_kind
  from public.nodes n
  where n.id = p_node_id and n.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'node_not_found';
  end if;
  if target_kind = 'folder'
    and current_setting('bcontext.folderless_migration_bypass', true) is distinct from 'on' then
    raise exception using errcode = '55000', message = 'legacy_folder_read_only';
  end if;

  select count(distinct x)::integer into requested_count
  from unnest(coalesce(p_tag_ids, '{}'::uuid[])) x;
  select count(*)::integer into valid_count
  from public.tags t
  where t.workspace_id = p_workspace_id
    and t.id = any(coalesce(p_tag_ids, '{}'::uuid[]))
    and t.deleted_at is null
    and t.merged_into_id is null;
  if requested_count <> valid_count then
    raise exception using errcode = '23503', message = 'unknown_or_inactive_tag';
  end if;

  perform set_config('bcontext.syncing_tags', 'on', true);
  delete from public.node_tags nt where nt.node_id = p_node_id;
  insert into public.node_tags(workspace_id, node_id, tag_id)
  select p_workspace_id, p_node_id, distinct_ids.id
  from (
    select distinct unnest(coalesce(p_tag_ids, '{}'::uuid[])) as id
  ) distinct_ids;
  perform set_config('bcontext.syncing_tags', 'off', true);
  perform public.sync_node_legacy_tag_fields(p_node_id);
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  raise;
end;
$$;

-- Signup provisioning now creates an empty personal workspace. Domain tags
-- still arrive through workspaces_seed_domain_tags; no structural nodes are
-- synthesized by onboarding.
create or replace function public.provision_personal_zone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_org uuid;
  v_ws uuid;
  v_short text := substr(replace(new.id::text, '-', ''), 1, 12);
begin
  insert into public.user_account_plans (user_id, plan)
    values (new.id, 'account_free')
    on conflict (user_id) do nothing;

  if exists (
    select 1
    from public.workspaces w
    join public.memberships m on m.workspace_id = w.id
    where m.user_id = new.id and w.is_personal
  ) then
    return new;
  end if;

  insert into public.organizations (slug, name)
    values ('personal-' || v_short, 'Personal')
    returning id into v_org;
  insert into public.workspaces (organization_id, slug, name, description, is_personal, plan)
    values (v_org, 'personal-' || v_short, 'Personal',
            'Your private zone — never shared.', true, 'ws_free')
    returning id into v_ws;
  insert into public.memberships (user_id, workspace_id, role)
    values (new.id, v_ws, 'owner') on conflict do nothing;
  insert into public.organization_memberships (user_id, organization_id, role)
    values (new.id, v_org, 'owner') on conflict do nothing;
  return new;
exception when others then
  return new;
end;
$$;

revoke all on function public.enforce_folderless_hierarchy() from public, anon, authenticated;
revoke all on function public.enforce_folderless_node_mutability() from public, anon, authenticated;
revoke all on function public.enforce_folderless_node_tag_target() from public, anon, authenticated;
revoke all on function public.provision_personal_zone() from public, anon, authenticated;

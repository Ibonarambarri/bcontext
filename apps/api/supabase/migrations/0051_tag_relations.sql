-- 0051_tag_relations.sql
--
-- Tags-as-a-graph: workspace-scoped dependency edges between tags. Two kinds
-- of edge, both directed rows in one table:
--
--   relation = 'parent'  — from_tag_id IS A CHILD OF to_tag_id. Multiple
--                          parents per tag are allowed (a DAG, not a strict
--                          tree); the app layer rejects any insert that
--                          would introduce a cycle by walking ancestors.
--   relation = 'related'  — symmetric association. A single row encodes the
--                          pair; readers must treat (from, to) and (to,
--                          from) as equivalent.
--
-- Tags never grant permissions (see 0036); this table doesn't change that.
-- RLS mirrors public.tags exactly: workspace members can read, only
-- workspace admins can write.

create table if not exists public.tag_relations (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_tag_id uuid not null,
  to_tag_id uuid not null,
  relation text not null check (relation in ('parent', 'related')),
  created_at timestamptz not null default now(),
  constraint tag_relations_no_self_loop check (from_tag_id <> to_tag_id),
  constraint tag_relations_unique unique (workspace_id, from_tag_id, to_tag_id, relation),
  constraint tag_relations_from_same_workspace_fk
    foreign key (from_tag_id, workspace_id)
    references public.tags(id, workspace_id)
    on delete cascade,
  constraint tag_relations_to_same_workspace_fk
    foreign key (to_tag_id, workspace_id)
    references public.tags(id, workspace_id)
    on delete cascade
);

create index if not exists tag_relations_workspace_from_idx
  on public.tag_relations(workspace_id, from_tag_id);
create index if not exists tag_relations_workspace_to_idx
  on public.tag_relations(workspace_id, to_tag_id);

alter table public.tag_relations enable row level security;

create policy tag_relations_member_read on public.tag_relations
  for select using (public.is_workspace_member(workspace_id));
create policy tag_relations_admin_insert on public.tag_relations
  for insert with check (public.is_workspace_admin(workspace_id));
create policy tag_relations_admin_delete on public.tag_relations
  for delete using (public.is_workspace_admin(workspace_id));

-- Extend merge/delete (defined in 0036) so tag_relations stays consistent:
-- merging repoints edges onto the target and drops any self-loop or
-- duplicate the repoint would create; deleting drops the tag's edges since
-- tags are soft-deleted (deleted_at) rather than row-deleted, so the FK
-- ON DELETE CASCADE above never fires for the normal delete path.

create or replace function public.merge_workspace_tags(
  p_workspace_id uuid,
  p_source_id uuid,
  p_target_id uuid
)
returns public.tags
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  source_tag public.tags;
  target_tag public.tags;
  affected_nodes uuid[];
  affected uuid;
begin
  if p_source_id = p_target_id then
    raise exception using errcode = '22023', message = 'cannot_merge_tag_into_itself';
  end if;
  select * into source_tag from public.tags t
  where t.id = p_source_id and t.workspace_id = p_workspace_id
    and t.deleted_at is null and t.merged_into_id is null
  for update;
  select * into target_tag from public.tags t
  where t.id = p_target_id and t.workspace_id = p_workspace_id
    and t.deleted_at is null and t.merged_into_id is null
  for update;
  if source_tag.id is null or target_tag.id is null then
    raise exception using errcode = 'P0002', message = 'tag_not_found';
  end if;

  select coalesce(array_agg(distinct nt.node_id), '{}'::uuid[])
  into affected_nodes
  from public.node_tags nt
  where nt.tag_id in (p_source_id, p_target_id);

  perform set_config('bcontext.syncing_tags', 'on', true);
  insert into public.node_tags(workspace_id, node_id, tag_id)
  select p_workspace_id, nt.node_id, p_target_id
  from public.node_tags nt
  where nt.tag_id = p_source_id
  on conflict (node_id, tag_id) do nothing;
  delete from public.node_tags nt where nt.tag_id = p_source_id;

  -- Repoint tag_relations edges from source onto target. Skip (then drop)
  -- any edge that would become a self-loop or duplicate an edge the target
  -- already has.
  update public.tag_relations
  set from_tag_id = p_target_id
  where from_tag_id = p_source_id
    and to_tag_id <> p_target_id
    and not exists (
      select 1 from public.tag_relations existing
      where existing.from_tag_id = p_target_id
        and existing.to_tag_id = tag_relations.to_tag_id
        and existing.relation = tag_relations.relation
    );
  delete from public.tag_relations where from_tag_id = p_source_id;

  update public.tag_relations
  set to_tag_id = p_target_id
  where to_tag_id = p_source_id
    and from_tag_id <> p_target_id
    and not exists (
      select 1 from public.tag_relations existing
      where existing.to_tag_id = p_target_id
        and existing.from_tag_id = tag_relations.from_tag_id
        and existing.relation = tag_relations.relation
    );
  delete from public.tag_relations where to_tag_id = p_source_id;

  insert into public.tag_aliases(workspace_id, tag_id, normalized_name, slug, reason)
  values (p_workspace_id, p_target_id, source_tag.normalized_name, source_tag.slug, 'merge')
  on conflict (workspace_id, normalized_name)
  do update set tag_id = excluded.tag_id, slug = excluded.slug, reason = excluded.reason;
  update public.tag_aliases set tag_id = p_target_id
  where workspace_id = p_workspace_id and tag_id = p_source_id;
  update public.tags
  set merged_into_id = p_target_id, deleted_at = now()
  where id = p_source_id;
  perform set_config('bcontext.syncing_tags', 'off', true);

  foreach affected in array affected_nodes loop
    perform public.sync_node_legacy_tag_fields(affected);
  end loop;
  return target_tag;
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  raise;
end;
$$;

create or replace function public.delete_workspace_tag(
  p_workspace_id uuid,
  p_tag_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  affected_nodes uuid[];
  affected uuid;
begin
  if not exists (
    select 1 from public.tags t
    where t.id = p_tag_id and t.workspace_id = p_workspace_id
      and t.deleted_at is null and t.merged_into_id is null
  ) then return false; end if;

  select coalesce(array_agg(distinct nt.node_id), '{}'::uuid[])
  into affected_nodes from public.node_tags nt where nt.tag_id = p_tag_id;
  perform set_config('bcontext.syncing_tags', 'on', true);
  delete from public.node_tags nt where nt.tag_id = p_tag_id;
  delete from public.tag_aliases a where a.tag_id = p_tag_id;
  delete from public.tag_relations tr
  where tr.from_tag_id = p_tag_id or tr.to_tag_id = p_tag_id;
  update public.tags set deleted_at = now() where id = p_tag_id;
  perform set_config('bcontext.syncing_tags', 'off', true);
  foreach affected in array affected_nodes loop
    perform public.sync_node_legacy_tag_fields(affected);
  end loop;
  return true;
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  raise;
end;
$$;

revoke all on function public.merge_workspace_tags(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_workspace_tag(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_workspace_tags(uuid, uuid, uuid) to service_role;
grant execute on function public.delete_workspace_tag(uuid, uuid) to service_role;

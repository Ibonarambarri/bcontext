-- UIX-01 production hardening after applying 0036.
--
-- 0036 remains corrected for clean installs; this incremental migration
-- applies the same changes to databases where 0036 is already recorded.

alter function public.normalize_tag_name(text)
  set search_path = pg_catalog;
alter function public.tag_slug_base(text)
  set search_path = pg_catalog;

revoke all on function public.seed_workspace_domain_tags_trigger()
  from public, anon, authenticated;

drop index if exists public.tags_merged_into_idx;
drop index if exists public.tag_aliases_tag_idx;
drop index if exists public.node_tags_node_idx;

create index if not exists tags_merged_workspace_idx
  on public.tags(merged_into_id, workspace_id);
create index if not exists tags_created_by_idx
  on public.tags(created_by);
create index if not exists tag_aliases_tag_workspace_idx
  on public.tag_aliases(tag_id, workspace_id);
create index if not exists node_tags_node_workspace_idx
  on public.node_tags(node_id, workspace_id);
create index if not exists node_tags_tag_workspace_idx
  on public.node_tags(tag_id, workspace_id);

drop policy if exists tag_aliases_admin_write on public.tag_aliases;
drop policy if exists tag_aliases_admin_insert on public.tag_aliases;
drop policy if exists tag_aliases_admin_update on public.tag_aliases;
drop policy if exists tag_aliases_admin_delete on public.tag_aliases;

create policy tag_aliases_admin_insert on public.tag_aliases
  for insert with check (public.is_workspace_admin(workspace_id));
create policy tag_aliases_admin_update on public.tag_aliases
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy tag_aliases_admin_delete on public.tag_aliases
  for delete using (public.is_workspace_admin(workspace_id));

drop policy if exists node_tags_contributor_insert on public.node_tags;
create policy node_tags_contributor_insert on public.node_tags
  for insert with check (
    exists (
      select 1 from public.memberships m
      where m.workspace_id = node_tags.workspace_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner', 'admin', 'editor', 'agent')
    )
    and exists (
      select 1 from public.tags t
      where t.id = node_tags.tag_id
        and t.workspace_id = node_tags.workspace_id
        and t.deleted_at is null
        and t.merged_into_id is null
    )
  );

drop policy if exists node_tags_contributor_delete on public.node_tags;
create policy node_tags_contributor_delete on public.node_tags
  for delete using (
    exists (
      select 1 from public.memberships m
      where m.workspace_id = node_tags.workspace_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner', 'admin', 'editor', 'agent')
    )
  );

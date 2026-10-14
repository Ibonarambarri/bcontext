-- UIX-21 — keep registration below the API statement timeout by capturing the
-- rollback state once and deriving the source fingerprint from that exact
-- capture. The object without `guard` is byte-for-byte the payload hashed by
-- folderless_workspace_fingerprint().

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
  rollback_state jsonb;
  current_fingerprint text;
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

  rollback_state := public.folderless_rollback_snapshot(p_workspace_id);
  current_fingerprint := encode(
    extensions.digest(convert_to((rollback_state - 'guard')::text, 'utf8'), 'sha256'),
    'hex'
  );
  if current_fingerprint <> (p_plan ->> 'source_fingerprint') then
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
    p_plan ->> 'source_fingerprint', rollback_state,
    coalesce((p_plan ->> 'require_tagged')::boolean, false)
  ) returning * into run_row;

  insert into public.folderless_migration_items(run_id, workspace_id, folder_id, depth, entry)
  select run_row.id, p_workspace_id, (entry ->> 'folder_id')::uuid,
    nullif(entry ->> 'depth', '')::integer, entry
  from jsonb_array_elements(coalesce(p_plan #> '{manifest,folders}', '[]'::jsonb)) entry;

  return jsonb_build_object('id', run_row.id, 'status', run_row.status, 'manifest_sha256', run_row.manifest_sha256, 'reused', false);
end;
$$;

revoke all on function public.register_folderless_migration_plan(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.register_folderless_migration_plan(uuid, jsonb, text) to service_role;

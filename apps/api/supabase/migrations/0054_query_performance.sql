-- 0054 — query performance for the per-view read model (NOT applied yet).
--
-- 1. Keyset index for the Changes feed: /api/activity pages by
--    (created_at desc, id desc) inside one workspace. The existing
--    activity_workspace_idx(workspace_id, created_at desc) makes the tiebreak
--    re-sort id in memory; this composite matches the cursor ordering exactly.
create index if not exists activity_workspace_created_id_idx
  on public.activity (workspace_id, created_at desc, id desc);

-- 2. Source facet / source filter: both /api/activity/facets and the
--    `payload->>source` equality filter on the feed read this expression.
create index if not exists activity_workspace_source_idx
  on public.activity (workspace_id, (payload->>'source'));

-- 3. Aggregated tag usage for the Tags view: one row per tag instead of
--    shipping every node_tags assignment row to the app server. The storage
--    adapter falls back to the raw scan while this function is not deployed.
drop function if exists public.count_tag_usage(uuid);
create function public.count_tag_usage(p_workspace_id uuid)
returns table (tag_id uuid, usage_count bigint)
language sql stable security invoker set search_path = public, pg_catalog as $$
  select nt.tag_id, count(*)::bigint
  from public.node_tags nt
  where nt.workspace_id = p_workspace_id
  group by nt.tag_id;
$$;
revoke all on function public.count_tag_usage(uuid) from public, anon, authenticated;
grant execute on function public.count_tag_usage(uuid) to service_role;

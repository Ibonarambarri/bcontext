-- Subtask progress on node summaries.
--
-- Board and list cards paint from `list_node_summaries`, which by design never
-- ships `data` (bodies and arbitrary JSON stay per-node). Subtasks live in
-- `data.subtasks[]`, so the only way a card can say "2/5" without fetching
-- every node is for the summary row to carry the two counts. Computed here,
-- in the same pass that already reads `data->>'source'`; NULL when the node
-- has no subtasks key so callers can tell "none" from "0 of 0".
begin;

drop function if exists public.list_node_summaries(uuid, integer);
create function public.list_node_summaries(p_workspace_id uuid, p_limit integer default 2000)
returns table (id uuid, workspace_id uuid, parent_id uuid, kind text, slug text,
  title text, status text, priority text, assignee_id uuid, due_date timestamptz,
  "position" integer, created_by uuid, created_at timestamptz, updated_at timestamptz,
  source text, tags jsonb, subtasks_total integer, subtasks_done integer)
language sql stable security invoker set search_path=public,pg_catalog as $$
  select n.id,n.workspace_id,n.parent_id,n.kind::text,n.slug,n.title,n.status::text,
    n.priority::text,n.assignee_id,n.due_date,n.position,n.created_by,n.created_at,n.updated_at,
    nullif(n.data->>'source',''),coalesce((select jsonb_agg(jsonb_build_object(
        'id',t.id,'workspace_id',t.workspace_id,'name',t.name,
        'normalized_name',t.normalized_name,'slug',t.slug,'description',t.description,
        'merged_into_id',t.merged_into_id,'deleted_at',t.deleted_at,
        'created_at',t.created_at,'updated_at',t.updated_at
      ) order by t.normalized_name)
      from public.node_tags nt join public.tags t on t.id=nt.tag_id and t.workspace_id=nt.workspace_id
      where nt.workspace_id=n.workspace_id and nt.node_id=n.id and t.deleted_at is null and t.merged_into_id is null),'[]'::jsonb),
    case when jsonb_typeof(n.data->'subtasks')='array' then jsonb_array_length(n.data->'subtasks') end,
    case when jsonb_typeof(n.data->'subtasks')='array' then
      (select count(*)::integer from jsonb_array_elements(n.data->'subtasks') s where (s->>'done')='true') end
  from public.nodes n where n.workspace_id=p_workspace_id
  order by n.position,n.id limit greatest(1,least(coalesce(p_limit,2000),5000));
$$;

revoke all on function public.list_node_summaries(uuid,integer) from public,anon,authenticated;
grant execute on function public.list_node_summaries(uuid,integer) to service_role;

commit;

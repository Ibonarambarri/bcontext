-- PERF-00: bounded read models for workspace navigation and node context.

create index if not exists nodes_workspace_parent_position_idx
  on public.nodes(workspace_id, parent_id, position);

create index if not exists workspaces_slug_idx on public.workspaces(slug);

-- Materialized wiki/mention links. Reads never scan every markdown body.
create table if not exists public.node_links (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_node uuid not null,
  target_node uuid not null,
  block_id text not null default '',
  origin text not null check (origin in ('markdown', 'mention')),
  created_at timestamptz not null default now(),
  primary key (source_node, target_node, origin, block_id),
  foreign key (source_node, workspace_id) references public.nodes(id, workspace_id) on delete cascade,
  foreign key (target_node, workspace_id) references public.nodes(id, workspace_id) on delete cascade
);
create index if not exists node_links_target_idx on public.node_links(workspace_id, target_node);
create index if not exists node_links_source_idx on public.node_links(workspace_id, source_node);

create or replace function public.refresh_node_link_projection(p_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare source_row public.nodes%rowtype;
begin
  select * into source_row from public.nodes where id = p_node_id;
  if not found then return; end if;
  delete from public.node_links where source_node = p_node_id;

  insert into public.node_links(workspace_id, source_node, target_node, block_id, origin)
  select source_row.workspace_id, source_row.id, target.id,
         coalesce(match[2], ''), 'markdown'
  from regexp_matches(
    coalesce(source_row.content_md, ''),
    '/n/([0-9a-fA-F-]{36})(?:#([A-Za-z0-9_-]+))?', 'g'
  ) as match
  join public.nodes target on target.workspace_id = source_row.workspace_id
    and target.id::text = match[1]
  on conflict do nothing;

  insert into public.node_links(workspace_id, source_node, target_node, block_id, origin)
  select source_row.workspace_id, source_row.id, target.id,
         coalesce(match[2], ''), 'markdown'
  from regexp_matches(
    coalesce(source_row.content_md, ''),
    '/s/([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?', 'g'
  ) as match
  join public.nodes target on target.workspace_id = source_row.workspace_id
    and target.slug = match[1]
  on conflict do nothing;

  insert into public.node_links(workspace_id, source_node, target_node, block_id, origin)
  select source_row.workspace_id, source_row.id, target.id,
         coalesce(case when jsonb_typeof(value) = 'object' then value ->> 'block_id' end, ''),
         'mention'
  from jsonb_array_elements(
    case when jsonb_typeof(source_row.data -> 'mentions') = 'array'
      then source_row.data -> 'mentions' else '[]'::jsonb end
  ) entry(value)
  join public.nodes target on target.workspace_id = source_row.workspace_id
    and target.id::text = case when jsonb_typeof(value) = 'string'
      then value #>> '{}' else value ->> 'id' end
  on conflict do nothing;
end;
$$;

create or replace function public.refresh_node_link_projection_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform public.refresh_node_link_projection(new.id);
  return new;
end;
$$;

drop trigger if exists nodes_refresh_link_projection on public.nodes;
create trigger nodes_refresh_link_projection
after insert or update of content_md, data on public.nodes
for each row execute function public.refresh_node_link_projection_trigger();

select public.refresh_node_link_projection(id) from public.nodes;

alter table public.node_links enable row level security;
create policy node_links_member_read on public.node_links
  for select using (public.is_workspace_member(workspace_id));

create or replace function public.list_node_summaries(
  p_workspace_id uuid,
  p_limit integer default 2000
)
returns table (
  id uuid, workspace_id uuid, parent_id uuid, kind text, category text,
  slug text, title text, status text, priority text, assignee_id uuid,
  due_date timestamptz, "position" integer, created_by uuid,
  created_at timestamptz, updated_at timestamptz, source text, tags jsonb
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select n.id, n.workspace_id, n.parent_id, n.kind::text, n.category::text,
         n.slug, n.title, n.status::text, n.priority::text, n.assignee_id,
         n.due_date, n.position, n.created_by, n.created_at, n.updated_at,
         nullif(n.data ->> 'source', '') as source,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'id', t.id, 'workspace_id', t.workspace_id, 'name', t.name,
             'normalized_name', t.normalized_name, 'slug', t.slug,
             'description', t.description, 'merged_into_id', t.merged_into_id,
             'deleted_at', t.deleted_at, 'created_at', t.created_at,
             'updated_at', t.updated_at
           ) order by t.normalized_name)
           from public.node_tags nt
           join public.tags t on t.id = nt.tag_id and t.workspace_id = nt.workspace_id
           where nt.workspace_id = n.workspace_id and nt.node_id = n.id
             and t.deleted_at is null and t.merged_into_id is null
         ), '[]'::jsonb) as tags
  from public.nodes n
  where n.workspace_id = p_workspace_id
  order by n.position, n.id
  limit greatest(1, least(coalesce(p_limit, 2000), 5000));
$$;

create or replace function public.get_node_context_candidates(
  p_workspace_id uuid,
  p_node_id uuid,
  p_limit integer default 200
)
returns table (
  id uuid, workspace_id uuid, parent_id uuid, kind text, category text,
  slug text, title text, content_md text, data jsonb, status text,
  priority text, assignee_id uuid, due_date timestamptz, "position" integer,
  created_by uuid, created_at timestamptz, updated_at timestamptz, tags jsonb
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with target as (
    select id, slug, content_md, data from public.nodes
    where workspace_id = p_workspace_id and id = p_node_id
  ), candidate as (
    select n.*
    from public.nodes n cross join target x
    where n.workspace_id = p_workspace_id and (
      n.id = p_node_id
      or exists (
        select 1 from public.edges e
        where e.workspace_id = p_workspace_id
          and ((e.from_node = p_node_id and e.to_node = n.id)
            or (e.to_node = p_node_id and e.from_node = n.id))
      )
      or exists (
        select 1 from public.node_links l
        where l.workspace_id = p_workspace_id
          and ((l.source_node = p_node_id and l.target_node = n.id)
            or (l.target_node = p_node_id and l.source_node = n.id))
      )
    )
    order by case when n.id = p_node_id then 0 else 1 end, n.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
  )
  select n.id, n.workspace_id, n.parent_id, n.kind::text, n.category::text,
         n.slug, n.title, n.content_md, n.data, n.status::text,
         n.priority::text, n.assignee_id, n.due_date, n.position,
         n.created_by, n.created_at, n.updated_at,
         coalesce((
           select jsonb_agg(to_jsonb(t) order by t.normalized_name)
           from public.node_tags nt
           join public.tags t on t.id = nt.tag_id and t.workspace_id = nt.workspace_id
           where nt.workspace_id = n.workspace_id and nt.node_id = n.id
             and t.deleted_at is null and t.merged_into_id is null
         ), '[]'::jsonb) as tags
  from candidate n;
$$;

revoke all on function public.list_node_summaries(uuid, integer) from public, anon, authenticated;
revoke all on function public.get_node_context_candidates(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.list_node_summaries(uuid, integer) to service_role;
grant execute on function public.get_node_context_candidates(uuid, uuid, integer) to service_role;
revoke all on function public.refresh_node_link_projection(uuid) from public, anon, authenticated;
grant execute on function public.refresh_node_link_projection(uuid) to service_role;

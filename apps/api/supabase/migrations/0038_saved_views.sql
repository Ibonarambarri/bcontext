-- UIX-02: canonical saved views. A view stores only a versioned query and
-- presentation configuration; node rows, embeddings and RAG indexes remain
-- canonical workspace resources.

create table if not exists public.saved_views (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  system_key text,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (char_length(btrim(slug)) between 1 and 160),
  description text,
  kind text not null check (kind in ('system', 'custom')),
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  owner_id uuid references auth.users(id) on delete cascade,
  owner_token_id uuid references public.api_tokens(id) on delete cascade,
  query jsonb not null,
  presentation jsonb not null,
  schema_version integer not null default 1 check (schema_version > 0),
  version bigint not null default 1 check (version > 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_views_owner_shape check (
    (kind = 'system' and system_key is not null and owner_id is null and owner_token_id is null and visibility = 'workspace')
    or
    (kind = 'custom' and system_key is null and num_nonnulls(owner_id, owner_token_id) = 1)
  ),
  constraint saved_views_query_object check (jsonb_typeof(query) = 'object'),
  constraint saved_views_presentation_object check (jsonb_typeof(presentation) = 'object'),
  constraint saved_views_query_version check (query ? 'schema_version' and (query ->> 'schema_version')::integer = schema_version),
  constraint saved_views_presentation_version check (presentation ? 'schema_version' and (presentation ->> 'schema_version')::integer = schema_version),
  constraint saved_views_query_keys check (
    query - array['schema_version','kinds','tags_any','tags_all','statuses','dates','source','actor','root_node_ids','traversal']::text[] = '{}'::jsonb
  ),
  constraint saved_views_presentation_keys check (
    presentation ? 'renderer'
    and presentation ->> 'renderer' in ('graph','board','timeline','table','list','changes')
    and presentation - array['schema_version','renderer','group_by','sort_by','columns','clustering','layout']::text[] = '{}'::jsonb
  ),
  unique (workspace_id, slug)
);

create unique index if not exists saved_views_system_key_unique
  on public.saved_views(workspace_id, system_key)
  where system_key is not null;
create index if not exists saved_views_workspace_position_idx
  on public.saved_views(workspace_id, kind, position, name);
create index if not exists saved_views_owner_idx
  on public.saved_views(owner_id, workspace_id) where owner_id is not null;
create index if not exists saved_views_owner_token_idx
  on public.saved_views(owner_token_id, workspace_id) where owner_token_id is not null;

create or replace function public.bump_saved_view_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = clock_timestamp();
  new.version = old.version + 1;
  return new;
end;
$$;

drop trigger if exists saved_views_versioned_update on public.saved_views;
create trigger saved_views_versioned_update
before update on public.saved_views
for each row execute function public.bump_saved_view_version();

create or replace function public.seed_workspace_system_views(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.workspaces where id = p_workspace_id) then
    raise exception 'workspace not found: %', p_workspace_id;
  end if;

  insert into public.saved_views (
    workspace_id, system_key, name, slug, description, kind, visibility,
    query, presentation, schema_version, position
  )
  select p_workspace_id, seed.system_key, seed.name, seed.slug, seed.description,
    'system', 'workspace', seed.query, seed.presentation, 1, seed.position
  from (values
    ('overview', 'Overview', 'overview', 'Workspace overview',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"list","group_by":null,"sort_by":[{"field":"updated_at","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 10),
    ('graph', 'Graph', 'graph', 'Bounded workspace graph',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"graph","group_by":null,"sort_by":[],"columns":[],"clustering":{"by":"kind"},"layout":{}}'::jsonb, 20),
    ('tasks', 'Tasks', 'tasks', 'Tasks and bugs by status',
      '{"schema_version":1,"kinds":["bug","task"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"board","group_by":"status","sort_by":[{"field":"priority","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 30),
    ('roadmap', 'Roadmap', 'roadmap', 'Dated work and dependencies',
      '{"schema_version":1,"kinds":["task"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"timeline","group_by":null,"sort_by":[{"field":"due_date","direction":"asc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 40),
    ('decisions', 'Decisions', 'decisions', 'Workspace decisions',
      '{"schema_version":1,"kinds":["decision"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"list","group_by":null,"sort_by":[{"field":"updated_at","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 50),
    ('changes', 'Changes', 'changes', 'Human and agent changes',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"changes","group_by":null,"sort_by":[{"field":"updated_at","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 60),
    ('tags', 'Tags', 'tags', 'Workspace taxonomy',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"table","group_by":null,"sort_by":[],"columns":["name","usage_count"],"clustering":{},"layout":{"resource":"tags"}}'::jsonb, 70),
    ('agents', 'Agents', 'agents', 'Connected agents',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"table","group_by":null,"sort_by":[],"columns":["name","status"],"clustering":{},"layout":{"resource":"agents"}}'::jsonb, 80)
  ) as seed(system_key, name, slug, description, query, presentation, position)
  on conflict (workspace_id, slug) do nothing;
end;
$$;

create or replace function public.seed_workspace_system_views_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.seed_workspace_system_views(new.id);
  return new;
end;
$$;

drop trigger if exists workspaces_seed_system_views on public.workspaces;
create trigger workspaces_seed_system_views
after insert on public.workspaces
for each row execute function public.seed_workspace_system_views_trigger();

do $$
declare workspace_row record;
begin
  for workspace_row in select id from public.workspaces loop
    perform public.seed_workspace_system_views(workspace_row.id);
  end loop;
end;
$$;

alter table public.saved_views enable row level security;

drop policy if exists saved_views_member_read on public.saved_views;
create policy saved_views_member_read on public.saved_views
for select using (
  public.is_workspace_member(workspace_id)
  and (
    kind = 'system'
    or visibility = 'workspace'
    or owner_id = (select auth.uid())
    or public.is_workspace_admin(workspace_id)
  )
);

drop policy if exists saved_views_contributor_insert on public.saved_views;
create policy saved_views_contributor_insert on public.saved_views
for insert with check (
  kind = 'custom'
  and owner_id = (select auth.uid())
  and owner_token_id is null
  and exists (
    select 1 from public.memberships m
    where m.workspace_id = saved_views.workspace_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin', 'editor', 'agent')
  )
);

drop policy if exists saved_views_owner_update on public.saved_views;
create policy saved_views_owner_update on public.saved_views
for update using (
  kind = 'custom'
  and (
    public.is_workspace_admin(workspace_id)
    or (
      owner_id = (select auth.uid())
      and exists (
        select 1 from public.memberships m
        where m.workspace_id = saved_views.workspace_id
          and m.user_id = (select auth.uid())
          and m.role in ('owner', 'admin', 'editor', 'agent')
      )
    )
  )
) with check (
  kind = 'custom'
  and (
    public.is_workspace_admin(workspace_id)
    or (
      owner_id = (select auth.uid())
      and owner_token_id is null
      and exists (
        select 1 from public.memberships m
        where m.workspace_id = saved_views.workspace_id
          and m.user_id = (select auth.uid())
          and m.role in ('owner', 'admin', 'editor', 'agent')
      )
    )
  )
);

drop policy if exists saved_views_owner_delete on public.saved_views;
create policy saved_views_owner_delete on public.saved_views
for delete using (
  kind = 'custom'
  and (
    public.is_workspace_admin(workspace_id)
    or (
      owner_id = (select auth.uid())
      and exists (
        select 1 from public.memberships m
        where m.workspace_id = saved_views.workspace_id
          and m.user_id = (select auth.uid())
          and m.role in ('owner', 'admin', 'editor', 'agent')
      )
    )
  )
);

revoke all on function public.seed_workspace_system_views(uuid) from public, anon, authenticated;
revoke all on function public.seed_workspace_system_views_trigger() from public, anon, authenticated;
grant execute on function public.seed_workspace_system_views(uuid) to service_role;

comment on table public.saved_views is
  'Saved query + presentation only. Never stores node copies, embeddings or per-view RAG indexes.';

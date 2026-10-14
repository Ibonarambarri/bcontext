-- 0057_credentials_system_view.sql
-- The `credentials` renderer (accounts/keys list, shipped 2026-07-24) was
-- rejected by the saved_views presentation CHECK, so credentials views could
-- be picked in the editor but never persisted. Widen the constraint to allow
-- it, and promote Credentials to a first-class system view seeded right
-- below Decisions.
-- Idempotent: safe to re-apply.

-- 1. Allow renderer = 'credentials' (kept every existing value, incl. legacy timeline).
alter table public.saved_views drop constraint if exists saved_views_presentation_keys;
alter table public.saved_views add constraint saved_views_presentation_keys check (
  (presentation ? 'renderer')
  and ((presentation ->> 'renderer') = any (array['graph','board','timeline','table','list','changes','browse','credentials']))
  and ((presentation - array['schema_version','renderer','group_by','sort_by','columns','clustering','layout']) = '{}'::jsonb)
);

-- 2. Seed a Credentials system view (position 55 -> between Decisions=50 and
--    Changes=60) for every workspace created from now on. Full function
--    re-declared so the canonical seed set stays in one place.
create or replace function public.seed_workspace_system_views(p_workspace_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
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
    ('browse', 'Browse', 'browse', 'File-explorer folder tree of nodes',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"browse","group_by":null,"sort_by":[],"columns":[],"clustering":{},"layout":{}}'::jsonb, 25),
    ('tasks', 'Tasks', 'tasks', 'Tasks and bugs by status',
      '{"schema_version":1,"kinds":["bug","task"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"board","group_by":"status","sort_by":[{"field":"priority","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 30),
    ('roadmap', 'Roadmap', 'roadmap', 'Dated work and dependencies',
      '{"schema_version":1,"kinds":["task"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"timeline","group_by":null,"sort_by":[{"field":"due_date","direction":"asc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 40),
    ('decisions', 'Decisions', 'decisions', 'Workspace decisions',
      '{"schema_version":1,"kinds":["decision"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"list","group_by":null,"sort_by":[{"field":"updated_at","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 50),
    ('credentials', 'Credentials', 'credentials', 'Accounts and keys',
      '{"schema_version":1,"kinds":["credential"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"credentials","group_by":null,"sort_by":[],"columns":[],"clustering":{},"layout":{}}'::jsonb, 55),
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
$function$;

-- 3. Backfill: give every EXISTING workspace the new Credentials view. The
--    function inserts only the missing row (on conflict do nothing), so
--    this is a no-op for the nine views each workspace already has.
do $$
declare w record;
begin
  for w in select id from public.workspaces loop
    perform public.seed_workspace_system_views(w.id);
  end loop;
end $$;

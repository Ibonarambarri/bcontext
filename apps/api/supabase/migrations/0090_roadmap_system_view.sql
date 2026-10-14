-- 0090_roadmap_system_view.sql
-- The Roadmap comes back as the goals roadmap: rows are the goal tree under
-- the North Star, columns are now/next/later derived from each task's
-- status, priority and open blockers, cards land in a row through their
-- `contributes_to` edge. Nothing new is stored on nodes; the view only names
-- the renderer and pins the rule version and the done window.
--
-- Every workspace already carries a `roadmap` system row: the timeline
-- renderer retired on 2026-07-21 left them in place (coerced to `list`,
-- hidden by the API). Those rows are rewritten here rather than re-seeded,
-- so their ids — `system:<ws>:roadmap` on the demo backend, the uuid in
-- Postgres — stay stable for anything that resolved them.
-- Idempotent: safe to re-apply.

-- 1. Allow renderer = 'roadmap'. `timeline` stays allowed: stored custom
--    views may still carry it and the contract coerces it on read.
alter table public.saved_views drop constraint if exists saved_views_presentation_keys;
alter table public.saved_views add constraint saved_views_presentation_keys check (
  (presentation ? 'renderer')
  and ((presentation ->> 'renderer') = any (array['graph','board','timeline','table','list','changes','browse','credentials','roadmap']))
  and ((presentation - array['schema_version','renderer','group_by','sort_by','columns','clustering','layout']) = '{}'::jsonb)
);

-- 1b. The query contract gained `unblocked` on 2026-09-08 and the API has
--     written it on every normalised query since; the key list here never
--     followed, so inserting a custom view would have failed the CHECK. No
--     custom view existed in production when this was found.
alter table public.saved_views drop constraint if exists saved_views_query_keys;
alter table public.saved_views add constraint saved_views_query_keys check (
  (query - array['schema_version','kinds','tags_any','tags_all','statuses','dates','source','actor','root_node_ids','traversal','unblocked']) = '{}'::jsonb
);

-- 2. Rewrite the existing system rows: tasks and bugs, the roadmap renderer,
--    position 35 (right after Tasks at 30).
update public.saved_views
set
  description = 'Goals as rows, now/next/later as columns',
  query = '{"schema_version":1,"kinds":["bug","task"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null,"unblocked":false}'::jsonb,
  presentation = '{"schema_version":1,"renderer":"roadmap","group_by":null,"sort_by":[],"columns":[],"clustering":{},"layout":{"roadmap":{"done_window_days":30,"rules_version":1}}}'::jsonb,
  position = 35
where kind = 'system' and system_key = 'roadmap';

-- 3. The seed for workspaces created from now on. Full function re-declared
--    so the canonical seed set stays in one place. Decisions and Tags leave
--    the seed: both were retired on 2026-09-08 and the API hides their rows.
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
    ('roadmap', 'Roadmap', 'roadmap', 'Goals as rows, now/next/later as columns',
      '{"schema_version":1,"kinds":["bug","task"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null,"unblocked":false}'::jsonb,
      '{"schema_version":1,"renderer":"roadmap","group_by":null,"sort_by":[],"columns":[],"clustering":{},"layout":{"roadmap":{"done_window_days":30,"rules_version":1}}}'::jsonb, 35),
    ('credentials', 'Credentials', 'credentials', 'Accounts and keys',
      '{"schema_version":1,"kinds":["credential"],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"credentials","group_by":null,"sort_by":[],"columns":[],"clustering":{},"layout":{}}'::jsonb, 55),
    ('changes', 'Changes', 'changes', 'Human and agent changes',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"changes","group_by":null,"sort_by":[{"field":"updated_at","direction":"desc"}],"columns":[],"clustering":{},"layout":{}}'::jsonb, 60),
    ('agents', 'Agents', 'agents', 'Connected agents',
      '{"schema_version":1,"kinds":[],"tags_any":[],"tags_all":[],"statuses":[],"dates":[],"source":[],"actor":[],"root_node_ids":[],"traversal":null}'::jsonb,
      '{"schema_version":1,"renderer":"table","group_by":null,"sort_by":[],"columns":["name","status"],"clustering":{},"layout":{"resource":"agents"}}'::jsonb, 80)
  ) as seed(system_key, name, slug, description, query, presentation, position)
  on conflict (workspace_id, slug) do nothing;
end;
$function$;

-- 4. Backfill: a workspace seeded after the timeline retirement but before
--    this migration has no roadmap row at all; the function inserts only
--    what is missing.
do $$
declare w record;
begin
  for w in select id from public.workspaces loop
    perform public.seed_workspace_system_views(w.id);
  end loop;
end $$;

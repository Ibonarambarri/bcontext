-- UIX-01 — workspace-scoped first-class tag taxonomy.
--
-- This migration is deliberately additive and reversible at the application
-- level: nodes.category and nodes.data.tags remain intact during the
-- compatibility window. The new tables become the canonical taxonomy while
-- triggers keep legacy writers/readers convergent. Dropping the new objects
-- would therefore not discard the legacy category/data representation.

create or replace function public.normalize_tag_name(input text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select lower(regexp_replace(btrim(input), '\s+', ' ', 'g'));
$$;

create or replace function public.tag_slug_base(input text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select coalesce(
    nullif(
      trim(both '-' from regexp_replace(public.normalize_tag_name(input), '[^a-z0-9]+', '-', 'g')),
      ''
    ),
    'tag'
  );
$$;

create table if not exists public.tags (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  normalized_name text not null,
  slug text not null,
  description text,
  merged_into_id uuid,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tags_name_not_blank check (length(normalized_name) > 0),
  constraint tags_not_merged_into_self check (merged_into_id is null or merged_into_id <> id),
  constraint tags_id_workspace_unique unique (id, workspace_id),
  constraint tags_merged_same_workspace_fk
    foreign key (merged_into_id, workspace_id)
    references public.tags(id, workspace_id)
    on delete restrict
);

create unique index if not exists tags_active_name_unique
  on public.tags(workspace_id, normalized_name)
  where deleted_at is null and merged_into_id is null;
create unique index if not exists tags_active_slug_unique
  on public.tags(workspace_id, slug)
  where deleted_at is null and merged_into_id is null;
create index if not exists tags_workspace_idx
  on public.tags(workspace_id, normalized_name);
create index if not exists tags_merged_workspace_idx
  on public.tags(merged_into_id, workspace_id);
create index if not exists tags_created_by_idx
  on public.tags(created_by);

create table if not exists public.tag_aliases (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tag_id uuid not null,
  normalized_name text not null,
  slug text not null,
  reason text not null check (reason in ('rename', 'merge')),
  created_at timestamptz not null default now(),
  constraint tag_aliases_name_not_blank check (length(normalized_name) > 0),
  constraint tag_aliases_tag_same_workspace_fk
    foreign key (tag_id, workspace_id)
    references public.tags(id, workspace_id)
    on delete cascade,
  unique (workspace_id, normalized_name)
);

create index if not exists tag_aliases_tag_workspace_idx
  on public.tag_aliases(tag_id, workspace_id);

-- nodes.id is globally unique already; this redundant composite key lets the
-- node_tags FK prove at the database boundary that node and tag belong to the
-- same workspace.
alter table public.nodes
  add constraint nodes_id_workspace_unique unique (id, workspace_id);

create table if not exists public.node_tags (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  node_id uuid not null,
  tag_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (node_id, tag_id),
  constraint node_tags_node_same_workspace_fk
    foreign key (node_id, workspace_id)
    references public.nodes(id, workspace_id)
    on delete cascade,
  constraint node_tags_tag_same_workspace_fk
    foreign key (tag_id, workspace_id)
    references public.tags(id, workspace_id)
    on delete cascade
);

create index if not exists node_tags_workspace_tag_idx
  on public.node_tags(workspace_id, tag_id, node_id);
create index if not exists node_tags_node_workspace_idx
  on public.node_tags(node_id, workspace_id);
create index if not exists node_tags_tag_workspace_idx
  on public.node_tags(tag_id, workspace_id);

create or replace function public.ensure_active_node_tag()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1
    from public.tags t
    where t.id = new.tag_id
      and t.workspace_id = new.workspace_id
      and t.deleted_at is null
      and t.merged_into_id is null
  ) then
    raise exception using errcode = '23503', message = 'unknown_or_inactive_tag';
  end if;
  return new;
end;
$$;

drop trigger if exists node_tags_require_active_tag on public.node_tags;
create trigger node_tags_require_active_tag
before insert on public.node_tags
for each row execute function public.ensure_active_node_tag();

create or replace function public.set_tag_identity()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  base_slug text;
  candidate text;
  suffix integer := 1;
begin
  new.name := regexp_replace(btrim(new.name), '\s+', ' ', 'g');
  new.normalized_name := public.normalize_tag_name(new.name);
  if new.normalized_name = '' then
    raise exception using errcode = '23514', message = 'tag_name_required';
  end if;

  if tg_op = 'INSERT' or new.name is distinct from old.name or new.slug is null then
    base_slug := public.tag_slug_base(new.name);
    candidate := base_slug;
    while exists (
      select 1
      from public.tags t
      where t.workspace_id = new.workspace_id
        and t.slug = candidate
        and t.id <> new.id
        and t.deleted_at is null
        and t.merged_into_id is null
    ) loop
      suffix := suffix + 1;
      candidate := base_slug || '-' || suffix::text;
    end loop;
    new.slug := candidate;
  end if;
  return new;
end;
$$;

drop trigger if exists tags_identity on public.tags;
create trigger tags_identity
before insert or update of name on public.tags
for each row execute function public.set_tag_identity();

drop trigger if exists tags_updated on public.tags;
create trigger tags_updated
before update on public.tags
for each row execute function public.set_updated_at();

-- Canonical domain tags seeded for every workspace. Decisions, meetings,
-- tasks and bugs remain node kinds/system views and are intentionally absent.
create or replace function public.seed_workspace_domain_tags(ws uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.tags(workspace_id, name, normalized_name, slug)
  values
    (ws, 'Business', 'business', 'business'),
    (ws, 'Product', 'product', 'product'),
    (ws, 'Tech', 'tech', 'tech'),
    (ws, 'AI', 'ai', 'ai')
  on conflict (workspace_id, normalized_name)
    where deleted_at is null and merged_into_id is null
  do nothing;
end;
$$;

create or replace function public.seed_workspace_domain_tags_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform public.seed_workspace_domain_tags(new.id);
  return new;
end;
$$;

drop trigger if exists workspaces_seed_domain_tags on public.workspaces;
create trigger workspaces_seed_domain_tags
after insert on public.workspaces
for each row execute function public.seed_workspace_domain_tags_trigger();

select public.seed_workspace_domain_tags(w.id)
from public.workspaces w;

-- Materialize every valid legacy data.tags[] value before wiring joins. The
-- trigger normalizes display names and resolves slug collisions safely.
insert into public.tags(workspace_id, name, normalized_name, slug)
select distinct
  n.workspace_id,
  regexp_replace(btrim(v.value #>> '{}'), '\s+', ' ', 'g') as name,
  public.normalize_tag_name(v.value #>> '{}') as normalized_name,
  public.tag_slug_base(v.value #>> '{}') as slug
from public.nodes n
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(coalesce(n.data, '{}'::jsonb)->'tags') = 'array'
      then n.data->'tags'
    else '[]'::jsonb
  end
) as v(value)
where jsonb_typeof(v.value) = 'string'
  and public.normalize_tag_name(v.value #>> '{}') <> ''
on conflict (workspace_id, normalized_name)
  where deleted_at is null and merged_into_id is null
do nothing;

-- Backfill both legacy sources. Only Business/Product/Tech/AI categories
-- become domain tags; kind-oriented categories remain untouched for old
-- clients but are not duplicated in the taxonomy.
insert into public.node_tags(workspace_id, node_id, tag_id)
select distinct n.workspace_id, n.id, t.id
from public.nodes n
cross join lateral (
  select public.normalize_tag_name(v.value #>> '{}') as normalized_name
  from jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(n.data, '{}'::jsonb)->'tags') = 'array'
        then n.data->'tags'
      else '[]'::jsonb
    end
  ) as v(value)
  where jsonb_typeof(v.value) = 'string'
  union
  select n.category
  where n.category in ('business', 'product', 'tech', 'ai')
) legacy
join public.tags t
  on t.workspace_id = n.workspace_id
 and t.normalized_name = legacy.normalized_name
 and t.deleted_at is null
 and t.merged_into_id is null
on conflict (node_id, tag_id) do nothing;

create or replace function public.sync_node_legacy_tag_fields(p_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  next_tags jsonb;
  next_category text;
  current_category text;
begin
  select n.category into current_category
  from public.nodes n
  where n.id = p_node_id;
  if not found then return; end if;

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

  if current_category in ('decisions', 'meetings', 'tasks', 'bugs') then
    next_category := current_category;
  elsif current_category in ('business', 'product', 'tech', 'ai')
    and exists (
      select 1
      from public.node_tags nt
      join public.tags t on t.id = nt.tag_id and t.workspace_id = nt.workspace_id
      where nt.node_id = p_node_id
        and t.deleted_at is null
        and t.merged_into_id is null
        and (
          t.normalized_name = current_category
          or exists (
            select 1 from public.tag_aliases a
            where a.workspace_id = nt.workspace_id
              and a.tag_id = t.id
              and a.normalized_name = current_category
          )
        )
    ) then
    next_category := current_category;
  else
    select v.category into next_category
    from (values
      ('business', 1), ('product', 2), ('tech', 3), ('ai', 4)
    ) as v(category, ord)
    where exists (
      select 1
      from public.node_tags nt
      join public.tags t on t.id = nt.tag_id and t.workspace_id = nt.workspace_id
      where nt.node_id = p_node_id
        and t.deleted_at is null
        and t.merged_into_id is null
        and (
          t.normalized_name = v.category
          or exists (
            select 1 from public.tag_aliases a
            where a.workspace_id = nt.workspace_id
              and a.tag_id = t.id
              and a.normalized_name = v.category
          )
        )
    )
    order by v.ord
    limit 1;
  end if;

  perform set_config('bcontext.syncing_tags', 'on', true);
  update public.nodes
  set data = jsonb_set(coalesce(data, '{}'::jsonb), '{tags}', next_tags, true),
      category = next_category
  where id = p_node_id
    and (
      coalesce(data->'tags', 'null'::jsonb) is distinct from next_tags
      or category is distinct from next_category
    );
  perform set_config('bcontext.syncing_tags', 'off', true);
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  raise;
end;
$$;

create or replace function public.sync_legacy_node_to_tags()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  replaced_category text;
begin
  if current_setting('bcontext.syncing_tags', true) = 'on' then
    return new;
  end if;

  -- A category-only write from an old client means "replace/clear my
  -- single category", even though data.tags still contains the previous
  -- dual-written mirror. Drop that previous domain tag unless the caller
  -- explicitly changed data.tags in the same statement.
  if tg_op = 'UPDATE' then
    if new.category is distinct from old.category
      and old.category in ('business', 'product', 'tech', 'ai')
      and coalesce(new.data->'tags', 'null'::jsonb)
        is not distinct from coalesce(old.data->'tags', 'null'::jsonb) then
      replaced_category := old.category;
    end if;
  end if;

  perform set_config('bcontext.syncing_tags', 'on', true);

  delete from public.node_tags nt
  where nt.node_id = new.id
    and not exists (
      select 1
      from public.tags t
      where t.id = nt.tag_id
        and t.workspace_id = new.workspace_id
        and t.deleted_at is null
        and t.merged_into_id is null
        and (
          new.category in ('business', 'product', 'tech', 'ai')
            and (
              t.normalized_name = new.category
              or exists (
                select 1 from public.tag_aliases a
                where a.workspace_id = new.workspace_id
                  and a.tag_id = t.id
                  and a.normalized_name = new.category
              )
            )
          or exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(coalesce(new.data, '{}'::jsonb)->'tags') = 'array'
                  then new.data->'tags'
                else '[]'::jsonb
              end
            ) as v(value)
            where jsonb_typeof(v.value) = 'string'
              and public.normalize_tag_name(v.value #>> '{}')
                is distinct from replaced_category
              and (
                public.normalize_tag_name(v.value #>> '{}') = t.normalized_name
                or exists (
                  select 1 from public.tag_aliases a
                  where a.workspace_id = new.workspace_id
                    and a.tag_id = t.id
                    and a.normalized_name =
                      public.normalize_tag_name(v.value #>> '{}')
                )
              )
          )
        )
    );

  insert into public.node_tags(workspace_id, node_id, tag_id)
  select new.workspace_id, new.id, t.id
  from public.tags t
  where t.workspace_id = new.workspace_id
    and t.deleted_at is null
    and t.merged_into_id is null
    and (
      new.category in ('business', 'product', 'tech', 'ai')
        and (
          t.normalized_name = new.category
          or exists (
            select 1 from public.tag_aliases a
            where a.workspace_id = new.workspace_id
              and a.tag_id = t.id
              and a.normalized_name = new.category
          )
        )
      or exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(coalesce(new.data, '{}'::jsonb)->'tags') = 'array'
              then new.data->'tags'
            else '[]'::jsonb
          end
        ) as v(value)
        where jsonb_typeof(v.value) = 'string'
          and public.normalize_tag_name(v.value #>> '{}')
            is distinct from replaced_category
          and (
            public.normalize_tag_name(v.value #>> '{}') = t.normalized_name
            or exists (
              select 1 from public.tag_aliases a
              where a.workspace_id = new.workspace_id
                and a.tag_id = t.id
                and a.normalized_name =
                  public.normalize_tag_name(v.value #>> '{}')
            )
          )
      )
    )
  on conflict (node_id, tag_id) do nothing;

  perform set_config('bcontext.syncing_tags', 'off', true);
  perform public.sync_node_legacy_tag_fields(new.id);
  return new;
exception when others then
  perform set_config('bcontext.syncing_tags', 'off', true);
  raise;
end;
$$;

drop trigger if exists nodes_sync_legacy_tags on public.nodes;
create trigger nodes_sync_legacy_tags
after insert or update of category, data on public.nodes
for each row execute function public.sync_legacy_node_to_tags();

create or replace function public.sync_node_tags_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  affected_node uuid;
begin
  if current_setting('bcontext.syncing_tags', true) = 'on' then
    return null;
  end if;
  affected_node := coalesce(new.node_id, old.node_id);
  perform public.sync_node_legacy_tag_fields(affected_node);
  return null;
end;
$$;

drop trigger if exists node_tags_sync_legacy on public.node_tags;
create trigger node_tags_sync_legacy
after insert or delete on public.node_tags
for each row execute function public.sync_node_tags_to_legacy();

-- Finish the initial backfill by materializing category-derived tags in the
-- legacy JSON array. This is idempotent and leaves kind-oriented categories
-- unchanged while making domain tags visible to old clients.
select public.sync_node_legacy_tag_fields(n.id)
from public.nodes n;

-- Atomic service-role operations used by the storage adapter. Direct table
-- access remains protected by RLS; these functions are not executable by
-- anon/authenticated callers.
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
begin
  if not exists (
    select 1 from public.nodes n
    where n.id = p_node_id and n.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = 'P0002', message = 'node_not_found';
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

create or replace function public.create_workspace_tag(
  p_workspace_id uuid,
  p_name text,
  p_description text default null,
  p_created_by uuid default null
)
returns public.tags
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  normalized text := public.normalize_tag_name(p_name);
  created public.tags;
begin
  if exists (
    select 1 from public.tag_aliases a
    where a.workspace_id = p_workspace_id and a.normalized_name = normalized
  ) then
    raise exception using errcode = '23505', message = 'tag_alias_conflict';
  end if;
  insert into public.tags(workspace_id, name, normalized_name, slug, description, created_by)
  values (p_workspace_id, p_name, normalized, public.tag_slug_base(p_name), nullif(btrim(p_description), ''), p_created_by)
  returning * into created;
  return created;
end;
$$;

create or replace function public.rename_workspace_tag(
  p_workspace_id uuid,
  p_tag_id uuid,
  p_name text,
  p_description text default null
)
returns public.tags
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  current_tag public.tags;
  renamed public.tags;
  normalized text := public.normalize_tag_name(p_name);
begin
  select * into current_tag
  from public.tags t
  where t.id = p_tag_id
    and t.workspace_id = p_workspace_id
    and t.deleted_at is null
    and t.merged_into_id is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'tag_not_found';
  end if;

  if normalized <> current_tag.normalized_name then
    if exists (
      select 1 from public.tags t
      where t.workspace_id = p_workspace_id
        and t.normalized_name = normalized
        and t.id <> p_tag_id
        and t.deleted_at is null
        and t.merged_into_id is null
    ) or exists (
      select 1 from public.tag_aliases a
      where a.workspace_id = p_workspace_id
        and a.normalized_name = normalized
        and a.tag_id <> p_tag_id
    ) then
      raise exception using errcode = '23505', message = 'tag_name_conflict';
    end if;
    insert into public.tag_aliases(workspace_id, tag_id, normalized_name, slug, reason)
    values (p_workspace_id, p_tag_id, current_tag.normalized_name, current_tag.slug, 'rename')
    on conflict (workspace_id, normalized_name)
    do update set tag_id = excluded.tag_id, slug = excluded.slug, reason = excluded.reason;
  end if;

  update public.tags
  set name = p_name,
      description = nullif(btrim(p_description), '')
  where id = p_tag_id
  returning * into renamed;

  perform public.sync_node_legacy_tag_fields(nt.node_id)
  from public.node_tags nt
  where nt.tag_id = p_tag_id;
  return renamed;
end;
$$;

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

revoke all on function public.assign_node_tags(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.seed_workspace_domain_tags(uuid) from public, anon, authenticated;
revoke all on function public.seed_workspace_domain_tags_trigger() from public, anon, authenticated;
revoke all on function public.sync_node_legacy_tag_fields(uuid) from public, anon, authenticated;
revoke all on function public.create_workspace_tag(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.rename_workspace_tag(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.merge_workspace_tags(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_workspace_tag(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_node_tags(uuid, uuid, uuid[]) to service_role;
grant execute on function public.create_workspace_tag(uuid, text, text, uuid) to service_role;
grant execute on function public.rename_workspace_tag(uuid, uuid, text, text) to service_role;
grant execute on function public.merge_workspace_tags(uuid, uuid, uuid) to service_role;
grant execute on function public.delete_workspace_tag(uuid, uuid) to service_role;

-- RLS: taxonomy reads are workspace-scoped; only owners/admins manage tag
-- definitions. Assignments follow node-write roles and never grant access to
-- the node itself — nodes RLS remains the authorization boundary.
alter table public.tags enable row level security;
alter table public.tag_aliases enable row level security;
alter table public.node_tags enable row level security;

create policy tags_member_read on public.tags
  for select using (public.is_workspace_member(workspace_id));
create policy tags_admin_insert on public.tags
  for insert with check (public.is_workspace_admin(workspace_id));
create policy tags_admin_update on public.tags
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy tags_admin_delete on public.tags
  for delete using (public.is_workspace_admin(workspace_id));

create policy tag_aliases_member_read on public.tag_aliases
  for select using (public.is_workspace_member(workspace_id));
create policy tag_aliases_admin_insert on public.tag_aliases
  for insert with check (public.is_workspace_admin(workspace_id));
create policy tag_aliases_admin_update on public.tag_aliases
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy tag_aliases_admin_delete on public.tag_aliases
  for delete using (public.is_workspace_admin(workspace_id));

create policy node_tags_member_read on public.node_tags
  for select using (public.is_workspace_member(workspace_id));
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
create policy node_tags_contributor_delete on public.node_tags
  for delete using (
    exists (
      select 1 from public.memberships m
      where m.workspace_id = node_tags.workspace_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner', 'admin', 'editor', 'agent')
    )
  );

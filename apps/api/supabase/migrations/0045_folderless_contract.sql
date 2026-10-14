-- UIX-24 — contract the fully migrated database to the folderless model.
--
-- DEPLOY ORDER: deploy and smoke-test an application whose public contract
-- neither exposes nor accepts nodes.category/data.tags. During DB-old rollout
-- it may preserve the unchanged mirror internally so legacy triggers cannot
-- erase canonical assignments. Take a managed database/PITR restore point
-- first. UIX-21 run snapshots remain as
-- immutable evidence, but their folder/category rollback RPC is intentionally
-- retired by this irreversible schema contract.

-- Explicit transaction. The lock below is only legal inside one, and the
-- Supabase CLI applies a file statement by statement unless told otherwise —
-- this ran fine in production through the SQL editor, which wraps the whole
-- script, and failed on the first fresh local replay. Same convention as
-- 0042, 0059-0063.
begin;

lock table public.nodes, public.node_tags, public.tags, public.tag_aliases,
  public.saved_views in share row exclusive mode;

create or replace function public.assert_folderless_contract_preflight()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  category_exists boolean;
  category_violation boolean;
begin
  if exists (select 1 from public.nodes where kind = 'folder') then
    raise exception using errcode = '55000', message = 'folderless_contract_preflight_folders_remain';
  end if;

  if exists (
    select 1 from public.nodes child
    left join public.nodes parent on parent.id = child.parent_id
    where child.parent_id is not null
      and (parent.id is null or parent.workspace_id is distinct from child.workspace_id or parent.id = child.id)
  ) then
    raise exception using errcode = '55000', message = 'folderless_contract_preflight_invalid_parent';
  end if;

  if exists (
    with recursive ancestry(origin_id, id, parent_id, path, cycle) as (
      select n.id, n.id, n.parent_id, array[n.id], false from public.nodes n
      union all
      select a.origin_id, p.id, p.parent_id, a.path || p.id, p.id = any(a.path)
      from ancestry a
      join public.nodes p on p.id = a.parent_id
      where a.parent_id is not null and not a.cycle
    )
    select 1 from ancestry where cycle
  ) then
    raise exception using errcode = '55000', message = 'folderless_contract_preflight_parent_cycle';
  end if;

  if exists (
    select 1 from public.saved_views v
    where coalesce(v.query -> 'kinds', '[]'::jsonb) @> '["folder"]'::jsonb
  ) then
    raise exception using errcode = '55000', message = 'folderless_contract_preflight_legacy_view_kind';
  end if;

  if exists (
    select 1 from public.nodes n
    where n.data ? 'tags' and jsonb_typeof(n.data -> 'tags') is distinct from 'array'
  ) or exists (
    select 1
    from public.nodes n
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(n.data -> 'tags') = 'array' then n.data -> 'tags' else '[]'::jsonb end
    ) legacy(value)
    where jsonb_typeof(legacy.value) <> 'string'
       or not exists (
         select 1 from public.node_tags nt
         join public.tags t on t.id = nt.tag_id and t.workspace_id = nt.workspace_id
         where nt.node_id = n.id and nt.workspace_id = n.workspace_id
           and t.deleted_at is null and t.merged_into_id is null
           and (
             t.normalized_name = public.normalize_tag_name(legacy.value #>> '{}')
             or exists (
               select 1 from public.tag_aliases a
               where a.workspace_id = n.workspace_id and a.tag_id = t.id
                 and a.normalized_name = public.normalize_tag_name(legacy.value #>> '{}')
             )
           )
       )
  ) then
    raise exception using errcode = '55000', message = 'folderless_contract_preflight_legacy_tag_without_assignment';
  end if;

  select exists (
    select 1 from pg_attribute
    where attrelid = 'public.nodes'::regclass and attname = 'category' and not attisdropped
  ) into category_exists;
  if category_exists then
    execute $category_check$
      select exists (
        select 1 from public.nodes n
        where n.category is not null and not (
          (n.category in ('business','product','tech','ai') and exists (
            select 1 from public.node_tags nt
            join public.tags t on t.id = nt.tag_id and t.workspace_id = nt.workspace_id
            where nt.node_id = n.id and nt.workspace_id = n.workspace_id
              and t.deleted_at is null and t.merged_into_id is null
              and (t.normalized_name = n.category or exists (
                select 1 from public.tag_aliases a
                where a.workspace_id = n.workspace_id and a.tag_id = t.id
                  and a.normalized_name = n.category
              ))
          ))
          or (n.category = 'decisions' and n.kind in ('decision','adr'))
          or (n.category = 'meetings' and n.kind = 'meeting')
          or (n.category = 'tasks' and n.kind = 'task')
          or (n.category = 'bugs' and n.kind = 'bug')
          or (
            n.kind = 'doc'
            and n.category in ('decisions','meetings','tasks','bugs')
            and exists (
              select 1
              from public.node_tags nt
              join public.tags t
                on t.id = nt.tag_id
               and t.workspace_id = nt.workspace_id
              where nt.node_id = n.id
                and nt.workspace_id = n.workspace_id
                and t.deleted_at is null
                and t.merged_into_id is null
            )
          )
        )
      )
    $category_check$ into category_violation;
    if category_violation then
      raise exception using errcode = '55000', message = 'folderless_contract_preflight_category_without_equivalent';
    end if;
  end if;

  if exists (
    select 1 from public.saved_views v
    where jsonb_typeof(coalesce(v.query -> 'root_node_ids', '[]'::jsonb)) <> 'array'
  ) or exists (
    select 1
    from public.saved_views v
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(v.query -> 'root_node_ids') = 'array'
        then v.query -> 'root_node_ids' else '[]'::jsonb end
    ) root(value)
    left join public.nodes n on n.id = case
      when root.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then root.value::uuid else null end
    where n.id is null or n.workspace_id is distinct from v.workspace_id
  ) then
    raise exception using errcode = '55000', message = 'folderless_contract_preflight_legacy_view_root';
  end if;
end;
$$;

revoke all on function public.assert_folderless_contract_preflight()
  from public, anon, authenticated;
grant execute on function public.assert_folderless_contract_preflight()
  to service_role;

select public.assert_folderless_contract_preflight();

-- Retire both directions of the category/data.tags compatibility bridge.
drop trigger if exists nodes_sync_legacy_tags on public.nodes;
drop trigger if exists node_tags_sync_legacy on public.node_tags;
drop function if exists public.sync_legacy_node_to_tags();
drop function if exists public.sync_node_tags_to_legacy();

-- Tag lifecycle RPCs from older migrations still invoke this private helper.
-- Keep the non-executable symbol as an inert no-op until those stable RPC
-- bodies are next versioned; no row can dual-write legacy fields after 0045.
create or replace function public.sync_node_legacy_tag_fields(p_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$ begin return; end; $$;
revoke all on function public.sync_node_legacy_tag_fields(uuid)
  from public, anon, authenticated, service_role;
comment on function public.sync_node_legacy_tag_fields(uuid) is
  'Inert post-0045 compatibility symbol. Retained only for stable tag lifecycle function bodies; performs no writes.';

-- This is a representation-only contraction. Preserve optimistic-concurrency
-- and activity semantics instead of making every migrated node look edited.
alter table public.nodes disable trigger nodes_updated;
update public.nodes set data = coalesce(data, '{}'::jsonb) - 'tags'
where coalesce(data, '{}'::jsonb) ? 'tags';
alter table public.nodes enable trigger nodes_updated;

create or replace function public.enforce_node_data_contract()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if coalesce(new.data, '{}'::jsonb) ? 'tags' then
    raise exception using errcode = '23514', message = 'legacy_data_tags_retired';
  end if;
  return new;
end;
$$;
drop trigger if exists nodes_data_contract_guard on public.nodes;
create trigger nodes_data_contract_guard
before insert or update of data on public.nodes
for each row execute function public.enforce_node_data_contract();
revoke all on function public.enforce_node_data_contract() from public, anon, authenticated;

-- Replace the hierarchy trigger before removing its category update column.
drop trigger if exists nodes_folderless_hierarchy_guard on public.nodes;
create or replace function public.enforce_folderless_hierarchy()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  parent_workspace uuid;
  closes_cycle boolean;
begin
  if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
    raise exception using errcode = '23514', message = 'workspace_id_immutable';
  end if;
  if new.parent_id is null
    or (tg_op = 'UPDATE' and new.parent_id is not distinct from old.parent_id) then
    return new;
  end if;
  -- Serialize parent mutations per workspace so concurrent A→B and B→A
  -- updates cannot both validate against the same pre-commit snapshot.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));
  if new.parent_id = new.id then
    raise exception using errcode = '23514', message = 'parent_cycle';
  end if;
  select n.workspace_id into parent_workspace from public.nodes n where n.id = new.parent_id;
  if not found or parent_workspace is distinct from new.workspace_id then
    raise exception using errcode = '23503', message = 'invalid_parent';
  end if;
  with recursive ancestors(id, parent_id, path) as (
    select n.id, n.parent_id, array[n.id] from public.nodes n where n.id = new.parent_id
    union all
    select n.id, n.parent_id, a.path || n.id
    from ancestors a join public.nodes n on n.id = a.parent_id
    where not n.id = any(a.path)
  )
  select exists(select 1 from ancestors where id = new.id) into closes_cycle;
  if closes_cycle then raise exception using errcode = '23514', message = 'parent_cycle'; end if;
  return new;
end;
$$;
create trigger nodes_folderless_hierarchy_guard
before insert or update of parent_id, workspace_id on public.nodes
for each row execute function public.enforce_folderless_hierarchy();
revoke all on function public.enforce_folderless_hierarchy() from public, anon, authenticated;

-- Folder guards and the UIX-21 mutation engine are superseded by the physical
-- schema contract. Keep redirect/evidence tables and resolve_node_redirect.
drop trigger if exists nodes_folderless_guard on public.nodes;
drop trigger if exists nodes_folderless_contract_guard on public.nodes;
drop trigger if exists node_tags_folderless_guard on public.node_tags;
drop function if exists public.folderless_guard_node_writes();
drop function if exists public.enforce_folderless_node_mutability();
drop function if exists public.enforce_folderless_node_tag_target();
drop function if exists public.apply_folderless_migration_plan(uuid, text);
drop function if exists public.rollback_folderless_migration_plan(uuid, text);
drop function if exists public.approve_folderless_migration_plan(uuid, text, uuid);
drop function if exists public.register_folderless_migration_plan(uuid, jsonb, text);
drop function if exists public.set_folderless_workspace_guard(uuid, boolean, boolean, uuid);
drop function if exists public.resolve_folderless_reviewed_tag(uuid, text, text, jsonb, text);
drop function if exists public.capture_folderless_workspace(uuid);

comment on table public.folderless_migration_runs is
  'Immutable UIX-21 migration evidence after 0045. rollback_snapshot is restorable only into the pre-0045 schema or by using the managed PITR snapshot taken before contraction.';
comment on column public.folderless_migration_runs.rollback_snapshot is
  'Exact pre-migration evidence. The logical rollback RPC is retired after 0045; use a pre-0045 schema restore/PITR workflow.';

-- Replace live read contracts before removing the physical category column.
drop function if exists public.match_nodes(vector, uuid, integer, double precision);
drop function if exists public.match_nodes(vector, uuid, integer, double precision, text, uuid[]);
create function public.match_nodes(
  query_embedding vector(1536), match_workspace uuid, match_count int default 8,
  similarity_threshold float default 0.0, embedding_version_filter text default null,
  match_node_ids uuid[] default null
)
returns table (node_id uuid, chunk_index int, content text, similarity float,
  title text, kind text, metadata jsonb)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select e.node_id, e.chunk_index, e.content,
    1 - (e.embedding <=> query_embedding), n.title, n.kind, e.metadata
  from public.embeddings e join public.nodes n on n.id=e.node_id and n.workspace_id=match_workspace
  where e.workspace_id=match_workspace
    and (match_node_ids is null or e.node_id=any(match_node_ids))
    and 1 - (e.embedding <=> query_embedding) > similarity_threshold
    and (embedding_version_filter is null or e.embedding_version=embedding_version_filter)
  order by e.embedding <=> query_embedding, e.id limit match_count;
$$;
revoke all on function public.match_nodes(vector,uuid,integer,double precision,text,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.match_nodes(vector,uuid,integer,double precision,text,uuid[])
  to public,anon,authenticated,service_role;

drop function if exists public.hybrid_search(text, vector, uuid, integer, integer, integer, integer);
drop function if exists public.hybrid_search(text, vector, uuid, integer, integer, integer, integer, text, uuid[]);
create function public.hybrid_search(
  query_text text, query_embedding vector(1536), match_workspace uuid,
  match_count int default 20, vector_pool int default 100, bm25_pool int default 100,
  rrf_k int default 60, embedding_version_filter text default null,
  match_node_ids uuid[] default null
)
returns table (node_id uuid, chunk_index int, content text, title text, kind text,
  vector_rank int, bm25_rank int, rrf_score float, metadata jsonb)
language sql stable security invoker set search_path = pg_catalog, public as $$
  with v as (
    select e.id, row_number() over(order by e.embedding <=> query_embedding, e.id) rnk
    from public.embeddings e where e.workspace_id=match_workspace
      and (match_node_ids is null or e.node_id=any(match_node_ids))
      and (embedding_version_filter is null or e.embedding_version=embedding_version_filter)
    order by e.embedding <=> query_embedding, e.id limit vector_pool
  ), b as (
    select e.id, row_number() over(order by ts_rank_cd(e.content_tsv, plainto_tsquery('english',query_text)) desc,e.id) rnk
    from public.embeddings e where e.workspace_id=match_workspace
      and (match_node_ids is null or e.node_id=any(match_node_ids))
      and e.content_tsv @@ plainto_tsquery('english',query_text)
      and (embedding_version_filter is null or e.embedding_version=embedding_version_filter)
    order by ts_rank_cd(e.content_tsv,plainto_tsquery('english',query_text)) desc,e.id limit bm25_pool
  ), fused as (
    select coalesce(v.id,b.id) id, v.rnk v_rank, b.rnk b_rank,
      coalesce(1.0/(rrf_k+v.rnk),0.0)+coalesce(1.0/(rrf_k+b.rnk),0.0) score
    from v full outer join b on b.id=v.id
  )
  select e.node_id,e.chunk_index,e.content,n.title,n.kind,
    f.v_rank::int,f.b_rank::int,f.score::float,e.metadata
  from fused f join public.embeddings e on e.id=f.id
  join public.nodes n on n.id=e.node_id and n.workspace_id=match_workspace
  order by f.score desc nulls last,e.id limit match_count;
$$;
revoke all on function public.hybrid_search(text,vector,uuid,integer,integer,integer,integer,text,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.hybrid_search(text,vector,uuid,integer,integer,integer,integer,text,uuid[])
  to public,anon,authenticated,service_role;

drop function if exists public.list_node_summaries(uuid, integer);
create function public.list_node_summaries(p_workspace_id uuid, p_limit integer default 2000)
returns table (id uuid, workspace_id uuid, parent_id uuid, kind text, slug text,
  title text, status text, priority text, assignee_id uuid, due_date timestamptz,
  "position" integer, created_by uuid, created_at timestamptz, updated_at timestamptz,
  source text, tags jsonb)
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
      where nt.workspace_id=n.workspace_id and nt.node_id=n.id and t.deleted_at is null and t.merged_into_id is null),'[]'::jsonb)
  from public.nodes n where n.workspace_id=p_workspace_id
  order by n.position,n.id limit greatest(1,least(coalesce(p_limit,2000),5000));
$$;

drop function if exists public.get_node_context_candidates(uuid, uuid, integer);
create function public.get_node_context_candidates(p_workspace_id uuid,p_node_id uuid,p_limit integer default 200)
returns table (id uuid,workspace_id uuid,parent_id uuid,kind text,slug text,title text,
  content_md text,data jsonb,status text,priority text,assignee_id uuid,due_date timestamptz,
  "position" integer,created_by uuid,created_at timestamptz,updated_at timestamptz,tags jsonb)
language sql stable security invoker set search_path=public,pg_catalog as $$
  with target as (select id from public.nodes where workspace_id=p_workspace_id and id=p_node_id),
  candidate as (
    select n.* from public.nodes n cross join target
    where n.workspace_id=p_workspace_id and (n.id=p_node_id
      or exists(select 1 from public.edges e where e.workspace_id=p_workspace_id and ((e.from_node=p_node_id and e.to_node=n.id) or (e.to_node=p_node_id and e.from_node=n.id)))
      or exists(select 1 from public.node_links l where l.workspace_id=p_workspace_id and ((l.source_node=p_node_id and l.target_node=n.id) or (l.target_node=p_node_id and l.source_node=n.id))))
    order by case when n.id=p_node_id then 0 else 1 end,n.updated_at desc
    limit greatest(1,least(coalesce(p_limit,200),500))
  )
  select n.id,n.workspace_id,n.parent_id,n.kind::text,n.slug,n.title,n.content_md,n.data,
    n.status::text,n.priority::text,n.assignee_id,n.due_date,n.position,n.created_by,n.created_at,n.updated_at,
    coalesce((select jsonb_agg(to_jsonb(t) order by t.normalized_name)
      from public.node_tags nt join public.tags t on t.id=nt.tag_id and t.workspace_id=nt.workspace_id
      where nt.workspace_id=n.workspace_id and nt.node_id=n.id and t.deleted_at is null and t.merged_into_id is null),'[]'::jsonb)
  from candidate n;
$$;
revoke all on function public.list_node_summaries(uuid,integer) from public,anon,authenticated;
revoke all on function public.get_node_context_candidates(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_node_summaries(uuid,integer) to service_role;
grant execute on function public.get_node_context_candidates(uuid,uuid,integer) to service_role;

alter table public.nodes drop constraint if exists nodes_kind_check;
alter table public.nodes add constraint nodes_kind_check
  check (kind in ('doc','task','decision','meeting','bug','adr','entity','skill'));
alter table public.nodes drop column category;

comment on column public.nodes.parent_id is
  'Optional semantic parent. Same-workspace and acyclic invariants are enforced by nodes_folderless_hierarchy_guard; FK delete behavior remains unchanged.';

commit;

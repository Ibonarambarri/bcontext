-- UIX-09 — pre-retrieval candidate scoping.
--
-- `match_node_ids` is a candidate boundary, not an ACL. Workspace RLS and
-- token authorization remain authoritative. An empty array deliberately
-- returns no rows; NULL means the complete workspace corpus. Tags and saved
-- views are resolved to canonical node ids before either ranking lane runs,
-- so explicit filters are never applied after vector/BM25 retrieval.

-- Adding a defaulted parameter beside the old signature would make calls
-- that omit match_node_ids ambiguous. Replace the old overloads atomically;
-- callers using the prior argument set remain source-compatible.
drop function if exists public.match_nodes(vector, uuid, integer, double precision, text);
drop function if exists public.hybrid_search(text, vector, uuid, integer, integer, integer, integer, text);

create or replace function public.match_nodes(
  query_embedding vector(1536),
  match_workspace uuid,
  match_count int default 8,
  similarity_threshold float default 0.0,
  embedding_version_filter text default null,
  match_node_ids uuid[] default null
)
returns table (
  node_id uuid,
  chunk_index int,
  content text,
  similarity float,
  title text,
  kind text,
  category text,
  metadata jsonb
)
language sql stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    e.node_id,
    e.chunk_index,
    e.content,
    1 - (e.embedding <=> query_embedding) as similarity,
    n.title,
    n.kind,
    n.category,
    e.metadata
  from public.embeddings e
  join public.nodes n
    on n.id = e.node_id
   and n.workspace_id = match_workspace
  where e.workspace_id = match_workspace
    and (match_node_ids is null or e.node_id = any(match_node_ids))
    and 1 - (e.embedding <=> query_embedding) > similarity_threshold
    and (embedding_version_filter is null
         or e.embedding_version = embedding_version_filter)
  order by e.embedding <=> query_embedding, e.id
  limit match_count;
$$;

create or replace function public.hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_workspace uuid,
  match_count int default 20,
  vector_pool int default 100,
  bm25_pool int default 100,
  rrf_k int default 60,
  embedding_version_filter text default null,
  match_node_ids uuid[] default null
)
returns table (
  node_id uuid,
  chunk_index int,
  content text,
  title text,
  kind text,
  category text,
  vector_rank int,
  bm25_rank int,
  rrf_score float,
  metadata jsonb
)
language sql stable
security invoker
set search_path = pg_catalog, public
as $$
  with v as (
    select
      e.id,
      e.node_id,
      e.chunk_index,
      e.content,
      row_number() over (order by e.embedding <=> query_embedding, e.id) as rnk
    from public.embeddings e
    where e.workspace_id = match_workspace
      and (match_node_ids is null or e.node_id = any(match_node_ids))
      and (embedding_version_filter is null
           or e.embedding_version = embedding_version_filter)
    order by e.embedding <=> query_embedding, e.id
    limit vector_pool
  ),
  b as (
    select
      e.id,
      row_number() over (
        order by ts_rank_cd(e.content_tsv, plainto_tsquery('english', query_text)) desc,
          e.id
      ) as rnk
    from public.embeddings e
    where e.workspace_id = match_workspace
      and (match_node_ids is null or e.node_id = any(match_node_ids))
      and e.content_tsv @@ plainto_tsquery('english', query_text)
      and (embedding_version_filter is null
           or e.embedding_version = embedding_version_filter)
    order by ts_rank_cd(e.content_tsv, plainto_tsquery('english', query_text)) desc,
      e.id
    limit bm25_pool
  ),
  fused as (
    select
      coalesce(v.id, b.id) as id,
      v.rnk as v_rank,
      b.rnk as b_rank,
      coalesce(1.0 / (rrf_k + v.rnk), 0.0) +
        coalesce(1.0 / (rrf_k + b.rnk), 0.0) as score
    from v
    full outer join b on b.id = v.id
  )
  select
    e.node_id,
    e.chunk_index,
    e.content,
    n.title,
    n.kind,
    n.category,
    f.v_rank::int as vector_rank,
    f.b_rank::int as bm25_rank,
    f.score::float as rrf_score,
    e.metadata
  from fused f
  join public.embeddings e on e.id = f.id
  join public.nodes n
    on n.id = e.node_id
   and n.workspace_id = match_workspace
  order by f.score desc nulls last, e.id
  limit match_count;
$$;

comment on function public.match_nodes(vector, uuid, integer, double precision, text, uuid[]) is
  'Workspace retrieval with an optional pre-ranked candidate node boundary. Empty array returns zero rows.';
comment on function public.hybrid_search(text, vector, uuid, integer, integer, integer, integer, text, uuid[]) is
  'Hybrid RRF retrieval with an optional pre-vector/BM25 candidate node boundary. Independent lanes are normalized and reranked by the application.';

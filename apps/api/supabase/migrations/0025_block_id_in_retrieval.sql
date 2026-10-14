-- Block-id propagation in retrieval (P8-02).
-- P8-02 introduces a stable, H2-derived `block_id` in every embedding row's
-- `metadata` JSONB (no schema change to the table itself). For retrieval to
-- surface that id, `match_nodes` and `hybrid_search` must include `metadata`
-- in their return shapes. Otherwise downstream code (rag.ts → RagHit) sees
-- nothing and always falls back to `null`.
--
-- Backward compatible: `metadata` is jsonb (nullable in return); rows that
-- predate P8-02 simply lack `block_id` and the consumer maps that to null.

-- PostgreSQL cannot change the OUT/RETURNS TABLE shape through CREATE OR
-- REPLACE. Drop the exact prior signatures from 0005 first so a clean local
-- reset (and any new environment replaying history) can apply this migration.
drop function if exists public.match_nodes(
  vector,
  uuid,
  integer,
  double precision,
  text
);

create or replace function match_nodes(
  query_embedding vector(1536),
  match_workspace uuid,
  match_count int default 8,
  similarity_threshold float default 0.0,
  embedding_version_filter text default null
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
language sql stable as $$
  select
    e.node_id,
    e.chunk_index,
    e.content,
    1 - (e.embedding <=> query_embedding) as similarity,
    n.title,
    n.kind,
    n.category,
    e.metadata
  from embeddings e
  join nodes n on n.id = e.node_id
  where e.workspace_id = match_workspace
    and 1 - (e.embedding <=> query_embedding) > similarity_threshold
    and (embedding_version_filter is null
         or e.embedding_version = embedding_version_filter)
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

drop function if exists public.hybrid_search(
  text,
  vector,
  uuid,
  integer,
  integer,
  integer,
  integer,
  text
);

create or replace function hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_workspace uuid,
  match_count int default 20,
  vector_pool int default 100,
  bm25_pool int default 100,
  rrf_k int default 60,
  embedding_version_filter text default null
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
language sql stable as $$
  with v as (
    select
      e.id,
      e.node_id,
      e.chunk_index,
      e.content,
      row_number() over (order by e.embedding <=> query_embedding) as rnk
    from embeddings e
    where e.workspace_id = match_workspace
      and (embedding_version_filter is null
           or e.embedding_version = embedding_version_filter)
    order by e.embedding <=> query_embedding
    limit vector_pool
  ),
  b as (
    select
      e.id,
      row_number() over (
        order by ts_rank_cd(e.content_tsv, plainto_tsquery('english', query_text)) desc
      ) as rnk
    from embeddings e
    where e.workspace_id = match_workspace
      and e.content_tsv @@ plainto_tsquery('english', query_text)
      and (embedding_version_filter is null
           or e.embedding_version = embedding_version_filter)
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
  join embeddings e on e.id = f.id
  join nodes n on n.id = e.node_id
  order by f.score desc nulls last
  limit match_count;
$$;

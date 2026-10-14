-- Embedding versioning (P2-07).
-- Tag every embedding row with the model id that produced it so we can:
--   1. Filter retrieval to only the current model's chunks.
--   2. Detect stale chunks when EMBEDDING_MODEL changes, and migrate them
--      out-of-band (script-driven) without losing coverage in the gap.
--
-- The column is `embedding_version` (model + tag, e.g. `openai/text-embedding-3-small`).
-- Stored as text — versioning policy is owner of the format. Defaulting to
-- 'legacy' for existing rows means they remain queryable while operators
-- decide whether to re-embed or filter them out.

alter table embeddings
  add column if not exists embedding_version text not null default 'legacy';

-- Backfill: any rows that existed before this migration are tagged 'legacy'.
-- (The default takes care of new inserts that don't supply a value, but the
-- column is required and the default is in place for all existing rows.)

create index if not exists embeddings_version_idx
  on embeddings(workspace_id, embedding_version);

-- ============================================================
-- match_nodes: add optional `embedding_version_filter` parameter.
-- NULL preserves the old behavior (returns all versions).
-- ============================================================

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
  category text
)
language sql stable as $$
  select
    e.node_id,
    e.chunk_index,
    e.content,
    1 - (e.embedding <=> query_embedding) as similarity,
    n.title,
    n.kind,
    n.category
  from embeddings e
  join nodes n on n.id = e.node_id
  where e.workspace_id = match_workspace
    and 1 - (e.embedding <=> query_embedding) > similarity_threshold
    and (embedding_version_filter is null
         or e.embedding_version = embedding_version_filter)
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- hybrid_search: same shape, additional optional version filter.
-- Old call sites that omit the parameter behave unchanged.
-- ============================================================

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
  rrf_score float
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
    f.score::float as rrf_score
  from fused f
  join embeddings e on e.id = f.id
  join nodes n on n.id = e.node_id
  order by f.score desc nulls last
  limit match_count;
$$;

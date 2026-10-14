-- Hybrid retrieval: pgvector cosine + Postgres tsvector BM25, fused via
-- Reciprocal Rank Fusion (RRF). Adds a generated tsvector column on
-- embeddings (so writes don't have to think about it) and a hybrid_search
-- RPC the app calls.
--
-- RRF reference: Cormack et al. 2009. With k=60, fusion scores a doc
-- ranked rᵥ by vector and r_b by BM25 as: 1/(k+rᵥ) + 1/(k+r_b).

alter table embeddings
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create index if not exists embeddings_tsv_idx on embeddings using gin (content_tsv);

create or replace function hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_workspace uuid,
  match_count int default 20,
  vector_pool int default 100,
  bm25_pool int default 100,
  rrf_k int default 60
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

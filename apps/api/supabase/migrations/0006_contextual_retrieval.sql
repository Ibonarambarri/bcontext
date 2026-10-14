-- Contextual Retrieval (P2-03).
-- Anthropic's "Contextual Retrieval" technique: before embedding each chunk,
-- prepend a 50-100 token LLM-generated context prefix that situates the chunk
-- within its parent document. Both the vector embedding and the BM25 index
-- key off the prefixed text; the raw `content` is preserved for UI snippets
-- so the user sees the actual document substring, not the synthesized prefix.
--
-- Reference: https://www.anthropic.com/news/contextual-retrieval
--
-- NOTE: when applied through tooling that uses the default 32MB
-- maintenance_work_mem, rebuilding `embeddings_tsv_idx` may fail with
-- "memory required is 61 MB". Run the statements in a session that has
-- bumped `maintenance_work_mem` to >=128MB (e.g. via `set
-- maintenance_work_mem='128MB';` over execute_sql), or run them outside the
-- migration runner.

alter table embeddings
  add column if not exists context_prefix text not null default '';

-- Replace the generated tsvector so BM25 indexes the prefixed text. A
-- generated column can't be redefined in place — drop the dependent GIN
-- index, drop the column, re-add both.
drop index if exists embeddings_tsv_idx;

alter table embeddings drop column if exists content_tsv;

alter table embeddings
  add column content_tsv tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(context_prefix, '') || ' ' || coalesce(content, '')
    )
  ) stored;

create index if not exists embeddings_tsv_idx on embeddings using gin (content_tsv);

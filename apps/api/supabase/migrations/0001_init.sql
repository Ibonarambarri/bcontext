-- Bcontext initial schema
-- Multi-tenant: organizations -> workspaces (projects) -> entities
-- Entities: documents (markdown), tasks (json), decisions, meetings, bugs
-- Vectorized via pgvector for RAG

create extension if not exists "uuid-ossp";
create extension if not exists vector;
create extension if not exists pgcrypto;

-- ============================================================
-- Organizations & workspaces
-- ============================================================

create table if not exists organizations (
  id uuid primary key default uuid_generate_v4(),
  slug text unique not null,
  name text not null,
  created_at timestamptz default now()
);

create table if not exists workspaces (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  github_repo text, -- "owner/name" for sync target (optional)
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (organization_id, slug)
);

create table if not exists memberships (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','viewer','agent')) default 'editor',
  created_at timestamptz default now(),
  unique (user_id, workspace_id)
);

create index if not exists memberships_user_idx on memberships(user_id);
create index if not exists memberships_workspace_idx on memberships(workspace_id);

-- ============================================================
-- Knowledge nodes — universal addressable unit
-- A node represents a file/page in the project tree. It can be:
--   - a folder (kind=folder)
--   - a markdown document (kind=doc)
--   - a structured json entity (kind=task|decision|meeting|bug|adr|other)
-- This unified model is what RAG and the agent surface operate on.
-- ============================================================

create table if not exists nodes (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  parent_id uuid references nodes(id) on delete cascade,

  kind text not null check (kind in (
    'folder','doc','task','decision','meeting','bug','adr','entity'
  )),

  -- The category bucket. Standard buckets every project gets:
  -- business, product, tech, decisions, meetings, tasks, bugs, ai
  category text,

  slug text not null,
  title text not null,

  -- Markdown body (with frontmatter YAML). Source of truth for docs.
  content_md text default '',

  -- Structured JSON payload. For tasks/decisions/meetings/etc.
  -- For docs this can hold the parsed frontmatter.
  data jsonb default '{}'::jsonb,

  -- Lifecycle (tasks): backlog|todo|in_progress|review|blocked|done
  status text,
  priority text check (priority in ('low','med','high','urgent')),
  assignee_id uuid references auth.users(id) on delete set null,
  due_date timestamptz,

  -- For ordering siblings in the sidebar tree
  position int default 0,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (workspace_id, parent_id, slug)
);

create index if not exists nodes_workspace_idx on nodes(workspace_id);
create index if not exists nodes_parent_idx on nodes(parent_id);
create index if not exists nodes_kind_idx on nodes(workspace_id, kind);
create index if not exists nodes_status_idx on nodes(workspace_id, status);

-- Auto-update updated_at
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists nodes_updated on nodes;
create trigger nodes_updated before update on nodes
for each row execute function set_updated_at();

-- ============================================================
-- Edges — typed relations between nodes (graph layer)
-- e.g. task --references--> doc, bug --caused_by--> decision
-- ============================================================

create table if not exists edges (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  from_node uuid not null references nodes(id) on delete cascade,
  to_node uuid not null references nodes(id) on delete cascade,
  relation text not null,
  created_at timestamptz default now(),
  unique (from_node, to_node, relation)
);

create index if not exists edges_workspace_idx on edges(workspace_id);
create index if not exists edges_from_idx on edges(from_node);
create index if not exists edges_to_idx on edges(to_node);

-- ============================================================
-- Embeddings — chunked semantic index of node content
-- ============================================================

create table if not exists embeddings (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  node_id uuid not null references nodes(id) on delete cascade,
  chunk_index int not null default 0,
  content text not null,
  embedding vector(1536), -- text-embedding-3-small dimension
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists embeddings_workspace_idx on embeddings(workspace_id);
create index if not exists embeddings_node_idx on embeddings(node_id);
create index if not exists embeddings_vec_idx
  on embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ============================================================
-- Chat sessions — per-workspace AI conversations with RAG memory
-- ============================================================

create table if not exists chat_sessions (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  title text,
  created_at timestamptz default now()
);

create table if not exists chat_messages (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists chat_messages_session_idx on chat_messages(session_id);

-- ============================================================
-- Activity log — append-only, fuels agents + audit trail
-- ============================================================

create table if not exists activity (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_kind text not null default 'human' check (actor_kind in ('human','agent','system')),
  verb text not null, -- created|updated|deleted|commented|linked|...
  target_node uuid references nodes(id) on delete set null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists activity_workspace_idx on activity(workspace_id, created_at desc);

-- ============================================================
-- RLS policies — workspace membership gates everything
-- ============================================================

alter table organizations enable row level security;
alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table nodes enable row level security;
alter table edges enable row level security;
alter table embeddings enable row level security;
alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;
alter table activity enable row level security;

-- Helper: is current user a member of workspace?
create or replace function is_workspace_member(ws uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from memberships m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

-- Memberships: a user can read their own rows
create policy memberships_self_read on memberships
  for select using (user_id = auth.uid());

-- Workspaces: visible to members
create policy workspaces_member_read on workspaces
  for select using (is_workspace_member(id));

-- Organizations: visible if you have a workspace in it
create policy organizations_member_read on organizations
  for select using (
    exists (
      select 1 from workspaces w
      where w.organization_id = organizations.id
        and is_workspace_member(w.id)
    )
  );

-- Nodes: full CRUD for members
create policy nodes_member_read on nodes
  for select using (is_workspace_member(workspace_id));
create policy nodes_member_write on nodes
  for insert with check (is_workspace_member(workspace_id));
create policy nodes_member_update on nodes
  for update using (is_workspace_member(workspace_id));
create policy nodes_member_delete on nodes
  for delete using (is_workspace_member(workspace_id));

-- Edges: same pattern
create policy edges_member_all on edges
  for all using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

-- Embeddings: read for members; writes typically via service role
create policy embeddings_member_read on embeddings
  for select using (is_workspace_member(workspace_id));

-- Chat: members
create policy chat_sessions_member_all on chat_sessions
  for all using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));
create policy chat_messages_member_all on chat_messages
  for all using (
    exists (
      select 1 from chat_sessions s
      where s.id = chat_messages.session_id
        and is_workspace_member(s.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from chat_sessions s
      where s.id = chat_messages.session_id
        and is_workspace_member(s.workspace_id)
    )
  );

-- Activity: read for members
create policy activity_member_read on activity
  for select using (is_workspace_member(workspace_id));

-- ============================================================
-- Vector search RPC — used by /api/chat retrieval
-- ============================================================

create or replace function match_nodes(
  query_embedding vector(1536),
  match_workspace uuid,
  match_count int default 8,
  similarity_threshold float default 0.0
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
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

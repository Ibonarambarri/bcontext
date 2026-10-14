-- 0013_oauth_clients.sql
--
-- P1-05 — OAuth 2.1 for user-delegated MCP clients.
--
-- The flow:
--   1. MCP client (Claude Desktop, custom) calls
--      POST /.well-known/oauth-authorization-server/register
--      with its redirect_uri(s). We return a fresh client_id + secret.
--   2. Client opens the user's browser at /oauth/authorize?...PKCE...
--   3. User signs in (Supabase Auth) and approves the workspaces scope.
--   4. We redirect back with a short-lived authorization_code.
--   5. Client exchanges code (with code_verifier) at /oauth/token →
--      access_token (workspace-scoped bearer) + optional refresh_token.
--
-- Tables:
--
--   oauth_clients              dynamically-registered clients
--                              (RFC 7591). Includes redirect_uris[] and
--                              hashed client_secret.
--
--   oauth_authorization_codes  one-shot codes. PKCE challenge stored
--                              alongside; verifier checked at /token.
--
--   oauth_access_tokens        issued access tokens (hashed). Carry
--                              workspace_id + scopes + user_id so the
--                              existing gate() helper can verify them
--                              with no code changes.
--
-- Access tokens use the SAME prefix shape as api_tokens
-- (`bctx_live_<base64url>`) so the unified verifier in lib/auth/tokens.ts
-- can resolve either type. The `kind` column distinguishes them at the
-- DB level — RLS reads it on update paths (revocation) only.

create table if not exists oauth_clients (
  id uuid primary key default uuid_generate_v4(),
  client_id text not null unique,
  client_secret_hash text not null,
  client_name text not null,
  redirect_uris text[] not null,
  scope text not null default 'nodes:read nodes:write chat:run',
  /* Per RFC 7591 client metadata fields */
  client_uri text,
  logo_uri text,
  tos_uri text,
  policy_uri text,
  /* Lifecycle */
  registered_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  revoked_at timestamptz
);

create index if not exists oauth_clients_client_id_idx
  on oauth_clients(client_id) where revoked_at is null;

create table if not exists oauth_authorization_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scope text not null,
  redirect_uri text not null,
  /* PKCE — RFC 7636 */
  code_challenge text not null,
  code_challenge_method text not null check (code_challenge_method in ('S256','plain')) default 'S256',
  /* Short TTL (60s) — checked in /token. */
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists oauth_codes_expires_idx
  on oauth_authorization_codes(expires_at)
  where consumed_at is null;

create table if not exists oauth_access_tokens (
  id uuid primary key default uuid_generate_v4(),
  token_hash text not null unique,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scopes text[] not null,
  prefix text not null,
  last4 text not null,
  expires_at timestamptz,
  created_at timestamptz default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists oauth_access_tokens_workspace_idx
  on oauth_access_tokens(workspace_id, created_at desc);
create index if not exists oauth_access_tokens_user_idx
  on oauth_access_tokens(user_id, created_at desc);

-- RLS: dynamically-registered clients are global (any user can register
-- one). Access tokens are visible to the user who issued them and to the
-- workspace owner/admin. No public read.

alter table oauth_clients enable row level security;
alter table oauth_authorization_codes enable row level security;
alter table oauth_access_tokens enable row level security;

drop policy if exists oauth_clients_self_read on oauth_clients;
create policy oauth_clients_self_read on oauth_clients
  for select using (registered_by = auth.uid());

drop policy if exists oauth_access_tokens_self_read on oauth_access_tokens;
create policy oauth_access_tokens_self_read on oauth_access_tokens
  for select using (user_id = auth.uid());

drop policy if exists oauth_access_tokens_workspace_admin_read on oauth_access_tokens;
create policy oauth_access_tokens_workspace_admin_read on oauth_access_tokens
  for select
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = oauth_access_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

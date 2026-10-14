-- 0058_oauth_refresh_tokens.sql
--
-- Refresh tokens for the OAuth 2.1 flow.
--
-- Until now /api/oauth/token only implemented the authorization_code grant.
-- Workspace-scoped access tokens carry a 30-day TTL that verifyToken()
-- enforces, so on day 31 every MCP client dropped to an unauthenticated
-- state with no way back except the full browser consent dance. This table
-- backs the refresh_token grant that closes that hole.
--
-- Rotation (OAuth 2.1 §4.13.2): each refresh consumes the presented token
-- and issues a new one. Tokens form a *family* — every descendant of one
-- authorization_code shares `family_id`. Replaying an already-consumed
-- token is the canonical signal of a leaked token, so it revokes the whole
-- family (and the access tokens minted from it) rather than just failing.
--
-- Only workspace-scoped grants get a refresh token: user-scoped tokens live
-- in user_api_tokens with no expiry, so there is nothing to refresh.

create table if not exists oauth_refresh_tokens (
  id uuid primary key default uuid_generate_v4(),
  token_hash text not null unique,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  scopes text[] not null,
  /* Rotation lineage. family_id is stable across the whole chain; parent_id
     points at the token this one replaced (null for the first). The first
     link omits family_id and the default seeds a fresh one; descendants
     pass their parent's value explicitly. */
  family_id uuid not null default uuid_generate_v4(),
  parent_id uuid references oauth_refresh_tokens(id) on delete set null,
  /* The access token minted alongside this refresh token, so a family
     revocation can kill the access tokens too. */
  access_token_id uuid references oauth_access_tokens(id) on delete set null,
  expires_at timestamptz,
  /* Set when the token is exchanged. A second exchange = replay. */
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists oauth_refresh_tokens_family_idx
  on oauth_refresh_tokens(family_id);
create index if not exists oauth_refresh_tokens_user_idx
  on oauth_refresh_tokens(user_id, created_at desc);
create index if not exists oauth_refresh_tokens_workspace_idx
  on oauth_refresh_tokens(workspace_id, created_at desc);
create index if not exists oauth_refresh_tokens_agent_idx
  on oauth_refresh_tokens(agent_id)
  where agent_id is not null and revoked_at is null;

-- RLS mirrors oauth_access_tokens: the issuing user sees their own rows,
-- workspace owners/admins see their workspace's. Writes go through the
-- service role only (the token endpoint), so no insert/update policies.

alter table oauth_refresh_tokens enable row level security;

drop policy if exists oauth_refresh_tokens_self_read on oauth_refresh_tokens;
create policy oauth_refresh_tokens_self_read on oauth_refresh_tokens
  for select using (user_id = auth.uid());

drop policy if exists oauth_refresh_tokens_workspace_admin_read on oauth_refresh_tokens;
create policy oauth_refresh_tokens_workspace_admin_read on oauth_refresh_tokens
  for select
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = oauth_refresh_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

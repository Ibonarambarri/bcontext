-- 0021: user-scoped bearer tokens.
--
-- Parallel to api_tokens but bound to an auth.users row instead of a
-- workspace. A user-scoped token grants whatever the user themselves
-- would have inside any workspace they belong to. The active workspace
-- is selected per-request via the X-Bcontext-Workspace header (or a
-- ?workspace=<slug> query parameter), and route handlers verify the
-- user's membership before serving data.

create table if not exists user_api_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  -- First 12 chars of the plaintext token (e.g. "bctx_live_aBcD") for UI display.
  prefix text not null,
  -- Last 4 chars of the plaintext token.
  last4 text not null,
  -- sha256(hex) of the secret suffix. The plaintext suffix is never stored.
  hash text not null unique,
  scopes text[] not null default '{}'::text[],
  created_at timestamptz default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists user_api_tokens_user_idx on user_api_tokens(user_id);
create index if not exists user_api_tokens_hash_idx on user_api_tokens(hash);

alter table user_api_tokens enable row level security;

-- Users can manage their own tokens only.
create policy user_api_tokens_self_all on user_api_tokens
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

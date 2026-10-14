-- 0022_oauth_user_scope.sql
--
-- Lets the OAuth authorization-code flow issue user-scoped tokens
-- (every workspace the user belongs to) in addition to the existing
-- workspace-scoped path.
--
-- When the user picks "All my workspaces" on /oauth/authorize:
--   - workspace_id is left NULL on the issued code
--   - scope_kind = 'user'
--   - /api/oauth/token's redeemCode mints into user_api_tokens
--     (no expiry; user-managed) instead of oauth_access_tokens.

alter table oauth_authorization_codes
  alter column workspace_id drop not null;

alter table oauth_authorization_codes
  add column if not exists scope_kind text not null default 'workspace';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'oauth_codes_scope_kind_chk'
  ) then
    alter table oauth_authorization_codes
      add constraint oauth_codes_scope_kind_chk
      check (scope_kind in ('workspace', 'user'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'oauth_codes_scope_consistency_chk'
  ) then
    alter table oauth_authorization_codes
      add constraint oauth_codes_scope_consistency_chk
      check (
        (scope_kind = 'workspace' and workspace_id is not null) or
        (scope_kind = 'user'      and workspace_id is null)
      );
  end if;
end$$;

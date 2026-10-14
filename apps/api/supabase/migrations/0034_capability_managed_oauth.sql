-- 0034_capability_managed_oauth.sql
--
-- Server-managed OAuth for upstream capability providers. OAuth client
-- registrations, short-lived authorization attempts and durable credentials
-- are deliberately separate lifecycles. Secret material never lives in these
-- tables: secret_ref values point to Supabase Vault entries and can only be
-- resolved through service-role-only RPCs.

-- Composite foreign keys below enforce the workspace boundary at the database
-- level. The connection id is already globally unique, but PostgreSQL needs a
-- matching unique key for (id, workspace_id).
alter table capability_connections
  add constraint capability_connections_id_workspace_key
  unique (id, workspace_id);

-- Managed OAuth credentials live in capability_oauth_credentials, so an OAuth
-- connection must not carry the legacy environment-variable secret_ref from
-- 0033. Static bearer and custom-header connections keep their existing shape.
-- Existing 0033 OAuth rows were static Bearer env references; preserve their
-- runtime behavior explicitly instead of making the new check fail or silently
-- treating those refs as managed OAuth credentials.
update capability_connections
set auth_type = 'bearer'
where auth_type = 'oauth' and secret_ref is not null;

alter table capability_connections
  drop constraint if exists capability_connections_check;
alter table capability_connections
  drop constraint if exists capability_connections_auth_fields_check;
alter table capability_connections
  add constraint capability_connections_check
  check (
    (auth_type = 'none' and secret_ref is null and auth_header_name is null)
    or (auth_type = 'oauth' and secret_ref is null and auth_header_name is null)
    or (auth_type = 'bearer' and secret_ref is not null and auth_header_name is null)
    or (auth_type = 'header' and secret_ref is not null and auth_header_name is not null)
  );

create table capability_oauth_clients (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  issuer text not null check (char_length(issuer) between 1 and 2048),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  secret_ref text check (
    secret_ref is null or secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  status text not null default 'pending'
    check (status in ('pending','active','failed','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, issuer, redirect_uri),
  unique (id, workspace_id),
  check (status <> 'active' or secret_ref is not null)
);

create table capability_oauth_attempts (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  state_hash text not null unique
    check (state_hash ~ '^[0-9a-f]{64}$'),
  endpoint_url text not null check (char_length(endpoint_url) between 1 and 4096),
  allowed_hosts text[] not null,
  secret_ref text not null check (
    secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  issuer text not null check (char_length(issuer) between 1 and 2048),
  resource text check (resource is null or char_length(resource) between 1 and 4096),
  scopes text[] not null default '{}'::text[],
  status text not null default 'pending'
    check (status in ('pending','authorized','connected','failed','expired','cancelled')),
  error_code text check (error_code is null or char_length(error_code) between 1 and 200),
  expires_at timestamptz not null,
  connected_at timestamptz,
  consumed_at timestamptz,
  capability_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade,
  check (cardinality(allowed_hosts) between 1 and 20),
  check (array_position(allowed_hosts, null) is null),
  check (cardinality(scopes) <= 100),
  check (array_position(scopes, null) is null),
  check (expires_at > created_at)
);

create table capability_oauth_credentials (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connection_id uuid not null unique,
  attempt_id uuid not null unique,
  secret_ref text not null check (
    secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  issuer text not null check (char_length(issuer) between 1 and 2048),
  resource text check (resource is null or char_length(resource) between 1 and 4096),
  scopes text[] not null default '{}'::text[],
  token_expires_at timestamptz,
  status text not null default 'active'
    check (status in ('active','refreshing','needs_reauth','revoked','failed')),
  refresh_lease_token uuid,
  refresh_lease_until timestamptz,
  revision integer not null default 1 check (revision > 0),
  last_refreshed_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (connection_id, workspace_id)
    references capability_connections(id, workspace_id) on delete cascade,
  foreign key (attempt_id, workspace_id)
    references capability_oauth_attempts(id, workspace_id) on delete no action,
  check (cardinality(scopes) <= 100),
  check (array_position(scopes, null) is null),
  check (
    (status = 'refreshing' and refresh_lease_token is not null and refresh_lease_until is not null)
    or (status <> 'refreshing' and refresh_lease_token is null and refresh_lease_until is null)
  )
);

create index capability_oauth_clients_workspace_status_idx
  on capability_oauth_clients(workspace_id, status);
create index capability_oauth_attempts_workspace_status_idx
  on capability_oauth_attempts(workspace_id, status, created_at desc);
create index capability_oauth_attempts_expires_idx
  on capability_oauth_attempts(expires_at)
  where consumed_at is null;
create index capability_oauth_attempts_capability_idx
  on capability_oauth_attempts(capability_id)
  where capability_id is not null;
create index capability_oauth_credentials_workspace_status_idx
  on capability_oauth_credentials(workspace_id, status);
create index capability_oauth_credentials_expires_idx
  on capability_oauth_credentials(token_expires_at)
  where status in ('active','refreshing') and token_expires_at is not null;
create index capability_oauth_credentials_refresh_lease_idx
  on capability_oauth_credentials(refresh_lease_until)
  where refresh_lease_token is not null;

create trigger capability_oauth_clients_updated
  before update on capability_oauth_clients
  for each row execute function set_updated_at();
create trigger capability_oauth_attempts_updated
  before update on capability_oauth_attempts
  for each row execute function set_updated_at();
create trigger capability_oauth_credentials_updated
  before update on capability_oauth_credentials
  for each row execute function set_updated_at();

-- These are control-plane/runtime tables. They are only accessed by the
-- application service role; browser roles have no policies and no grants.
alter table capability_oauth_clients enable row level security;
alter table capability_oauth_attempts enable row level security;
alter table capability_oauth_credentials enable row level security;

revoke all on table capability_oauth_clients from public, anon, authenticated;
revoke all on table capability_oauth_attempts from public, anon, authenticated;
revoke all on table capability_oauth_credentials from public, anon, authenticated;
grant select, insert, update, delete on table capability_oauth_clients to service_role;
grant select, insert, update, delete on table capability_oauth_attempts to service_role;
grant select, insert, update, delete on table capability_oauth_credentials to service_role;

-- connector_installs is served to the browser only through sanitized API
-- routes. Direct PostgREST access exposed writable Vault refs, which could let
-- an admin copy a ref between workspaces and make the service role dereference
-- another workspace's connector credential. Keep the table server-only.
revoke all on table connector_installs from public, anon, authenticated;
grant select, insert, update, delete on table connector_installs to service_role;

-- Upsert by stable name so retries rotate a value without leaking additional
-- Vault rows. The transaction-scoped advisory lock closes the create race;
-- callers never receive or manipulate encrypted Vault table contents.
create or replace function public.create_secret_or_update(
  secret_value text,
  secret_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text;
begin
  v_secret_name := pg_catalog.btrim(secret_name);
  if secret_value is null or pg_catalog.octet_length(secret_value) = 0 then
    raise exception using errcode = '22023', message = 'secret value is required';
  end if;
  if pg_catalog.octet_length(secret_value) > 1048576 then
    raise exception using errcode = '22023', message = 'secret value is too large';
  end if;
  if v_secret_name is null or pg_catalog.char_length(v_secret_name) = 0
     or pg_catalog.char_length(v_secret_name) > 200 then
    raise exception using errcode = '22023', message = 'valid secret name is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_secret_name, 0::bigint)
  );

  select s.id
    into v_secret_id
    from vault.secrets s
    where s.name = v_secret_name
    order by s.created_at desc
    limit 1;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      secret_value,
      v_secret_name,
      'Bcontext server-managed secret',
      null::uuid
    );
  else
    perform vault.update_secret(
      v_secret_id,
      secret_value,
      v_secret_name,
      'Bcontext server-managed secret',
      null::uuid
    );
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.read_vault_secret(secret_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select s.decrypted_secret
    into v_secret
    from vault.decrypted_secrets s
    where s.id = secret_id
    limit 1;
  return v_secret;
end;
$$;

create or replace function public.delete_vault_secret(secret_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from vault.secrets where id = secret_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.create_secret_or_update(text, text)
  from public, anon, authenticated;
revoke all on function public.read_vault_secret(uuid)
  from public, anon, authenticated;
revoke all on function public.delete_vault_secret(uuid)
  from public, anon, authenticated;
grant execute on function public.create_secret_or_update(text, text)
  to service_role;
grant execute on function public.read_vault_secret(uuid)
  to service_role;
grant execute on function public.delete_vault_secret(uuid)
  to service_role;

-- Opportunistic expiry used by OAuth start/status routes. Row locks and Vault
-- deletion share one transaction, so a callback/attach race can never observe
-- an expired attempt whose credential material was deleted underneath it.
create or replace function public.expire_capability_oauth_attempts(
  p_workspace_id uuid,
  p_now timestamptz,
  p_limit integer default 100
)
returns table (
  attempt_id uuid,
  secret_ref text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_limit integer;
begin
  if p_now is null then
    raise exception using errcode = '22023', message = 'expiry time is required';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 100);

  for v_attempt in
    select a.id, a.secret_ref
    from public.capability_oauth_attempts a
    where (p_workspace_id is null or a.workspace_id = p_workspace_id)
      and a.status in ('pending', 'authorized')
      and a.expires_at <= p_now
    order by a.expires_at, a.id
    limit v_limit
    for update skip locked
  loop
    update public.capability_oauth_attempts a
    set status = 'expired',
        error_code = 'oauth_attempt_expired',
        updated_at = pg_catalog.now()
    where a.id = v_attempt.id
      and (p_workspace_id is null or a.workspace_id = p_workspace_id)
      and a.status in ('pending', 'authorized');

    delete from vault.secrets v
    where v.id = pg_catalog.substring(v_attempt.secret_ref, 7)::uuid;

    attempt_id := v_attempt.id;
    secret_ref := v_attempt.secret_ref;
    return next;
  end loop;
end;
$$;

revoke all on function public.expire_capability_oauth_attempts(
  uuid, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.expire_capability_oauth_attempts(
  uuid, timestamptz, integer
) to service_role;

-- Browser cleanup is best-effort, so an abandoned popup must not be the only
-- mechanism protecting refresh tokens. Supabase Cron performs the same locked,
-- transactional cleanup even when nobody revisits the workspace.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule(
  'bcontext-expire-capability-oauth-attempts',
  '*/5 * * * *',
  $cron$
    select count(*)
    from public.expire_capability_oauth_attempts(
      null::uuid,
      pg_catalog.now(),
      100
    );
  $cron$
);

-- Cascading deletion of a workspace/capability must not strand OAuth material
-- in Vault. Attempts and credentials deliberately share a ref after attach;
-- deleting the same Vault id twice is harmless, while the credential FK keeps
-- an attempt from being deleted on its own while that credential still exists.
create or replace function public.delete_oauth_vault_secret_on_row_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.secret_ref is not null
     and old.secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    delete from vault.secrets
    where id = pg_catalog.substring(old.secret_ref, 7)::uuid;
  end if;
  return old;
end;
$$;

revoke all on function public.delete_oauth_vault_secret_on_row_delete()
  from public, anon, authenticated;

create trigger capability_oauth_clients_delete_secret
  after delete on capability_oauth_clients
  for each row execute function public.delete_oauth_vault_secret_on_row_delete();
create trigger capability_oauth_clients_replace_secret
  after update of secret_ref on capability_oauth_clients
  for each row
  when (old.secret_ref is not null and old.secret_ref is distinct from new.secret_ref)
  execute function public.delete_oauth_vault_secret_on_row_delete();
create trigger capability_oauth_attempts_delete_secret
  after delete on capability_oauth_attempts
  for each row execute function public.delete_oauth_vault_secret_on_row_delete();
create trigger capability_oauth_credentials_delete_secret
  after delete on capability_oauth_credentials
  for each row execute function public.delete_oauth_vault_secret_on_row_delete();

-- Consume an authorized attempt and attach its encrypted bundle to exactly one
-- OAuth connection in the same transaction. This closes the crash/replay gap
-- between inserting a credential and marking the short-lived attempt consumed.
create or replace function public.attach_capability_oauth_credential(
  p_workspace_id uuid,
  p_user_id uuid,
  p_attempt_id uuid,
  p_connection_id uuid,
  p_capability_id uuid,
  p_endpoint_url text,
  p_token_expires_at timestamptz
)
returns public.capability_oauth_credentials
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.capability_oauth_attempts%rowtype;
  v_connection public.capability_connections%rowtype;
  v_credential public.capability_oauth_credentials%rowtype;
begin
  select a.* into v_attempt
  from public.capability_oauth_attempts a
  where a.id = p_attempt_id
    and a.workspace_id = p_workspace_id
    and a.requested_by = p_user_id
  for update;

  if not found
     or v_attempt.status <> 'authorized'
     or v_attempt.endpoint_url <> p_endpoint_url
     or v_attempt.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
  end if;

  select c.* into v_connection
  from public.capability_connections c
  where c.id = p_connection_id
    and c.workspace_id = p_workspace_id
    and c.capability_id = p_capability_id
  for update;

  if not found
     or v_connection.auth_type <> 'oauth'
     or v_connection.secret_ref is not null
     or v_connection.endpoint_url <> p_endpoint_url then
    raise exception using errcode = 'P0001', message = 'oauth_connection_not_attachable';
  end if;

  insert into public.capability_oauth_credentials (
    workspace_id, connection_id, attempt_id, secret_ref, issuer, resource,
    scopes, token_expires_at, status
  ) values (
    p_workspace_id, p_connection_id, p_attempt_id, v_attempt.secret_ref,
    v_attempt.issuer, v_attempt.resource, v_attempt.scopes,
    p_token_expires_at, 'active'
  )
  returning * into v_credential;

  update public.capability_oauth_attempts
  set status = 'connected', consumed_at = pg_catalog.now(),
      capability_id = p_capability_id, error_code = null,
      updated_at = pg_catalog.now()
  where id = p_attempt_id
    and workspace_id = p_workspace_id
    and status = 'authorized';

  if not found then
    raise exception using errcode = '40001', message = 'oauth_attempt_raced';
  end if;

  return v_credential;
end;
$$;

revoke all on function public.attach_capability_oauth_credential(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.attach_capability_oauth_credential(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz
) to service_role;

-- Register the complete OAuth-backed capability graph and consume the
-- authorization attempt in one transaction. Keeping this in PostgreSQL avoids
-- an approved capability ever becoming visible without its credential if the
-- application process exits between otherwise independent writes.
--
-- A retry after a lost HTTP response is idempotent: when the same attempt is
-- already connected to an equivalent graph, the existing ids are returned.
create or replace function public.register_capability_with_oauth(
  p_workspace_id uuid,
  p_user_id uuid,
  p_attempt_id uuid,
  p_expected_endpoint_url text,
  p_key text,
  p_provider text,
  p_title text,
  p_description text,
  p_provenance jsonb,
  p_environment text,
  p_contract jsonb,
  p_contract_digest text,
  p_change_summary text,
  p_status text,
  p_timeout_ms integer
)
returns table (
  capability_id uuid,
  version_id uuid,
  connection_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.capability_oauth_attempts%rowtype;
  v_capability_id uuid;
  v_version_id uuid;
  v_connection_id uuid;
  v_secret_bundle jsonb;
  v_token_expires_at timestamptz;
begin
  if p_status not in ('draft', 'approved') then
    raise exception using errcode = '22023', message = 'oauth_capability_status_invalid';
  end if;
  if p_timeout_ms < 1000 or p_timeout_ms > 55000 then
    raise exception using errcode = '22023', message = 'oauth_capability_timeout_invalid';
  end if;
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'oauth_admin_required';
  end if;

  select a.* into v_attempt
  from public.capability_oauth_attempts a
  where a.id = p_attempt_id
    and a.workspace_id = p_workspace_id
    and a.requested_by = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
  end if;

  -- Safe replay after the transaction committed but its HTTP response was
  -- lost. Require the immutable request fields to match before returning it.
  if v_attempt.status = 'connected' and v_attempt.capability_id is not null then
    if v_attempt.endpoint_url <> p_expected_endpoint_url then
      raise exception using errcode = 'P0001', message = 'oauth_registration_mismatch';
    end if;
    select c.id, cv.id, cc.id
      into v_capability_id, v_version_id, v_connection_id
    from public.capabilities c
    join public.capability_versions cv
      on cv.id = c.current_version_id
     and cv.capability_id = c.id
     and cv.workspace_id = c.workspace_id
    join public.capability_connections cc
      on cc.capability_id = c.id
     and cc.workspace_id = c.workspace_id
     and cc.environment = p_environment
    join public.capability_oauth_credentials oc
      on oc.connection_id = cc.id
     and oc.workspace_id = c.workspace_id
     and oc.attempt_id = v_attempt.id
    where c.id = v_attempt.capability_id
      and c.workspace_id = p_workspace_id
      and c.key = p_key
      and c.type = 'mcp_server'
      and c.provider = p_provider
      and c.title = p_title
      and c.description = p_description
      and c.provenance = p_provenance
      and c.status = p_status
      and cv.environment = p_environment
      and cv.contract = p_contract
      and cv.contract_digest = p_contract_digest
      and cv.change_summary is not distinct from p_change_summary
      and cc.endpoint_url = v_attempt.endpoint_url
      and cc.auth_type = 'oauth'
      and cc.secret_ref is null
      and cc.timeout_ms = p_timeout_ms;

    if not found then
      raise exception using errcode = 'P0001', message = 'oauth_registration_mismatch';
    end if;

    return query select v_capability_id, v_version_id, v_connection_id, false;
    return;
  end if;

  if v_attempt.status <> 'authorized'
     or v_attempt.consumed_at is not null
     or v_attempt.capability_id is not null
     or v_attempt.expires_at <= pg_catalog.now()
     or v_attempt.endpoint_url <> p_expected_endpoint_url then
    raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
  end if;

  begin
    select s.decrypted_secret::jsonb
      into v_secret_bundle
    from vault.decrypted_secrets s
    where s.id = pg_catalog.replace(v_attempt.secret_ref, 'vault:', '')::uuid
    limit 1;
  exception when others then
    raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
  end;
  if v_secret_bundle is null
     or coalesce(v_secret_bundle #>> '{tokens,access_token}', '') = ''
     or pg_catalog.lower(coalesce(v_secret_bundle #>> '{tokens,token_type}', '')) <> 'bearer' then
    raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
  end if;
  begin
    v_token_expires_at := nullif(v_secret_bundle ->> 'tokenExpiresAt', '')::timestamptz;
  exception when others then
    raise exception using errcode = 'P0001', message = 'oauth_secret_unavailable';
  end;

  insert into public.capabilities (
    workspace_id, key, type, owner_user_id, provider, title, description,
    provenance, status
  ) values (
    p_workspace_id, p_key, 'mcp_server', p_user_id, p_provider, p_title,
    p_description, p_provenance, 'draft'
  )
  returning id into v_capability_id;

  insert into public.capability_versions (
    workspace_id, capability_id, version, environment, contract,
    contract_digest, change_summary, created_by
  ) values (
    p_workspace_id, v_capability_id, 1, p_environment, p_contract,
    p_contract_digest, p_change_summary, p_user_id
  )
  returning id into v_version_id;

  -- Endpoint and egress hosts come from the server-validated attempt, never
  -- from mutable browser payload fields.
  insert into public.capability_connections (
    workspace_id, capability_id, environment, endpoint_url, auth_type,
    auth_header_name, secret_ref, allowed_hosts, timeout_ms
  ) values (
    p_workspace_id, v_capability_id, p_environment, v_attempt.endpoint_url,
    'oauth', null, null, v_attempt.allowed_hosts, p_timeout_ms
  )
  returning id into v_connection_id;

  insert into public.capability_oauth_credentials (
    workspace_id, connection_id, attempt_id, secret_ref, issuer, resource,
    scopes, token_expires_at, status
  ) values (
    p_workspace_id, v_connection_id, v_attempt.id, v_attempt.secret_ref,
    v_attempt.issuer, v_attempt.resource, v_attempt.scopes,
    v_token_expires_at, 'active'
  );

  update public.capability_oauth_attempts
  set status = 'connected', consumed_at = pg_catalog.now(),
      capability_id = v_capability_id, error_code = null,
      updated_at = pg_catalog.now()
  where id = v_attempt.id
    and workspace_id = p_workspace_id
    and status = 'authorized';

  if not found then
    raise exception using errcode = '40001', message = 'oauth_attempt_raced';
  end if;

  update public.capabilities
  set current_version_id = v_version_id, status = p_status,
      disabled_at = null, updated_at = pg_catalog.now()
  where id = v_capability_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception using errcode = '40001', message = 'oauth_capability_finalize_raced';
  end if;

  return query select v_capability_id, v_version_id, v_connection_id, true;
end;
$$;

revoke all on function public.register_capability_with_oauth(
  uuid, uuid, uuid, text, text, text, text, text, jsonb, text, jsonb, text,
  text, text, integer
) from public, anon, authenticated;
grant execute on function public.register_capability_with_oauth(
  uuid, uuid, uuid, text, text, text, text, text, jsonb, text, jsonb, text,
  text, text, integer
) to service_role;

-- 0035_capability_provider_lifecycle.sql
--
-- Safe editing and removal for gateway providers. Providers are tombstoned
-- instead of hard-deleted so immutable contracts and the invocation ledger
-- remain available for audit. OAuth credential rows are still deleted when a
-- provider is rotated or removed; the 0034 triggers delete their Vault secret.

alter table public.capabilities
  add column deleted_at timestamptz;

alter table public.capabilities
  drop constraint if exists capabilities_workspace_id_key_key;

create unique index capabilities_workspace_active_key_idx
  on public.capabilities(workspace_id, key)
  where deleted_at is null;

create index capabilities_workspace_deleted_idx
  on public.capabilities(workspace_id, deleted_at)
  where deleted_at is not null;

-- Active grants are valid only for live, approved targets. Row locks serialize
-- grant creation with provider edits: a grant committed first is revoked by
-- the edit, while a grant waiting behind an edit observes the new draft state.
create or replace function public.validate_active_capability_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is not null then
    return new;
  end if;

  if new.capability_id is not null then
    perform c.id
    from public.capabilities c
    where c.id = new.capability_id
      and c.workspace_id = new.workspace_id
      and c.status = 'approved'
      and c.disabled_at is null
      and c.deleted_at is null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  else
    perform b.id
    from public.capability_bundles b
    where b.id = new.bundle_id
      and b.workspace_id = new.workspace_id
      and b.status = 'approved'
      and b.current_version_id is not null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_active_capability_grant() from public, anon, authenticated;

create trigger capability_grants_validate_active_target
before insert or update of capability_id, bundle_id, revoked_at
on public.capability_grants
for each row execute function public.validate_active_capability_grant();

-- A bundle may pin immutable contracts, but executable connections live on
-- the capability. Therefore a new current bundle is accepted only when every
-- pinned version is still current. Locking those capability rows closes the
-- publish-vs-provider-edit race in both directions.
create or replace function public.validate_capability_bundle_current_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capability record;
  v_item_count integer := 0;
begin
  if new.current_version_id is null then
    if new.status = 'approved' then
      raise exception using errcode = '23514', message = 'capability_bundle_current_version_required';
    end if;
    return new;
  end if;
  if not exists (
    select 1
    from public.capability_bundle_versions bv
    where bv.id = new.current_version_id
      and bv.bundle_id = new.id
      and bv.workspace_id = new.workspace_id
  ) then
    raise exception using errcode = '23514', message = 'capability_bundle_current_version_invalid';
  end if;

  for v_capability in
    select c.id, c.current_version_id, c.status, c.disabled_at, c.deleted_at,
           cv.id as pinned_version_id
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capabilities c
      on c.id = cv.capability_id
     and c.workspace_id = cv.workspace_id
    where bi.workspace_id = new.workspace_id
      and bi.bundle_version_id = new.current_version_id
    order by c.id
    for share of c
  loop
    v_item_count := v_item_count + 1;
    if v_capability.deleted_at is not null
       or v_capability.current_version_id is distinct from v_capability.pinned_version_id
       or (new.status = 'approved' and (
         v_capability.status <> 'approved' or v_capability.disabled_at is not null
       )) then
      raise exception using errcode = '23514', message = 'capability_bundle_provider_stale';
    end if;
  end loop;
  if v_item_count = 0 then
    raise exception using errcode = '23514', message = 'capability_bundle_items_required';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_capability_bundle_current_version() from public, anon, authenticated;

create trigger capability_bundles_validate_current_version
before insert or update on public.capability_bundles
for each row execute function public.validate_capability_bundle_current_version();

create or replace function public.protect_current_bundle_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_current boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select b.current_version_id = old.bundle_version_id
      into v_is_current
    from public.capability_bundle_versions bv
    join public.capability_bundles b
      on b.id = bv.bundle_id and b.workspace_id = bv.workspace_id
    where bv.id = old.bundle_version_id
      and bv.workspace_id = old.workspace_id
    for share of b;
    if found and v_is_current then
      raise exception using errcode = '55000', message = 'capability_bundle_current_items_immutable';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select b.current_version_id = new.bundle_version_id
      into v_is_current
    from public.capability_bundle_versions bv
    join public.capability_bundles b
      on b.id = bv.bundle_id and b.workspace_id = bv.workspace_id
    where bv.id = new.bundle_version_id
      and bv.workspace_id = new.workspace_id
    for share of b;
    if found and v_is_current then
      raise exception using errcode = '55000', message = 'capability_bundle_current_items_immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_current_bundle_items() from public, anon, authenticated;

create trigger capability_bundle_items_protect_current
before insert or update or delete on public.capability_bundle_items
for each row execute function public.protect_current_bundle_items();

create or replace function public.protect_current_bundle_capability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    old.current_version_id is distinct from new.current_version_id
    or (old.status = 'approved' and new.status <> 'approved')
    or (old.deleted_at is null and new.deleted_at is not null)
    or (old.disabled_at is null and new.disabled_at is not null)
  ) and exists (
    select 1
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capability_bundle_versions bv
      on bv.id = bi.bundle_version_id
     and bv.workspace_id = bi.workspace_id
    join public.capability_bundles b
      on b.id = bv.bundle_id
     and b.workspace_id = bv.workspace_id
     and b.current_version_id = bv.id
    where cv.capability_id = old.id
      and cv.workspace_id = old.workspace_id
  ) then
    raise exception using errcode = '55000', message = 'capability_provider_used_by_bundle';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_current_bundle_capability() from public, anon, authenticated;

create trigger capabilities_protect_current_bundle
before update of status, current_version_id, disabled_at, deleted_at
on public.capabilities
for each row execute function public.protect_current_bundle_capability();

-- Update an agent's workspace role/scopes and complete grant set atomically.
-- Locks and validation prevent stale Connections requests from restoring
-- access while a provider is being rotated, and serialize concurrent edits
-- for the same durable agent principal.
create or replace function public.update_agent_connection_policy(
  p_workspace_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_display_name text,
  p_role text,
  p_scopes text[],
  p_capability_ids uuid[],
  p_bundle_ids uuid[]
)
returns table (
  principal_id uuid,
  grants_written integer,
  effective_scopes text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_principal_id uuid;
  v_written integer := 0;
  v_effective_scopes text[] := '{}'::text[];
begin
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'capability_admin_required';
  end if;
  if p_role not in ('observer', 'collaborator', 'operator', 'custom')
     or p_scopes is null
     or pg_catalog.cardinality(p_scopes) not between 1 and 7
     or pg_catalog.array_position(p_scopes, null) is not null
     or not (p_scopes <@ array[
       'nodes:read','nodes:write','chat:run','skills:execute',
       'agents:read','agents:write','admin:*'
     ]::text[])
     or p_display_name is null
     or pg_catalog.char_length(p_display_name) not between 1 and 200
     or pg_catalog.cardinality(coalesce(p_capability_ids, '{}'::uuid[])) > 100
     or pg_catalog.cardinality(coalesce(p_bundle_ids, '{}'::uuid[])) > 100 then
    raise exception using errcode = '22023', message = 'capability_grant_input_invalid';
  end if;

  perform awa.agent_id
  from public.agent_workspace_access awa
  join public.agents a on a.id = awa.agent_id
  where awa.agent_id = p_agent_id
    and awa.workspace_id = p_workspace_id
    and awa.revoked_at is null
    and a.status = 'active'
  for update of awa, a;
  if not found then
    raise exception using errcode = 'P0002', message = 'agent_connection_not_found';
  end if;

  insert into public.capability_principals (
    workspace_id, kind, source_type, source_id, display_name, disabled_at
  ) values (
    p_workspace_id, 'agent', 'agent', p_agent_id::text, p_display_name, null
  )
  on conflict (workspace_id, source_type, source_id) do update
  set kind = 'agent', display_name = excluded.display_name,
      disabled_at = null, updated_at = pg_catalog.now()
  returning id into v_principal_id;

  for v_id in
    select distinct value
    from pg_catalog.unnest(coalesce(p_capability_ids, '{}'::uuid[])) value
    order by value
  loop
    perform c.id
    from public.capabilities c
    where c.id = v_id
      and c.workspace_id = p_workspace_id
      and c.status = 'approved'
      and c.disabled_at is null
      and c.deleted_at is null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  end loop;

  for v_id in
    select distinct value
    from pg_catalog.unnest(coalesce(p_bundle_ids, '{}'::uuid[])) value
    order by value
  loop
    perform b.id
    from public.capability_bundles b
    where b.id = v_id
      and b.workspace_id = p_workspace_id
      and b.status = 'approved'
      and b.current_version_id is not null
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'capability_grant_target_unavailable';
    end if;
  end loop;

  update public.capability_grants g
  set revoked_at = pg_catalog.now()
  where g.workspace_id = p_workspace_id
    and g.principal_id = v_principal_id
    and g.revoked_at is null;

  insert into public.capability_grants (
    workspace_id, principal_id, capability_id, bundle_id,
    actions, constraints, created_by
  )
  select p_workspace_id, v_principal_id, value, null,
         array['discover','invoke']::text[], '{}'::jsonb, p_user_id
  from (
    select distinct value
    from pg_catalog.unnest(coalesce(p_capability_ids, '{}'::uuid[])) value
  ) direct_grants
  union all
  select p_workspace_id, v_principal_id, null, value,
         array['discover','invoke']::text[], '{}'::jsonb, p_user_id
  from (
    select distinct value
    from pg_catalog.unnest(coalesce(p_bundle_ids, '{}'::uuid[])) value
  ) bundle_grants;
  get diagnostics v_written = row_count;

  update public.agent_workspace_access awa
  set role = p_role, scopes = p_scopes
  where awa.agent_id = p_agent_id
    and awa.workspace_id = p_workspace_id
    and awa.revoked_at is null;
  if not found then
    raise exception using errcode = '40001', message = 'agent_connection_update_raced';
  end if;

  select coalesce(pg_catalog.array_agg(allowed.scope order by allowed.ordinality), '{}'::text[])
    into v_effective_scopes
  from pg_catalog.unnest(array[
    'nodes:read','nodes:write','chat:run','skills:execute',
    'agents:read','agents:write','admin:*'
  ]::text[]) with ordinality as allowed(scope, ordinality)
  where not exists (
    select 1
    from public.agent_workspace_access policy
    where policy.agent_id = p_agent_id
      and policy.revoked_at is null
      and not (allowed.scope = any(policy.scopes))
  );

  update public.api_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;
  update public.oauth_access_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;
  update public.user_api_tokens
  set scopes = v_effective_scopes
  where agent_id = p_agent_id and revoked_at is null;

  return query select v_principal_id, v_written, v_effective_scopes;
end;
$$;

revoke all on function public.update_agent_connection_policy(
  uuid, uuid, uuid, text, text, text[], uuid[], uuid[]
) from public, anon, authenticated;
grant execute on function public.update_agent_connection_policy(
  uuid, uuid, uuid, text, text, text[], uuid[], uuid[]
) to service_role;

create or replace function public.update_capability_provider(
  p_workspace_id uuid,
  p_user_id uuid,
  p_capability_id uuid,
  p_expected_updated_at timestamptz,
  p_provider text,
  p_title text,
  p_description text,
  p_provenance jsonb,
  p_environment text,
  p_contract jsonb,
  p_contract_digest text,
  p_endpoint_url text,
  p_auth_type text,
  p_auth_header_name text,
  p_secret_ref text,
  p_allowed_hosts text[],
  p_timeout_ms integer,
  p_preserve_credential boolean,
  p_oauth_attempt_id uuid default null
)
returns table (
  capability_id uuid,
  version_id uuid,
  connection_id uuid,
  grants_revoked integer,
  material_change boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capability public.capabilities%rowtype;
  v_connection public.capability_connections%rowtype;
  v_attempt public.capability_oauth_attempts%rowtype;
  v_current_digest text;
  v_version_id uuid;
  v_secret_ref text;
  v_secret_bundle jsonb;
  v_token_expires_at timestamptz;
  v_material_change boolean;
  v_grants_revoked integer := 0;
begin
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'capability_admin_required';
  end if;

  if p_environment is null or pg_catalog.char_length(p_environment) not between 1 and 50
     or p_endpoint_url is null or pg_catalog.char_length(p_endpoint_url) not between 1 and 4096
     or p_auth_type not in ('none', 'oauth', 'bearer', 'header')
     or p_allowed_hosts is null or pg_catalog.cardinality(p_allowed_hosts) not between 1 and 20
     or pg_catalog.array_position(p_allowed_hosts, null) is not null
     or p_timeout_ms not between 1000 and 55000
     or p_preserve_credential is null then
    raise exception using errcode = '22023', message = 'capability_provider_input_invalid';
  end if;

  -- Match the 0034 attach RPC lock order (attempt before connection) so an
  -- OAuth reconnect cannot deadlock with an older attach request.
  if p_auth_type = 'oauth' and not p_preserve_credential then
    if p_oauth_attempt_id is null then
      raise exception using errcode = '22023', message = 'capability_oauth_attempt_required';
    end if;
    select a.* into v_attempt
    from public.capability_oauth_attempts a
    where a.id = p_oauth_attempt_id
      and a.workspace_id = p_workspace_id
      and a.requested_by = p_user_id
    for update;
    if not found
       or v_attempt.status <> 'authorized'
       or v_attempt.consumed_at is not null
       or v_attempt.capability_id is not null
       or v_attempt.expires_at <= pg_catalog.now()
       or v_attempt.endpoint_url <> p_endpoint_url
       or v_attempt.allowed_hosts is distinct from p_allowed_hosts then
      raise exception using errcode = 'P0001', message = 'oauth_attempt_not_attachable';
    end if;
  end if;

  select c.* into v_capability
  from public.capabilities c
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id
  for update;

  if not found or v_capability.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'capability_provider_not_found';
  end if;
  if p_expected_updated_at is not null
     and v_capability.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'capability_provider_stale';
  end if;
  if v_capability.type not in ('mcp_server', 'api', 'workflow') then
    raise exception using errcode = '22023', message = 'capability_provider_not_executable';
  end if;

  select cc.* into v_connection
  from public.capability_connections cc
  where cc.capability_id = p_capability_id
    and cc.workspace_id = p_workspace_id
    and cc.environment = p_environment
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'capability_connection_not_found';
  end if;

  select cv.contract_digest into v_current_digest
  from public.capability_versions cv
  where cv.id = v_capability.current_version_id
    and cv.capability_id = v_capability.id
    and cv.workspace_id = v_capability.workspace_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'capability_version_not_found';
  end if;

  v_secret_ref := p_secret_ref;
  if p_preserve_credential then
    if p_oauth_attempt_id is not null then
      raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
    end if;
    if p_auth_type = 'oauth' then
      if v_connection.auth_type <> 'oauth'
         or v_connection.endpoint_url <> p_endpoint_url
         or v_connection.allowed_hosts is distinct from p_allowed_hosts
         or not exists (
           select 1
           from public.capability_oauth_credentials oc
           where oc.workspace_id = p_workspace_id
             and oc.connection_id = v_connection.id
             and oc.status in ('active', 'refreshing')
         ) then
        raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
      end if;
      v_secret_ref := null;
    elsif p_auth_type in ('bearer', 'header') then
      if v_connection.auth_type <> p_auth_type
         or v_connection.endpoint_url <> p_endpoint_url
         or v_connection.allowed_hosts is distinct from p_allowed_hosts
         or v_connection.auth_header_name is distinct from p_auth_header_name
         or v_connection.secret_ref is null then
        raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
      end if;
      v_secret_ref := v_connection.secret_ref;
    else
      raise exception using errcode = '22023', message = 'capability_credential_preserve_invalid';
    end if;
  end if;

  if p_auth_type = 'none' then
    if p_auth_header_name is not null or p_secret_ref is not null
       or p_oauth_attempt_id is not null or p_preserve_credential then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
    v_secret_ref := null;
  elsif p_auth_type = 'oauth' then
    if p_auth_header_name is not null or p_secret_ref is not null then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
    if not p_preserve_credential then
      begin
        select s.decrypted_secret::jsonb into v_secret_bundle
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
    end if;
    v_secret_ref := null;
  elsif p_auth_type = 'bearer' then
    if p_auth_header_name is not null or p_oauth_attempt_id is not null
       or (not p_preserve_credential and v_secret_ref is null) then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
  elsif p_auth_type = 'header' then
    if p_auth_header_name is null or p_oauth_attempt_id is not null
       or (not p_preserve_credential and v_secret_ref is null) then
      raise exception using errcode = '22023', message = 'capability_auth_fields_invalid';
    end if;
  end if;

  v_material_change :=
    v_capability.provider is distinct from p_provider
    or v_current_digest is distinct from p_contract_digest
    or v_connection.endpoint_url is distinct from p_endpoint_url
    or v_connection.auth_type is distinct from p_auth_type
    or v_connection.auth_header_name is distinct from p_auth_header_name
    or v_connection.secret_ref is distinct from v_secret_ref
    or v_connection.allowed_hosts is distinct from p_allowed_hosts
    or (
      not p_preserve_credential
      and p_auth_type in ('oauth', 'bearer', 'header')
    );

  if v_material_change and exists (
    select 1
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capability_bundle_versions bv
      on bv.id = bi.bundle_version_id
     and bv.workspace_id = bi.workspace_id
    join public.capability_bundles b
      on b.id = bv.bundle_id
     and b.workspace_id = bv.workspace_id
     and b.current_version_id = bv.id
    where cv.capability_id = p_capability_id
      and cv.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '55000', message = 'capability_provider_used_by_bundle';
  end if;

  select cv.id into v_version_id
  from public.capability_versions cv
  where cv.capability_id = p_capability_id
    and cv.workspace_id = p_workspace_id
    and cv.contract_digest = p_contract_digest
  limit 1;

  if v_version_id is null then
    insert into public.capability_versions (
      workspace_id, capability_id, version, environment, contract,
      contract_digest, change_summary, created_by
    )
    select p_workspace_id, p_capability_id,
      coalesce(pg_catalog.max(cv.version), 0) + 1,
      p_environment, p_contract, p_contract_digest,
      'Updated from Connections', p_user_id
    from public.capability_versions cv
    where cv.capability_id = p_capability_id
      and cv.workspace_id = p_workspace_id
    returning id into v_version_id;
  end if;

  if v_material_change then
    with revoked as (
      update public.capability_grants g
      set revoked_at = pg_catalog.now()
      where g.workspace_id = p_workspace_id
        and g.capability_id = p_capability_id
        and g.revoked_at is null
      returning 1
    )
    select pg_catalog.count(*)::integer into v_grants_revoked from revoked;
  end if;

  if not (p_auth_type = 'oauth' and p_preserve_credential) then
    delete from public.capability_oauth_credentials oc
    where oc.workspace_id = p_workspace_id
      and oc.connection_id = v_connection.id;
  end if;

  update public.capability_connections cc
  set endpoint_url = p_endpoint_url,
      auth_type = p_auth_type,
      auth_header_name = case when p_auth_type = 'header' then p_auth_header_name else null end,
      secret_ref = case when p_auth_type in ('bearer', 'header') then v_secret_ref else null end,
      allowed_hosts = p_allowed_hosts,
      timeout_ms = p_timeout_ms,
      enabled = true,
      updated_at = pg_catalog.now()
  where cc.id = v_connection.id
    and cc.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = '40001', message = 'capability_connection_update_raced';
  end if;

  if p_auth_type = 'oauth' and not p_preserve_credential then
    insert into public.capability_oauth_credentials (
      workspace_id, connection_id, attempt_id, secret_ref, issuer, resource,
      scopes, token_expires_at, status
    ) values (
      p_workspace_id, v_connection.id, v_attempt.id, v_attempt.secret_ref,
      v_attempt.issuer, v_attempt.resource, v_attempt.scopes,
      v_token_expires_at, 'active'
    );

    update public.capability_oauth_attempts a
    set status = 'connected', consumed_at = pg_catalog.now(),
        capability_id = p_capability_id, error_code = null,
        updated_at = pg_catalog.now()
    where a.id = v_attempt.id
      and a.workspace_id = p_workspace_id
      and a.status = 'authorized';
    if not found then
      raise exception using errcode = '40001', message = 'oauth_attempt_raced';
    end if;
  end if;

  update public.capabilities c
  set provider = p_provider,
      title = p_title,
      description = p_description,
      provenance = p_provenance,
      current_version_id = v_version_id,
      status = case when v_material_change then 'draft' else c.status end,
      disabled_at = case when v_material_change then null else c.disabled_at end,
      updated_at = pg_catalog.now()
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id
    and c.deleted_at is null;
  if not found then
    raise exception using errcode = '40001', message = 'capability_provider_update_raced';
  end if;

  return query select
    p_capability_id, v_version_id, v_connection.id,
    v_grants_revoked, v_material_change;
end;
$$;

revoke all on function public.update_capability_provider(
  uuid, uuid, uuid, timestamptz, text, text, text, jsonb, text, jsonb, text,
  text, text, text, text, text[], integer, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.update_capability_provider(
  uuid, uuid, uuid, timestamptz, text, text, text, jsonb, text, jsonb, text,
  text, text, text, text, text[], integer, boolean, uuid
) to service_role;

create or replace function public.remove_capability_provider(
  p_workspace_id uuid,
  p_user_id uuid,
  p_capability_id uuid,
  p_expected_updated_at timestamptz default null
)
returns table (
  capability_id uuid,
  grants_revoked integer,
  already_removed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capability public.capabilities%rowtype;
  v_grants_revoked integer := 0;
begin
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'capability_admin_required';
  end if;

  select c.* into v_capability
  from public.capabilities c
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'capability_provider_not_found';
  end if;
  if v_capability.deleted_at is not null then
    return query select p_capability_id, 0, true;
    return;
  end if;
  if v_capability.type not in ('mcp_server', 'api', 'workflow') then
    raise exception using errcode = '22023', message = 'capability_provider_not_executable';
  end if;
  if p_expected_updated_at is not null
     and v_capability.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'capability_provider_stale';
  end if;

  if exists (
    select 1
    from public.capability_bundle_items bi
    join public.capability_versions cv
      on cv.id = bi.capability_version_id
     and cv.workspace_id = bi.workspace_id
    join public.capability_bundle_versions bv
      on bv.id = bi.bundle_version_id
     and bv.workspace_id = bi.workspace_id
    join public.capability_bundles b
      on b.id = bv.bundle_id
     and b.workspace_id = bv.workspace_id
     and b.current_version_id = bv.id
    where cv.capability_id = p_capability_id
      and cv.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '55000', message = 'capability_provider_used_by_bundle';
  end if;

  with revoked as (
    update public.capability_grants g
    set revoked_at = pg_catalog.now()
    where g.workspace_id = p_workspace_id
      and g.capability_id = p_capability_id
      and g.revoked_at is null
    returning 1
  )
  select pg_catalog.count(*)::integer into v_grants_revoked from revoked;

  -- Deleting the connection cascades its OAuth credential. The 0034 trigger
  -- removes the encrypted Vault bundle before the provider is tombstoned.
  delete from public.capability_connections cc
  where cc.workspace_id = p_workspace_id
    and cc.capability_id = p_capability_id;

  -- Connected attempts are historical plumbing, not invocation history. Once
  -- their credential is gone they can be removed and their shared Vault ref
  -- cleanup is harmlessly idempotent.
  delete from public.capability_oauth_attempts a
  where a.workspace_id = p_workspace_id
    and a.capability_id = p_capability_id;

  update public.capabilities c
  set status = 'disabled',
      disabled_at = pg_catalog.now(),
      deleted_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where c.id = p_capability_id
    and c.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = '40001', message = 'capability_provider_remove_raced';
  end if;

  return query select p_capability_id, v_grants_revoked, false;
end;
$$;

revoke all on function public.remove_capability_provider(
  uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.remove_capability_provider(
  uuid, uuid, uuid, timestamptz
) to service_role;

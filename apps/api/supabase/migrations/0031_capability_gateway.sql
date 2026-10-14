-- 0031_capability_gateway.sql
--
-- CAP-01..04 — versioned capability catalog, principals/grants/bundles and
-- the execution ledger used by the external MCP/webhook gateway.
--
-- Boundaries are intentional:
--   * capability metadata and immutable contracts live in separate tables;
--   * connections contain an env-var reference, never secret material;
--   * invocations contain operational metadata, never request/response bodies;
--   * external providers continue to execute every action.

create table capability_principals (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('user','agent','team','service_account')),
  source_type text not null check (source_type in ('user','agent_token','team','service_account')),
  source_id text not null,
  display_name text not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_type, source_id),
  unique (id, workspace_id)
);

create table capabilities (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  type text not null check (type in (
    'mcp_server','api','workflow','skill','plugin','script_or_cli','agent'
  )),
  owner_user_id uuid references auth.users(id) on delete set null,
  provider text not null,
  title text not null,
  description text not null default '',
  provenance jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','approved','deprecated','disabled')),
  current_version_id uuid,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key),
  unique (id, workspace_id)
);

create table capability_versions (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  capability_id uuid not null,
  version integer not null check (version > 0),
  environment text not null default 'production',
  contract jsonb not null,
  contract_digest text not null,
  change_summary text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (capability_id, version),
  unique (capability_id, contract_digest),
  unique (id, workspace_id),
  unique (id, capability_id, workspace_id),
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade
);

alter table capabilities
  add constraint capabilities_current_version_fk
  foreign key (current_version_id, id, workspace_id)
  references capability_versions(id, capability_id, workspace_id)
  on delete restrict;

create table capability_connections (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  capability_id uuid not null,
  environment text not null default 'production',
  endpoint_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none','bearer','header')),
  auth_header_name text,
  secret_ref text check (
    secret_ref is null or secret_ref ~ '^BCONTEXT_CAP_[A-Z0-9_]{1,96}$'
  ),
  allowed_hosts text[] not null default '{}',
  timeout_ms integer not null default 15000 check (timeout_ms between 1000 and 55000),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (capability_id, environment),
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade,
  check (
    (auth_type = 'none' and secret_ref is null and auth_header_name is null)
    or (auth_type = 'bearer' and secret_ref is not null and auth_header_name is null)
    or (auth_type = 'header' and secret_ref is not null and auth_header_name is not null)
  )
);

create table capability_bundles (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  title text not null,
  description text not null default '',
  status text not null default 'draft'
    check (status in ('draft','approved','deprecated','disabled')),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key),
  unique (id, workspace_id)
);

create table capability_bundle_versions (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bundle_id uuid not null,
  version integer not null check (version > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (bundle_id, version),
  unique (id, workspace_id),
  unique (id, bundle_id, workspace_id),
  foreign key (bundle_id, workspace_id)
    references capability_bundles(id, workspace_id) on delete cascade
);

alter table capability_bundles
  add constraint capability_bundles_current_version_fk
  foreign key (current_version_id, id, workspace_id)
  references capability_bundle_versions(id, bundle_id, workspace_id)
  on delete restrict;

create table capability_bundle_items (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bundle_version_id uuid not null,
  capability_version_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (bundle_version_id, capability_version_id),
  foreign key (bundle_version_id, workspace_id)
    references capability_bundle_versions(id, workspace_id) on delete cascade,
  foreign key (capability_version_id, workspace_id)
    references capability_versions(id, workspace_id) on delete restrict
);

create table capability_grants (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  principal_id uuid not null,
  capability_id uuid,
  bundle_id uuid,
  actions text[] not null default array['discover','invoke']::text[],
  constraints jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(capability_id, bundle_id) = 1),
  check (actions <@ array['discover','invoke','admin']::text[]),
  foreign key (principal_id, workspace_id)
    references capability_principals(id, workspace_id) on delete cascade,
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade,
  foreign key (bundle_id, workspace_id)
    references capability_bundles(id, workspace_id) on delete cascade
);

create table capability_runtime_state (
  capability_id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  consecutive_failures integer not null default 0,
  circuit_open_until timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade
);

create table capability_rate_buckets (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  principal_id uuid not null,
  capability_id uuid not null,
  tokens numeric not null,
  last_refill_at timestamptz not null default now(),
  primary key (workspace_id, principal_id, capability_id),
  foreign key (principal_id, workspace_id)
    references capability_principals(id, workspace_id) on delete cascade,
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade
);

create or replace function consume_capability_rate_limit(
  p_workspace_id uuid,
  p_principal_id uuid,
  p_capability_id uuid,
  p_capacity integer default 20,
  p_refill_per_second numeric default 0.25
)
returns table (
  allowed boolean,
  retry_after_sec integer,
  remaining integer,
  capacity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket capability_rate_buckets%rowtype;
  v_available numeric;
begin
  if p_capacity < 1 or p_refill_per_second <= 0 then
    raise exception 'invalid capability rate-limit configuration';
  end if;

  insert into capability_rate_buckets (
    workspace_id, principal_id, capability_id, tokens, last_refill_at
  ) values (
    p_workspace_id, p_principal_id, p_capability_id, p_capacity, now()
  ) on conflict do nothing;

  select * into v_bucket
  from capability_rate_buckets
  where workspace_id = p_workspace_id
    and principal_id = p_principal_id
    and capability_id = p_capability_id
  for update;

  v_available := least(
    p_capacity::numeric,
    v_bucket.tokens + extract(epoch from (now() - v_bucket.last_refill_at)) * p_refill_per_second
  );

  if v_available < 1 then
    update capability_rate_buckets
    set tokens = v_available, last_refill_at = now()
    where workspace_id = p_workspace_id
      and principal_id = p_principal_id
      and capability_id = p_capability_id;
    return query select
      false,
      greatest(1, ceil((1 - v_available) / p_refill_per_second)::integer),
      0,
      p_capacity;
    return;
  end if;

  update capability_rate_buckets
  set tokens = v_available - 1, last_refill_at = now()
  where workspace_id = p_workspace_id
    and principal_id = p_principal_id
    and capability_id = p_capability_id;
  return query select true, 0, floor(v_available - 1)::integer, p_capacity;
end;
$$;

revoke all on function consume_capability_rate_limit(uuid, uuid, uuid, integer, numeric)
  from public, anon, authenticated;
grant execute on function consume_capability_rate_limit(uuid, uuid, uuid, integer, numeric)
  to service_role;

create table capability_invocations (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  capability_id uuid not null,
  capability_version_id uuid,
  principal_id uuid,
  agent_token_id uuid,
  tool_name text not null,
  "authorization" text not null check ("authorization" in ('allowed','denied')),
  status text not null check (status in ('started','succeeded','failed','timed_out','cancelled')),
  duration_ms integer,
  cost_microunits bigint,
  error_code text,
  idempotency_key_hash text,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade,
  foreign key (capability_version_id, capability_id, workspace_id)
    references capability_versions(id, capability_id, workspace_id) on delete restrict,
  foreign key (principal_id, workspace_id)
    references capability_principals(id, workspace_id) on delete restrict
);

create index capability_principals_lookup_idx
  on capability_principals(workspace_id, source_type, source_id)
  where disabled_at is null;
create index capabilities_workspace_status_idx
  on capabilities(workspace_id, status);
create index capability_versions_capability_idx
  on capability_versions(capability_id, version desc);
create index capability_grants_principal_idx
  on capability_grants(principal_id)
  where revoked_at is null;
create index capability_invocations_workspace_created_idx
  on capability_invocations(workspace_id, created_at desc);
create index capability_invocations_capability_created_idx
  on capability_invocations(capability_id, created_at desc);

create trigger capability_principals_updated before update on capability_principals
for each row execute function set_updated_at();
create trigger capabilities_updated before update on capabilities
for each row execute function set_updated_at();
create trigger capability_connections_updated before update on capability_connections
for each row execute function set_updated_at();
create trigger capability_bundles_updated before update on capability_bundles
for each row execute function set_updated_at();

-- Every catalog table is tenant isolated. Reads are available to workspace
-- members; catalog/grant mutation is owner/admin only. Runtime state and the
-- invocation ledger are written exclusively through the service-role client.
alter table capability_principals enable row level security;
alter table capabilities enable row level security;
alter table capability_versions enable row level security;
alter table capability_connections enable row level security;
alter table capability_bundles enable row level security;
alter table capability_bundle_versions enable row level security;
alter table capability_bundle_items enable row level security;
alter table capability_grants enable row level security;
alter table capability_runtime_state enable row level security;
alter table capability_rate_buckets enable row level security;
alter table capability_invocations enable row level security;

create policy capabilities_member_read on capabilities
  for select using (is_workspace_member(workspace_id));
create policy capability_versions_member_read on capability_versions
  for select using (is_workspace_member(workspace_id));
create policy capability_bundles_member_read on capability_bundles
  for select using (is_workspace_member(workspace_id));
create policy capability_bundle_versions_member_read on capability_bundle_versions
  for select using (is_workspace_member(workspace_id));
create policy capability_invocations_member_read on capability_invocations
  for select using (is_workspace_member(workspace_id));

create policy capability_principals_admin_all on capability_principals
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));
create policy capabilities_admin_write on capabilities
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));
create policy capability_versions_admin_insert on capability_versions
  for insert with check (is_workspace_admin(workspace_id));
create policy capability_connections_admin_all on capability_connections
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));
create policy capability_bundles_admin_write on capability_bundles
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));
create policy capability_bundle_versions_admin_insert on capability_bundle_versions
  for insert with check (is_workspace_admin(workspace_id));
create policy capability_grants_admin_all on capability_grants
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- Item policies derive tenant identity through the immutable parent rows.
create policy capability_bundle_items_member_read on capability_bundle_items
  for select using (exists (
    select 1 from capability_bundle_versions bv
    where bv.id = bundle_version_id and is_workspace_member(bv.workspace_id)
  ));
create policy capability_bundle_items_admin_insert on capability_bundle_items
  for insert with check (exists (
    select 1 from capability_bundle_versions bv
    where bv.id = bundle_version_id and is_workspace_admin(bv.workspace_id)
  ));

-- Connections deliberately have no member-read policy: endpoint/auth
-- metadata is admin-only even though secret values never enter this table.
-- runtime_state, rate_buckets and invocation INSERTs have no RLS write policy either.

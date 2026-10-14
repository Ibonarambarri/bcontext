-- 0032_agent_connections.sql
--
-- Durable identities for MCP/CLI agents. Credentials remain in the existing
-- token tables; agent_workspace_access is the explicit tenant boundary.

create table agents (
  id uuid primary key default uuid_generate_v4(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  provider text not null check (provider in (
    'codex','claude_code','hermes','openclaw','other'
  )),
  provider_label text,
  description text not null default '',
  status text not null default 'active'
    check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table agent_workspace_access (
  agent_id uuid not null references agents(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role text not null check (role in (
    'observer','collaborator','operator','custom'
  )),
  scopes text[] not null default '{}',
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (agent_id, workspace_id),
  check (scopes <@ array[
    'nodes:read','nodes:write','chat:run','skills:execute',
    'agents:read','agents:write','admin:*'
  ]::text[])
);

create index agents_owner_status_idx on agents(owner_user_id, status);
create index agent_workspace_access_workspace_idx
  on agent_workspace_access(workspace_id, agent_id)
  where revoked_at is null;

create trigger agents_updated before update on agents
for each row execute function set_updated_at();

alter table oauth_authorization_codes
  add column if not exists agent_id uuid references agents(id) on delete set null;
alter table oauth_access_tokens
  add column if not exists agent_id uuid references agents(id) on delete set null;
alter table api_tokens
  add column if not exists agent_id uuid references agents(id) on delete set null;
alter table user_api_tokens
  add column if not exists agent_id uuid references agents(id) on delete set null;

create index oauth_access_tokens_agent_idx on oauth_access_tokens(agent_id)
  where agent_id is not null and revoked_at is null;
create index api_tokens_agent_idx on api_tokens(agent_id)
  where agent_id is not null and revoked_at is null;
create index user_api_tokens_agent_idx on user_api_tokens(agent_id)
  where agent_id is not null and revoked_at is null;

-- Existing workspace tokens become first-class agents without changing their
-- plaintext credentials or authorization behavior.
insert into agents (
  id, owner_user_id, name, provider, provider_label, created_at, last_seen_at
)
select
  t.id, t.created_by, t.name, 'other', 'Legacy token', t.created_at, t.last_used_at
from api_tokens t
where t.created_by is not null
on conflict (id) do nothing;

update api_tokens set agent_id = id
where agent_id is null and created_by is not null;

insert into agent_workspace_access (
  agent_id, workspace_id, role, scopes, approved_by, approved_at, revoked_at
)
select
  t.id,
  t.workspace_id,
  case
    when 'chat:run' = any(t.scopes) then 'operator'
    when 'nodes:write' = any(t.scopes) or 'agents:write' = any(t.scopes) then 'collaborator'
    else 'observer'
  end,
  t.scopes,
  t.created_by,
  t.created_at,
  t.revoked_at
from api_tokens t
where t.created_by is not null
on conflict (agent_id, workspace_id) do nothing;

-- Existing OAuth workspace sessions are also preserved as agent identities.
insert into agents (
  id, owner_user_id, name, provider, provider_label, created_at, last_seen_at
)
select
  t.id,
  t.user_id,
  coalesce(c.client_name, 'OAuth agent'),
  'other',
  'OAuth',
  t.created_at,
  t.last_used_at
from oauth_access_tokens t
left join oauth_clients c on c.client_id = t.client_id
on conflict (id) do nothing;

update oauth_access_tokens set agent_id = id where agent_id is null;

insert into agent_workspace_access (
  agent_id, workspace_id, role, scopes, approved_by, approved_at, revoked_at
)
select
  t.id,
  t.workspace_id,
  case
    when 'chat:run' = any(t.scopes) then 'operator'
    when 'nodes:write' = any(t.scopes) or 'agents:write' = any(t.scopes) then 'collaborator'
    else 'observer'
  end,
  t.scopes,
  t.user_id,
  t.created_at,
  t.revoked_at
from oauth_access_tokens t
on conflict (agent_id, workspace_id) do nothing;

-- Legacy user tokens previously meant every membership. Snapshot the current
-- memberships now; future workspaces are never granted implicitly.
insert into agents (
  id, owner_user_id, name, provider, provider_label, created_at, last_seen_at
)
select
  t.id, t.user_id, t.name, 'other', 'Legacy user token', t.created_at, t.last_used_at
from user_api_tokens t
on conflict (id) do nothing;

update user_api_tokens set agent_id = id where agent_id is null;

insert into agent_workspace_access (
  agent_id, workspace_id, role, scopes, approved_by, approved_at, revoked_at
)
select
  t.id,
  m.workspace_id,
  case
    when 'chat:run' = any(t.scopes) then 'operator'
    when 'nodes:write' = any(t.scopes) or 'agents:write' = any(t.scopes) then 'collaborator'
    else 'observer'
  end,
  t.scopes,
  t.user_id,
  t.created_at,
  t.revoked_at
from user_api_tokens t
join memberships m on m.user_id = t.user_id
on conflict (agent_id, workspace_id) do nothing;

-- Capability principals now bind to the durable agent id instead of a token
-- that can be rotated.
alter table capability_principals
  drop constraint if exists capability_principals_source_type_check;
alter table capability_principals
  add constraint capability_principals_source_type_check
  check (source_type in (
    'user','agent','agent_token','team','service_account'
  ));

-- Create the per-workspace principal for every migrated agent. Existing
-- gateway grants were keyed by token id; migrated agent ids intentionally
-- reuse that id, so active grants can move without changing semantics.
insert into capability_principals (
  workspace_id, kind, source_type, source_id, display_name
)
select
  awa.workspace_id,
  'agent',
  'agent',
  a.id::text,
  a.name
from agent_workspace_access awa
join agents a on a.id = awa.agent_id
where awa.revoked_at is null and a.status = 'active'
on conflict (workspace_id, source_type, source_id) do update
set display_name = excluded.display_name, disabled_at = null;

insert into capability_grants (
  workspace_id, principal_id, capability_id, bundle_id,
  actions, constraints, expires_at, created_by, created_at
)
select
  g.workspace_id,
  replacement.id,
  g.capability_id,
  g.bundle_id,
  g.actions,
  g.constraints,
  g.expires_at,
  g.created_by,
  g.created_at
from capability_grants g
join capability_principals legacy on legacy.id = g.principal_id
join agents a on a.id::text = legacy.source_id
join capability_principals replacement
  on replacement.workspace_id = legacy.workspace_id
  and replacement.source_type = 'agent'
  and replacement.source_id = a.id::text
where legacy.source_type = 'agent_token'
  and legacy.disabled_at is null
  and g.revoked_at is null;

update capability_principals legacy
set disabled_at = coalesce(legacy.disabled_at, now())
where legacy.source_type = 'agent_token'
  and exists (select 1 from agents a where a.id::text = legacy.source_id);

alter table agents enable row level security;
alter table agent_workspace_access enable row level security;

create policy agents_owner_all on agents
  for all using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create policy agent_access_owner_all on agent_workspace_access
  for all using (exists (
    select 1 from agents a
    where a.id = agent_id and a.owner_user_id = auth.uid()
  )) with check (exists (
    select 1 from agents a
    where a.id = agent_id and a.owner_user_id = auth.uid()
  ));

create policy agent_access_workspace_admin_all on agent_workspace_access
  for all using (is_workspace_admin(workspace_id))
  with check (is_workspace_admin(workspace_id));

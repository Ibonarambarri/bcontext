-- 0016: organization-level memberships + workspace invites
--
-- UX rename (no data change): in the UI an "organization" is now exposed
-- as a "Workspace", and the existing `workspaces` table becomes a
-- "Project" inside it. This migration adds the org-scoped membership
-- and invitation tables that power the new /workspaces section.

-- ============================================================
-- organization_memberships — role on the workspace (= organization)
-- ============================================================
create table if not exists organization_memberships (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','viewer')) default 'editor',
  created_at timestamptz default now(),
  unique (user_id, organization_id)
);

create index if not exists org_memberships_user_idx on organization_memberships(user_id);
create index if not exists org_memberships_org_idx on organization_memberships(organization_id);

-- Backfill from existing project-level memberships. For each
-- (user, organization) pair we pick the highest role across their
-- project memberships. `agent` memberships do not grant org access.
insert into organization_memberships (user_id, organization_id, role)
select
  m.user_id,
  w.organization_id,
  case
    when bool_or(m.role = 'owner')  then 'owner'
    when bool_or(m.role = 'admin')  then 'admin'
    when bool_or(m.role = 'editor') then 'editor'
    else 'viewer'
  end
from memberships m
join workspaces w on w.id = m.workspace_id
where m.role <> 'agent'
group by m.user_id, w.organization_id
on conflict (user_id, organization_id) do nothing;

-- ============================================================
-- workspace_invites — pending invitations to join a workspace (org)
-- ============================================================
create table if not exists workspace_invites (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner','admin','editor','viewer')) default 'editor',
  token text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists workspace_invites_org_idx on workspace_invites(organization_id);
create index if not exists workspace_invites_email_idx on workspace_invites(lower(email));
create index if not exists workspace_invites_token_idx on workspace_invites(token);

-- ============================================================
-- RLS
-- ============================================================
alter table organization_memberships enable row level security;
alter table workspace_invites        enable row level security;

-- Helper: is the current user a member of the organization?
-- Considers BOTH the new org_memberships table AND legacy project-level
-- memberships, so existing users keep access without a manual backfill.
create or replace function is_org_member(o uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from organization_memberships om
    where om.organization_id = o and om.user_id = auth.uid()
  ) or exists (
    select 1 from workspaces w
    join memberships m on m.workspace_id = w.id
    where w.organization_id = o and m.user_id = auth.uid()
  );
$$;

create or replace function is_org_admin(o uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from organization_memberships om
    where om.organization_id = o and om.user_id = auth.uid()
      and om.role in ('owner','admin')
  );
$$;

-- organization_memberships policies
create policy org_memberships_self_read on organization_memberships
  for select using (user_id = auth.uid());

create policy org_memberships_member_read on organization_memberships
  for select using (is_org_member(organization_id));

create policy org_memberships_admin_write on organization_memberships
  for all using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

-- workspace_invites: admins/owners only
create policy workspace_invites_admin_all on workspace_invites
  for all using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

-- Tighten organizations policies: members can read, admins can update.
drop policy if exists organizations_member_read on organizations;
create policy organizations_member_read on organizations
  for select using (is_org_member(id));

create policy organizations_admin_update on organizations
  for update using (is_org_admin(id))
  with check (is_org_admin(id));

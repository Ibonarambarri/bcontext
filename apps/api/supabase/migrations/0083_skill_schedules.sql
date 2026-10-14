-- 0083_skill_schedules.sql
--
-- NEXO proactivity: skills that run on a clock, per workspace. The first one
-- is built in — `digest_weekly` publishes a "Digest semanal <date>" doc node
-- with what changed, what was decided, what is blocked and what can start.
-- A `skill` row points at a skill node and runs it on its cron.
--
-- The worker's `skills.schedule` queue (every five minutes) enqueues the due
-- rows and advances `next_run_at` under a CAS; `skills.run-scheduled` runs
-- one. Nothing is seeded: a schedule exists because an admin enabled it
-- (`PUT /api/workspaces/:ws/digest`).
--
-- RLS mirrors saved_views: members read, workspace admins write. The worker
-- and the REST route go through the service-role client.

create table if not exists public.skill_schedules (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- null for built-ins (`digest_weekly`); a skill node for `kind = 'skill'`.
  skill_id uuid references public.nodes(id) on delete cascade,
  kind text not null check (kind in ('digest_weekly', 'skill')),
  cron text not null check (char_length(btrim(cron)) between 9 and 120),
  timezone text not null default 'UTC' check (char_length(btrim(timezone)) between 1 and 64),
  enabled boolean not null default true,
  -- { "webhook"?: boolean, "email"?: boolean }
  delivery jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skill_schedules_shape check (
    (kind = 'skill' and skill_id is not null)
    or (kind = 'digest_weekly' and skill_id is null)
  ),
  constraint skill_schedules_delivery_object check (jsonb_typeof(delivery) = 'object'),
  constraint skill_schedules_delivery_keys check (
    delivery - array['webhook', 'email']::text[] = '{}'::jsonb
  )
);

-- One row per built-in per workspace: enabling the digest twice edits the
-- same schedule instead of publishing two digests every Monday.
create unique index if not exists skill_schedules_builtin_unique
  on public.skill_schedules(workspace_id, kind)
  where skill_id is null;
create unique index if not exists skill_schedules_skill_unique
  on public.skill_schedules(workspace_id, skill_id)
  where skill_id is not null;
create index if not exists skill_schedules_due_idx
  on public.skill_schedules(next_run_at)
  where enabled;
create index if not exists skill_schedules_workspace_idx
  on public.skill_schedules(workspace_id);

drop trigger if exists skill_schedules_updated on public.skill_schedules;
create trigger skill_schedules_updated
before update on public.skill_schedules
for each row execute function public.set_updated_at();

alter table public.skill_schedules enable row level security;

drop policy if exists skill_schedules_member_read on public.skill_schedules;
create policy skill_schedules_member_read on public.skill_schedules
for select using (public.is_workspace_member(workspace_id));

drop policy if exists skill_schedules_admin_insert on public.skill_schedules;
create policy skill_schedules_admin_insert on public.skill_schedules
for insert with check (public.is_workspace_admin(workspace_id));

drop policy if exists skill_schedules_admin_update on public.skill_schedules;
create policy skill_schedules_admin_update on public.skill_schedules
for update using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists skill_schedules_admin_delete on public.skill_schedules;
create policy skill_schedules_admin_delete on public.skill_schedules
for delete using (public.is_workspace_admin(workspace_id));

comment on table public.skill_schedules is
  'Per-workspace clocks for skills. Built-ins (digest_weekly) carry no skill_id; the worker advances next_run_at under a CAS and runs one row per skills.run-scheduled job.';

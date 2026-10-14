-- 0046_capability_health_and_reviews.sql
--
-- CAP-02 hardening — health-check/schema-drift state on the runtime table,
-- and an explicit append-only review (approve/reject) trail for capability
-- status transitions.

alter table capability_runtime_state
  add column last_checked_at timestamptz,
  add column health_status text not null default 'unknown'
    check (health_status in ('unknown', 'healthy', 'unhealthy')),
  add column last_error text,
  add column schema_drift boolean not null default false,
  add column drift_detected_at timestamptz,
  add column drift_summary jsonb;

create table capability_reviews (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  capability_id uuid not null,
  version_id uuid,
  reviewer_user_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('approved', 'rejected')),
  comment text not null default '',
  created_at timestamptz not null default now(),
  foreign key (capability_id, workspace_id)
    references capabilities(id, workspace_id) on delete cascade
);

create index capability_reviews_capability_created_idx
  on capability_reviews(capability_id, created_at desc);

-- Reviews are an append-only decision trail: workspace members can read it
-- (same visibility as capability_versions), only admins can insert, and
-- nobody can update/delete — mirroring the immutability of capability_versions.
alter table capability_reviews enable row level security;

create policy capability_reviews_member_read on capability_reviews
  for select using (is_workspace_member(workspace_id));
create policy capability_reviews_admin_insert on capability_reviews
  for insert with check (is_workspace_admin(workspace_id));

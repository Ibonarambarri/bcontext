-- 0015_waitlist.sql
--
-- Public waitlist signups from the landing page form.
--
-- One row per unique email. `note` is the free-text pitch a visitor
-- writes in the waitlist modal — we use it to triage who gets early
-- beta seats first. RLS denies all reads/writes to anon + authenticated;
-- the only writer is the service role from /api/waitlist.

create table if not exists waitlist (
  id uuid primary key default uuid_generate_v4(),
  email text not null unique,
  note text,
  source text,
  referer text,
  user_agent text,
  utm jsonb,
  status text not null default 'new' check (
    status in ('new', 'reviewing', 'invited', 'rejected')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists waitlist_created_at_idx
  on waitlist (created_at desc);

create index if not exists waitlist_status_idx
  on waitlist (status, created_at desc);

alter table waitlist enable row level security;

-- No public policies. Service role bypasses RLS for the insert from
-- /api/waitlist; review happens via the Supabase dashboard (or a
-- future admin UI behind auth).

drop policy if exists waitlist_no_public on waitlist;
create policy waitlist_no_public on waitlist
  for select
  using (false);

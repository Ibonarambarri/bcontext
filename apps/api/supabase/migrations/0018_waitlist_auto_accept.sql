-- 0018_waitlist_auto_accept.sql
--
-- When an invited waitlist signup finishes creating their Supabase account,
-- flip the queue row to `accepted` automatically. The admin no longer
-- chooses a workspace for them — the invitation is just for sign-up, and
-- once the account exists they're considered onboarded.
--
-- Triggered on insert into auth.users. Matches on lower(email) so casing
-- differences between the queue row and the auth email don't desync the
-- state machine.

create or replace function waitlist_mark_accepted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null then
    return new;
  end if;
  update public.waitlist
     set status = 'accepted',
         updated_at = now()
   where lower(email) = lower(new.email)
     and status = 'invited';
  return new;
end;
$$;

drop trigger if exists waitlist_mark_accepted_on_signup on auth.users;
create trigger waitlist_mark_accepted_on_signup
  after insert on auth.users
  for each row execute function waitlist_mark_accepted();

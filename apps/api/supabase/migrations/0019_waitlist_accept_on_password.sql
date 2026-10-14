-- 0019_waitlist_accept_on_password.sql
--
-- Trigger v2: only flip waitlist row from `invited` to `accepted` when the
-- recipient actually completes signup by setting a password. The previous
-- AFTER INSERT trigger fired the moment Supabase created the half-built
-- auth.users row (the click on the invite link), well before the user
-- typed a password. Now we fire on UPDATE OF encrypted_password,
-- transitioning from NULL/'' to a real bcrypt hash.
--
-- Also adds the `waitlist_invite_user_state(email)` RPC used by
-- sendWaitlistInviteAction to decide whether to re-issue an invite or
-- fall back to magic-link.

drop trigger if exists waitlist_mark_accepted_on_signup on auth.users;
drop trigger if exists waitlist_mark_accepted_on_password on auth.users;
drop function if exists waitlist_mark_accepted();
drop function if exists waitlist_mark_accepted_on_password();

create or replace function waitlist_mark_accepted_on_password()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null then
    return new;
  end if;
  if (old.encrypted_password is null or old.encrypted_password = '')
     and new.encrypted_password is not null
     and new.encrypted_password <> '' then
    update public.waitlist
       set status = 'accepted',
           updated_at = now()
     where lower(email) = lower(new.email)
       and status = 'invited';
  end if;
  return new;
end;
$$;

create trigger waitlist_mark_accepted_on_password
  after update of encrypted_password on auth.users
  for each row execute function waitlist_mark_accepted_on_password();

create or replace function waitlist_invite_user_state(p_email text)
returns table (user_id uuid, state text)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return query
  select
    u.id,
    case
      when u.encrypted_password is not null and u.encrypted_password <> ''
        then 'confirmed'
      else 'pending'
    end as state
    from auth.users u
   where lower(u.email) = lower(p_email)
   limit 1;
end;
$$;

revoke all on function waitlist_invite_user_state(text) from public, anon, authenticated;
grant execute on function waitlist_invite_user_state(text) to service_role;

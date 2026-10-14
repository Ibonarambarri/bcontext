-- 0020_waitlist_signup_complete_flag.sql
--
-- The encrypted_password signal turned out to be unusable: Supabase Auth
-- writes a random bcrypt hash into encrypted_password the moment
-- inviteUserByEmail is called, *before* the recipient sets their own
-- password. The migration-0019 trigger fired immediately and the RPC
-- returned 'confirmed' before any real signup happened.
--
-- We switch to a custom flag at `raw_user_meta_data.signup_complete`
-- which is set by /auth/set-password's server action once the user has
-- actually picked a password. The trigger is no longer needed — the
-- action also flips the waitlist row directly.

drop trigger if exists waitlist_mark_accepted_on_password on auth.users;
drop function if exists waitlist_mark_accepted_on_password();

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
      when coalesce((u.raw_user_meta_data->>'signup_complete')::boolean, false)
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

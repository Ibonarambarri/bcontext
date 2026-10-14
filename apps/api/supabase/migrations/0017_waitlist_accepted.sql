-- 0017_waitlist_accepted.sql
--
-- Extends waitlist.status with `accepted`. The acceptance flow lives in
-- src/lib/workspaces/orgs.ts:acceptInvite — when an invited user lands
-- on /invite/<token>, signs in, and accepts, the waitlist row matching
-- their email is flipped from `invited` → `accepted`. The admin queue
-- then surfaces them as fully onboarded.

alter table waitlist
  drop constraint if exists waitlist_status_check;

alter table waitlist
  add constraint waitlist_status_check
  check (status in ('new', 'reviewing', 'invited', 'rejected', 'accepted'));

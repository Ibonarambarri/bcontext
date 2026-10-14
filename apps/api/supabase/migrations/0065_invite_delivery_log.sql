-- 0065 — what happened the last time someone asked us to email an invitation.
--
-- `delivery_state` (0063) already says pending / held / sent / failed, which is
-- enough to gate an agent but not enough for the admin panel: when a send
-- fails, the person deciding what to do next needs to know *when* it was tried
-- and *why* it failed, without a log dive. Two columns, both nullable — a row
-- that was never sent simply has neither.
--
-- Nothing backfills: an invitation created before this migration has no
-- delivery attempt to describe.

begin;

alter table public.workspace_invites
  add column if not exists delivery_at timestamptz,
  add column if not exists delivery_error text;

comment on column public.workspace_invites.delivery_at is
  'When the last delivery attempt for this invitation ran (admin-triggered).';
comment on column public.workspace_invites.delivery_error is
  'Provider error from the last failed attempt, null when it succeeded.';

commit;

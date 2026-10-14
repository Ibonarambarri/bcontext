-- Hub chat persistence (P10-01)
-- The chat_sessions / chat_messages tables have existed since 0001_init but
-- were never wired into the app (the hub chat was ephemeral). We now use them
-- as the backing store for per-workspace conversations.
--
-- This migration adds an `updated_at` to chat_sessions so the conversation
-- list can sort by most-recently-active, a trigger that bumps it whenever a
-- new message lands, and the listing index.

alter table chat_sessions
  add column if not exists updated_at timestamptz default now();

-- Backfill existing rows to their created_at so ordering is sane pre-trigger.
update chat_sessions set updated_at = created_at where updated_at is null;

-- Bump the parent session's updated_at on every new message. SECURITY DEFINER
-- so it runs regardless of the writer's RLS context (writes go via service
-- role today, but this keeps it correct if that ever changes).
create or replace function bump_chat_session_updated_at()
returns trigger language plpgsql security definer as $$
begin
  update chat_sessions
    set updated_at = now()
    where id = new.session_id;
  return new;
end;
$$;

drop trigger if exists chat_messages_bump_session on chat_messages;
create trigger chat_messages_bump_session
  after insert on chat_messages
  for each row execute function bump_chat_session_updated_at();

-- List "my conversations in this workspace, most recent first".
create index if not exists chat_sessions_ws_user_idx
  on chat_sessions(workspace_id, user_id, updated_at desc);

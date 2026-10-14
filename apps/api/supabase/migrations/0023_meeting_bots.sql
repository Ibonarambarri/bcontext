-- 0023_meeting_bots.sql
--
-- Meeting bot connector (P5-06).
--
-- One row per scheduled bot. A row is created when a workspace member
-- (or agent) POSTs to /api/connectors/meeting-bot/schedule with a
-- Zoom/Meet/Teams/Webex URL. The provider (Recall.ai in v1, abstracted
-- behind MeetingBotProvider) drops a bot into the call and fires webhooks
-- as it joins, records, and produces the transcript.
--
-- The transcript itself is materialized as a regular `nodes` row of kind
-- `meeting`, linked back here via `transcript_node_id` so the dashboard
-- can show "this bot produced that meeting node". The embeddings pipeline
-- doesn't need to know about meeting_bots at all — it sees a new node
-- with a content body and indexes it like anything else.
--
-- Uniqueness: (provider, external_id) is the idempotency key the webhook
-- handler upserts against, so a re-delivered status_change / transcript
-- event never duplicates work.

create table if not exists meeting_bots (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  -- Provider abstraction. Only 'recall' is implemented in v1; future
  -- options will land as new MeetingBotProvider impls (meeting-baas,
  -- attendee) without schema changes.
  provider text not null check (provider in ('recall', 'meeting-baas', 'attendee')),

  -- Id of the bot in the provider's system (e.g. Recall's bot_id).
  -- Combined with provider, this is the idempotency key for webhooks.
  external_id text not null,

  -- Bot lifecycle. Mirrors Recall's status_change events:
  --   scheduled — row created, bot not yet in the call
  --   joining   — bot is dialing into the meeting
  --   in_call   — bot has joined and is recording
  --   call_ended — meeting ended, transcript being prepared
  --   transcribing — provider is finishing the transcript
  --   done      — transcript is available and the meeting node exists
  --   failed    — terminal failure (couldn't join, transcript errored, …)
  --   cancelled — user cancelled before/during the call
  status text not null check (
    status in (
      'scheduled', 'joining', 'in_call', 'call_ended',
      'transcribing', 'done', 'failed', 'cancelled'
    )
  ) default 'scheduled',

  meeting_url text not null,
  scheduled_join_at timestamptz,
  bot_joined_at timestamptz,
  call_ended_at timestamptz,

  -- Signed URL of the recording (kept short-lived per Recall semantics).
  -- We deliberately do NOT store the blob — see [[adr-meeting-bot-provider-recallai-for-v1]].
  recording_url text,

  -- Reference to the materialized `meeting` node, populated on
  -- transcript.done. Nullable because the node is created lazily.
  transcript_node_id uuid references nodes(id) on delete set null,

  error_message text,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- Idempotency: a webhook re-delivery upserts on this key.
  unique (provider, external_id)
);

create index if not exists meeting_bots_workspace_idx on meeting_bots(workspace_id);
create index if not exists meeting_bots_status_idx on meeting_bots(workspace_id, status);
create index if not exists meeting_bots_created_idx on meeting_bots(workspace_id, created_at desc);

-- Auto-update updated_at on row changes. Reuses the trigger function
-- defined in 0001_init.sql.
drop trigger if exists meeting_bots_updated on meeting_bots;
create trigger meeting_bots_updated before update on meeting_bots
for each row execute function set_updated_at();

alter table meeting_bots enable row level security;

-- Members can see their workspace's bots.
drop policy if exists meeting_bots_member_read on meeting_bots;
create policy meeting_bots_member_read on meeting_bots
  for select
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = meeting_bots.workspace_id
        and m.user_id = auth.uid()
    )
  );

-- Editors and above can schedule / cancel.
drop policy if exists meeting_bots_editor_write on meeting_bots;
create policy meeting_bots_editor_write on meeting_bots
  for all
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = meeting_bots.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin', 'editor', 'agent')
    )
  );

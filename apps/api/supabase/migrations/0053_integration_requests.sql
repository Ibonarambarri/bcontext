-- 0053_integration_requests.sql
--
-- Integrations surface redesign:
--   (1) "Ask for integration" — cross-workspace product-feedback requests
--       with name/domain dedupe and supporter votes.
--   (2) Let the meeting recorder persist its mandatory setup (objective +
--       accepted extraction items + forced instant cadence) in
--       connector_installs.config like every other connector: the
--       connector_id check learns 'meeting-bot'.
--   (3) New ai_usage_events surface for setup-time extraction proposals.
--
-- NOTE: this file ships with the PR but is NOT applied automatically.
-- Apply it on deploy; until then the API routes degrade gracefully
-- (empty request list / "migration pending" save errors).

-- ---------------------------------------------------------------------------
-- (2) connector_installs: allow the meeting recorder to own an install row.
alter table connector_installs
  drop constraint connector_installs_connector_id_check;
alter table connector_installs
  add constraint connector_installs_connector_id_check
  check (connector_id in ('github', 'slack', 'linear', 'notion', 'meeting-bot'));

-- ---------------------------------------------------------------------------
-- (1) Integration requests: product feedback, deliberately NOT workspace
-- scoped. Visibility is aggregate across all authenticated users (name,
-- URL, supporter count, motives); identities are never exposed by the API.
create table integration_requests (
  id uuid primary key default uuid_generate_v4(),
  name text not null check (char_length(name) between 1 and 120),
  -- Dedupe axes, computed server-side (src/lib/integrations/requests.ts):
  -- lowercase alphanumeric name + registrable URL domain.
  url text check (url is null or char_length(url) <= 500),
  domain text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index integration_requests_domain_idx
  on integration_requests(domain) where domain is not null;

-- One row per (request, user): a supporter either wrote a motive ("I'd use
-- GitHub for…") or just upvoted (reason null). The creator's motive is
-- their supporter row — counts and reasons come from this table only.
create table integration_request_supporters (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references integration_requests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text check (reason is null or char_length(reason) <= 2000),
  created_at timestamptz not null default now(),
  unique (request_id, user_id)
);

create index integration_request_supporters_request_idx
  on integration_request_supporters(request_id);

-- RLS: any authenticated user reads the aggregate; each user writes only
-- their own rows. The app routes use the service-role client after gate()
-- (repo pattern); these policies protect direct PostgREST access.
alter table integration_requests enable row level security;
alter table integration_request_supporters enable row level security;

create policy integration_requests_auth_read on integration_requests
  for select using (auth.uid() is not null);
create policy integration_requests_own_insert on integration_requests
  for insert with check (auth.uid() = created_by);

create policy integration_request_supporters_auth_read on integration_request_supporters
  for select using (auth.uid() is not null);
create policy integration_request_supporters_own_insert on integration_request_supporters
  for insert with check (auth.uid() = user_id);
create policy integration_request_supporters_own_update on integration_request_supporters
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy integration_request_supporters_own_delete on integration_request_supporters
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- (3) Meter setup-time extraction proposals like every other LLM call.
alter table ai_usage_events drop constraint ai_usage_events_surface_check;
alter table ai_usage_events add constraint ai_usage_events_surface_check
  check (surface in (
    'chat',
    'autofix',
    'skill_run',
    'meeting_refine',
    'ask_rag',
    'contextualize',
    'embed',
    'query_embed',
    'rerank',
    'ingest_extract',
    'integration_setup'
  ));

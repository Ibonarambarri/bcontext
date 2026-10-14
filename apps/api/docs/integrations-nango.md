# Integrations via Nango

Nango (self-hosted, free edition: **auth + proxy only**) is the layer that
owns OAuth / API-key flows and the authenticated HTTP transport for every
integration that is not native. Native connectors (GitHub App, Slack,
Linear, Notion, Meeting records) keep their own flows in
`src/lib/connectors/<id>`.

Nango is **not** part of the bundled `docker-compose.yml`: it needs its own
Postgres, Redis and two public origins (API and Connect UI) for OAuth
callbacks. Run it next to Bcontext with Nango's own self-hosting guide
(https://docs.nango.dev/guides/self-hosting/free-self-hosting/overview), then
set the variables below. Without them every Nango-backed integration answers
503 and the rest of the product works unchanged.

```
Integrations hub ──POST /api/connectors/:id/install──▶ Connect session (Nango)
      │                                                     │ user connects
      │                                     ◀── POST /api/webhooks/nango ──┘
      │  install.active + config.nango_connection_id
      ▼
connector.schedule (worker, every minute) → full_sync when config.next_run_at is due
      ▼
nango adapter.fetchChanges(since)  ──▶  Nango /proxy  ──▶ provider API
      ▼
batch extractor (few dense candidates, guided by config.ingest_guidance)
      ▼
NEXO triage: contradiction → conflict · confidence ≥ 0.7 → node · else → doubt conflict
```

## Environment

| Var | Where | What |
|---|---|---|
| `NANGO_SERVER_URL` | api + worker | Your Nango server, e.g. `https://nango.example.com` |
| `NANGO_SECRET_KEY` | api + worker | Environment secret key (Nango dashboard → Environment settings) |
| `NANGO_WEBHOOK_SECRET` | api | Webhook signing key (Environment settings → Webhooks) |
| `NANGO_PUBLIC_URL` | api | Only if the browser reaches Nango on another host |
| `NANGO_PUBLIC_HOST`, `NANGO_CONNECT_URL` | web | Nango's API and Connect UI as the browser reaches them (compose: `NANGO_PUBLIC_URL` and `NANGO_CONNECT_URL` in the root `.env`) |
| `NEXO_AUTO_ACCEPT_THRESHOLD` | api + worker | Default `0.7` |

Nango itself needs the webhook URL `https://<your domain>/api/webhooks/nango`
(Environment settings → Webhooks).

## Adding a provider

Adapters live one per file so that batches of providers can be built in
parallel: the only shared file is `src/lib/connectors/nango/adapters/index.ts`,
and a provider is one import + one entry there (alphabetical).

1. **Catalog entry** — `src/lib/connectors/catalog.ts`: flip the `soon(...)`
   draft to `nango({ ..., status: "available" })` (or add one). `key` is the
   connector_id, `nango_provider` a key in Nango's `providers.yaml`, `auth`
   the entry's auth mode (`oauth2` for OAUTH2/OAUTH1 providers and for the
   `google-*` / `microsoft-*` / `sharepoint-online` aliases; `api_key`,
   `basic` otherwise). Keep the popularity rank.
2. **Adapter** — `src/lib/connectors/nango/adapters/<key>.ts`: export
   `<key>Adapter: NangoAdapter` with `id` = the catalog key, `provider` =
   the Nango provider, and `fetchChanges({ client, connectionId,
   connectionConfig, config, since, limit })` calling the provider through
   `client.proxy(...)` and returning `IngestSignal[]` ("what changed since
   `since`", paginated, capped by `limit`, stable `external_id`s). Helpers in
   `./shared.ts`. Add a test next to it with the fake proxy client from
   `adapters.test.ts`, then one line in `adapters/index.ts`.
3. **Nango integration** — `npm run nango:sync` (env `NANGO_SERVER_URL`,
   `NANGO_SECRET_KEY`; `-- --dry-run` to preview) creates whatever is
   missing: `unique_key` **equals the catalog key** (`jira`, not
   `jira-basic`), `provider` = `nango_provider`. API_KEY / BASIC providers
   need nothing else — end users type their token in the Connect UI. OAuth
   providers are created with **placeholder client credentials**
   (`pending-owner-setup`) so the catalog and Connect flow ship first.

### Registering an OAuth app (instance admin)

Until the real OAuth app exists, the marketplace shows the entry as
"needs admin setup" (`setup: "needs_oauth_app"` on
`GET /api/integrations/catalog`, read back from Nango and cached 60 s).
To finish one:

1. Register the OAuth app at the provider with the callback
   `https://<your nango host>/oauth/callback`.
2. Nango dashboard → Integrations → the integration → Settings: replace
   client id / secret (and scopes if needed). `nango:sync` never overwrites
   an existing integration, so the real credentials stay.
3. The catalog flips to `setup: "ready"` within a minute; no deploy needed.

## Bring your own OAuth app (hybrid)

Nango keeps OAuth client credentials **per integration**, so there are two
ways an OAuth provider connects:

- **The instance's shared app** — the integration `<key>` in Nango holds real
  client credentials (registered as above). Workspace members only authorise.
  `setup: "ready"` on the catalog.
- **The workspace's own app** — when there is no shared app
  (`setup: "needs_oauth_app"`) or the workspace prefers it, a workspace admin
  creates an OAuth app in the provider's console, registers the callback
  `https://<your nango host>/oauth/callback`, allows the scopes the catalog
  lists in `oauth_setup.scopes`, and pastes client id + secret in the connect
  modal. Bcontext creates (or replaces) a per-workspace integration in Nango,
  `unique_key = <key>--<workspace uuid without dashes>`, same `provider`, and
  binds the Connect session to it. The secret goes to Nango once and is never
  stored, logged or read back by bcontext-api.

Where it lives in code:

- `src/lib/nango/scopes.ts` — default scopes, auth mode (OAuth1 / client
  credentials), developer console per provider, and the `oauth_setup` block
  every OAuth catalog entry carries. `scripts/nango-sync-integrations.ts`
  reads the same map.
- `src/lib/nango/own-app.ts` — key format, create-or-replace, delete, and
  `withIntegrationKey`, the client wrapper that rewrites the
  `providerConfigKey` adapters hard-code. Adapters never change.
- Install config: `nango_integration_key` (the unique_key in use; missing on
  older installs → the shared `<key>`) and `oauth_app: "shared" | "own"`.
- Routes: `POST /api/connectors/:id/install` accepts `oauth_app: { client_id,
  client_secret, scopes? }` and answers `409 { error: "needs_oauth_app",
  oauth_setup }` when neither app exists; `PUT /api/connectors/:id/oauth-app`
  replaces the own credentials, `DELETE` switches back to the shared app
  (409 `needs_oauth_app` when there is none). Both leave the install
  `pending` (`reconnect_required: true`): the person reconnects through the
  Connect UI. Uninstall deletes the own integration. The Nango auth webhook
  resolves `<key>--<ws>` back to the connector and checks the workspace suffix.

Why hybrid: a Google Workspace "internal" app or an Entra app registration
needs no provider review, so a workspace can be live the same day, while the
shared app removes the console step for everyone else once the instance admin
registers the handful that unlock most of the catalog (Google, Microsoft,
Atlassian, HubSpot).

## Available providers

| key | Nango provider | auth | what it reads | install config |
|---|---|---|---|---|
| `jira` | `jira-basic` | basic | issues updated (+ last comments) | `projects` |
| `confluence` | `confluence-basic` | basic | pages modified | `spaces` |
| `airtable` | `airtable-pat` | api_key | records modified | `bases`, `tables` |
| `freshdesk` | `freshdesk` | basic | tickets updated | — |
| `google-drive` | `google-drive` | oauth2 | files modified; Docs/Sheets/Slides exported as text | `folder_ids` |
| `gmail` | `google-mail` | oauth2 | messages received (inbox minus promotions/social, or labels) | `labels` |
| `google-calendar` | `google-calendar` | oauth2 | events updated with a description or attendees | `calendar_ids` |
| `google-docs` | `google-docs` | oauth2 | pinned documents, by revision (prefer Drive for folders) | `document_ids` |
| `asana` | `asana` | oauth2 | tasks modified per project + project status updates | `workspace_gid`, `projects` |
| `clickup` | `clickup` | oauth2 | tasks updated per team, closed included | `team_ids` |
| `hubspot` | `hubspot` | oauth2 | deals, notes, calls, meetings modified | `portal_id` (links only) |
| `zendesk` | `zendesk-api-key` | basic | incremental tickets; solved ones with comments | — |
| `gitlab` | `gitlab-pat` | api_key | merge requests + issues updated | `projects` |
| `sentry` | `sentry` | api_key | issues seen, regressions flagged | `organization`, `projects` |
| `microsoft-teams` | `microsoft-teams` | oauth2 | channel messages modified (+ replies) per joined team | `teams`, `channels` |
| `outlook` | `outlook` | oauth2 | mail received per folder, text bodies | `folders` |
| `onedrive` | `one-drive` | oauth2 | recent files or folder children modified; text files read in full | `folder_ids` |
| `sharepoint` | `sharepoint-online` | oauth2 | documents + site pages modified per site | `site_ids` |
| `trello` | `trello` | oauth2 (OAuth1 at Nango) | board actions since, grouped per card (+ description) | `boards` |
| `bitbucket` | `bitbucket` | oauth2 | pull requests updated per workspace (+ last comments) | `workspace`, `repos` |
| `figma` | `figma` | oauth2 | files modified + new comments in team projects or pinned files | `team_id`, `file_keys` |
| `pagerduty` | `pagerduty` | oauth2 | incidents whose status changed, with notes and timeline | `service_ids` |
| `posthog` | `posthog` | api_key | annotations, saved insights, feature flags changed | `project_ids` |
| `stripe` | `stripe-api-key` | basic | business events (subscriptions, invoices, disputes, pricing), no card data | `event_types` |
| `zoom` | `zoom` | oauth2 | AI Companion summaries + cloud-recording transcripts (VTT via `Base-Url-Override`) | — |
| `google-meet` | `google-meet` | oauth2 | conference transcripts by speaker (Meet REST v2) | — |
| `google-sheets` | `google-sheet` | oauth2 | every tab of pinned spreadsheets, re-read each run | `spreadsheet_ids` |
| `pipedrive` | `pipedrive` | oauth2 | deals, notes and activities updated | `pipelines` |
| `attio` | `attio` | oauth2 | records changed (last `active_from`) + notes | `objects` |
| `todoist` | `todoist` | oauth2 | tasks created + completed, with comments | `projects` |
| `coda` | `coda` | api_key | docs/pages edited (names + links; bodies need export) | `doc_ids` |
| `miro` | `miro` | oauth2 | boards modified: sticky notes, text, cards as one signal | `boards` |
| `dropbox` | `dropbox` | oauth2 | files modified under folders (metadata + link, no content) | `folders` |
| `box` | `box` | oauth2 | files updated under folders, with comments | `folders` |
| `mixpanel` | `mixpanel` | basic | annotations + saved reports modified with a numbers snapshot | `project_id` (required) |
| `amplitude` | `amplitude` | basic | annotations + pinned chart snapshots | `chart_ids` |
| `snowflake` | `snowflake` | oauth2 | named SQL queries (`{{since}}` interpolated), ≤200 rows each | `queries` (required), `warehouse`, `database`, `schema`, `role` |
| `bigquery` | `google-bigquery` | oauth2 | named SQL queries against a project, ≤200 rows each | `project_id`, `queries` (required) |
| `supabase` | `supabase` | api_key | rows updated per named table via PostgREST | `tables` (required; `name`, `updated_at_column`, `select`) |
| `typeform` | `typeform` | oauth2 | completed responses after `since`, answers labelled by question | `form_ids` |
| `jotform` | `jotform` | api_key | submissions created after `since` (account timezone), answers labelled | `form_ids` |
| `tally` | `tally` | api_key | completed submissions newest first until the cursor | `form_ids` |
| `smartsheet` | `smartsheet` | oauth2 | rows modified since + new discussion comments per sheet | `sheet_ids` |
| `basecamp` | `basecamp` | oauth2 | messages, to-dos, documents, comments updated across projects | `projects` |
| `github-pat` | `github-pat` | api_key | issues + pull requests updated (+ last comments), token-based | `repos` |
| `datadog` | `datadog` | api_key | incidents modified (+ timeline), monitors modified, events in window | `monitor_tags` |
| `grafana` | `grafana` | api_key | annotations, dashboards changed (read per uid), alerts firing | `dashboard_uids` |
| `vercel` | `vercel` | api_key | failed + production deployments, one signal per project | `team_id`, `projects` |
| `cloudflare` | `cloudflare` | api_key | account audit log grouped per actor + action | `account_id` |
| `zapier` | `zapier` | oauth2 | Zaps edited/paused + failed runs (Partner API v2; scopes `zap:all`, `zap:runs`) | `statuses` |
| `make` | `make` | api_key | scenarios edited + errored runs with module/message | `team_id`, `scenarios` |
| `n8n` | `n8n` | api_key | workflows edited + errored executions with failing node | `workflows`, `active_only` |
| `docusign` | `docusign` | oauth2 | envelopes completed/declined/voided/sent with signers | `account_id` (required), `statuses`, `base_path` |
| `pandadoc` | `pandadoc-api-key` | api_key | documents modified with recipients, total, fields | `statuses`, `details_limit` |
| `quickbooks` | `quickbooks` | oauth2 | invoices, estimates, bills, payments updated (amounts rounded) | `realm_id` (fallback), `entities` |
| `xero` | `xero` | oauth2 | invoices, bills, quotes, contacts modified per tenant | `tenant_id`, `resources` |
| `shopify` | `shopify-api-key` | api_key | orders, products, customers updated (no contact data) | `resources` |
| `webflow` | `webflow` | oauth2 | CMS items + pages edited per site | `site_ids` |
| `contentful` | `contentful` | oauth2 | entries updated in a space/environment, fields flattened | `space_id`, `environment`, `content_types` |
| `mailchimp` | `mailchimp` | oauth2 | campaigns sent (subject, audience, open/click results) + automations created | — |
| `greenhouse` | `greenhouse-harvest` | basic | jobs updated + per-job pipeline summary (stages, hires, rejections, scorecards); no candidate data | `jobs` |
| `workable` | `workable` | api_key | jobs updated + per-job pipeline summary (stages, disqualifications); no candidate data | `jobs` |
| `bamboohr` | `bamboohr-basic` | basic | role/department/location changes per employee ref + approved time-off summary; no contact data | — |
| `personio` | `personio` | oauth2 (client credentials per connection) | position/department/office changes per employee ref + time-off summary; no contact data | — |
| `front` | `front-api-key` | api_key | conversations updated (search `updated_after:`) + last messages and internal comments | `inbox_ids` |
| `gorgias` | `gorgias-basic` | basic | tickets by `updated_datetime` desc until the cursor + last messages | `channels` |
| `helpscout` | `helpscout-mailbox` | oauth2 | conversations `modifiedSince` with embedded threads, per mailbox | `mailbox_ids` |
| `whatsapp` | `whatsapp-business` | api_key | phone numbers + message templates (no message history over GET; webhook path pending) | `waba_id` (required) |
| `linkedin` | `linkedin` | oauth2 | organisation posts by last modified + latest comments (Community Management API) | `organization_id` (required) |
| `youtube` | `youtube` | oauth2 | videos published on the channel + newest comments | `channel_id` |
| `canva` | `canva` | oauth2 | designs modified (metadata + view link; no comments API) | — |
| `chorus` | `chorus` | api_key | meetings processed, with summary, action items and transcript | — |
| `lattice` | `lattice` | api_key | goals updated (+ latest status comment), review cycles moved | `states` |
| `workday` | `workday` | basic | org snapshot per supervisory organisation via the REST root (no diff) | `organizations` |
| `servicenow` | `servicenow` | oauth2 | incidents, change requests, published KB articles updated (work notes, close notes) | `tables` |
| `zoho-crm` | `zoho-crm` | oauth2 | deals, notes, tasks modified (regional API host from `extension`) | `modules` |
| `wrike` | `wrike` | oauth2 | tasks updated (+ comments for the first 20) | `folders` |
| `google-tasks` | `google-tasks` | oauth2 | tasks added/edited/completed per list | `list_ids` |
| `google-forms` | `google-forms` | oauth2 | responses submitted as question/answer lines (`form_ids` required; discovery via google-drive) | `form_ids` |
| `google-slides` | `google-slides` | oauth2 | pinned decks re-read each run, slide text + speaker notes | `presentation_ids` |
| `microsoft-planner` | `microsoft-planner` | oauth2 | tasks created/completed per plan with bucket, checklist, description | `plan_ids` |
| `microsoft-word` | `microsoft-word` | oauth2 | `.docx` modified since, downloaded (≤ 2 MB) and read in-process | `folder_ids` |
| `microsoft-excel` | `microsoft-excel` | oauth2 | `.xlsx` modified since, first 3 sheets × 200 rows via the workbook API | `folder_ids` |
| `microsoft-power-bi` | `microsoft-power-bi` | oauth2 | report/dashboard inventory + dataset refresh failures since | `workspace_ids` |
| `deel` | `deel` | oauth2 | contracts created/changed + headcount snapshot per team (no rates, no PII) | `teams` |
| `gusto` | `gusto` | oauth2 | org snapshot per department + processed payroll totals (company-level) | `company_id` |
| `rippling` | `rippling` | api_key | org snapshot per department + leave requests aggregated by type | `departments` |
| `ramp` | `ramp` | oauth2 | spend per department/merchant, reimbursements, large transactions with memo | `departments`, `large_threshold` |
| `brex` | `brex` | oauth2 | card expenses per department/merchant, receipt status, large expenses with memo | `departments`, `large_threshold` |
| `slack-nango` | `slack` | oauth2 | channel history per thread / per day (twin of native `slack`) | `channels` |
| `github-nango` | `github` | oauth2 | issues + pull requests updated, with comments (twin of native `github`) | `repos` |
| `linear-nango` | `linear` | oauth2 | issues updated + project updates (twin of native `linear`) | `teams` |
| `notion-nango` | `notion` | oauth2 | pages edited, body flattened (twin of native `notion`) | `database_ids` |
| `meeting-records-nango` | `recall-ai` | api_key | finished meetings of your own Recall.ai account, with transcript (twin of native `meeting-bot`) | — |
| `google-chat` | `google-chat` | oauth2 | space messages since, per thread / per day (named spaces only; no DMs) | `spaces`, `space_types` |
| `google-analytics` | `google-analytics` | oauth2 | GA4 traffic snapshot per property (totals, top pages, channels; Data + Admin APIs via `Base-Url-Override`) + account change history | `property_ids` |
| `okta` | `okta-api-key` | api_key | System Log aggregated per day: joiners/leavers, group membership, app assignments — users never named | — |
| `vimeo` | `vimeo-basic` | basic | videos modified (newest first) + newest comments | — |
| `dropbox-sign` | `dropbox-sign` | oauth2 | signature requests whose latest event is after the cursor, per-signer status (names only) | — |
| `lever` | `lever` | oauth2 | postings updated + opportunities aggregated per posting (stages, archive reasons, origins; no PII) | `postings` |
| `ashby` | `ashby` | basic | jobs updated (RPC `job.list`) + applications per job by stage/status/source (no PII) | `jobs`, `job_statuses` |
| `hibob` | `hibob-service-user` | basic | org snapshot per department (headcount, titles, sites, managers, joiners) + who's out counts | `departments` |

OAuth2 rows ship with placeholder credentials until the instance admin registers the
OAuth app (see above); the marketplace shows them as "needs admin setup".

## Native products via Nango

The five products with native connectors (Slack, GitHub, Linear,
Notion, Meeting records) are also available as Nango-backed integrations,
keyed `<product>-nango` (`meeting-records-nango` for Meeting records). The two
flows are independent installs and a workspace may run either or both:

| | native (`slack`, `github`, `linear`, `notion`, `meeting-bot`) | via Nango (`*-nango`) |
|---|---|---|
| auth | the instance's own OAuth app / GitHub App / Recall key in env | the workspace's connection in Nango (Connect UI) |
| transport | webhooks + real-time (📌 decision capture, `/bcontext search`, GitHub App events, Linear two-way status, Recall bot scheduling) | cadence-driven polling through the Nango proxy, like every other Nango connector |
| what arrives | one signal per event, as it happens | "what changed since the cursor", folded by the batch extractor |
| catalog link | `alt_key` → the Nango twin | `alt_key` → the native entry |

The hub can use `alt_key` to offer the other flow on each card. Nothing about
existing native installs changes: their `connector_id` stays `slack`, `github`,
…, and their webhooks keep landing on `/api/webhooks/<provider>`.

Provider notes:
- `slack-nango` reads `conversations.history` for the channels in
  `config.channels` (ids or names; all readable channels when unset), folds
  threads via `conversations.replies`, groups loose messages per UTC day and
  links with permalinks from `auth.test`. Placeholder scopes:
  `channels:read,channels:history,groups:read,groups:history,users:read,chat:write`
  (`chat:write` is how a Nexo replies through the proxy).
- `github-nango` is `createGithubAdapter({ id: "github-nango", provider: "github" })`
  — the same reader as `github-pat`, OAuth token instead of PAT.
- `linear-nango` is one GraphQL document (`LINEAR_QUERY`): issues filtered on
  `updatedAt > since` (paged, ≤3 pages) and the first page of project updates.
- `notion-nango` uses `/v1/search` sorted by `last_edited_time` (or
  `/v1/databases/{id}/query` for `config.database_ids`) and reads bodies with
  `/v1/blocks/{id}/children`, `Notion-Version: 2022-06-28`.
- `meeting-records-nango` targets Recall's v1 Bot API (`/api/v1/bot/` with
  `join_at_after`); the transcript comes from the pre-signed
  `media_shortcuts.transcript.data.download_url` (fetched directly — the proxy
  would add an Authorization header a pre-signed URL rejects) with the legacy
  `/api/v1/bot/{id}/transcript/` as fallback. `connection_config.region`
  selects the Recall region host.

## Slack and Nexos

A Slack channel can be bound to a Nexo (`nexo_bindings`). Inbound messages
then reach it from both transports — the native Events API webhook
(`src/lib/nexos/triggers/slack-inbound.ts`) and the `slack-nango` drain
(`src/lib/nexos/triggers/nango-inbound.ts`) — and its replies go out with
`chat.postMessage` (`src/lib/nexos/outbound.ts`): bot token for native
installs, the Nango proxy for `slack-nango`.

- **One ingestion path per channel.** A channel owned by an active Nexo is
  ingested by that Nexo's window flush (one batch extraction per thread,
  after 10 min of silence); the native per-message `doc` node and the Nango
  batch for that channel are skipped. Unbound channels keep the
  per-message behaviour and the general Nexo listens to them without
  re-extracting. A paused Nexo hands its channels back to the legacy path.
  📌 decision capture and `:bcontext:` pins always go through.
- **Scopes.** Native: the OAuth request asks for `chat:write` (reply) and
  `chat:write.customize` (reply under the Nexo's name); the callback records
  the granted `scopes` and the `bot_user_id` (loop guard) on the install
  config. Nango: `chat:write` is in the default scopes. Add both scopes to
  your Slack app's *OAuth & Permissions* page (and `chat:write` to the shared
  Slack integration in Nango). An install consented without them can listen
  but not reply: a send fails with `missing_scope`, logged and audited, until
  Slack is reconnected.
- **Loop guard.** Messages from the instance's own bot (`bot_user_id`, or any bot on
  installs that never recorded it) are never routed to a Nexo.

## Install config keys

| Key | Written by | Meaning |
|---|---|---|
| `provider: "nango"` | install route | Nango-backed install |
| `nango_connection_id` | auth webhook | Connection id in Nango |
| `nango_connection_config` | auth webhook | `subdomain`, … copied from Nango |
| `ingest_guidance` | config route | What NEXO should learn from this integration |
| `cadence` / `next_run_at` | config route + scheduler | When the daily/weekly run fires |
| `last_cursor` | connector | Start of the next "since" window |
| `last_run_stats` | connector | `{ at, signals, candidates, accepted, conflicts }` |
| adapter allow-lists | (optional) | see the "install config" column above |

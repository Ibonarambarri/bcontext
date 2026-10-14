# Configuration reference

Every variable Bcontext reads, taken from the three templates in the
repository: `.env.example` (the instance), `apps/api/.env.example` (the API,
worker and error collector) and `apps/web/.env.example` (the web app on its
own). Defaults are what applies when the variable is unset.

## How configuration reaches the containers

With the bundled `docker-compose.yml` you edit one file, the root `.env`
(`setup.sh` creates it from `.env.example`), and run `docker compose up -d`.

- `api`, `worker` and `errors` load the **whole** `.env` (`env_file`), so any
  API variable below can be added there.
- Compose then sets these for them, derived from the root values, and they
  override `.env`: `SUPABASE_URL` (`http://kong:8000`),
  `SUPABASE_PUBLIC_URL` and `APP_URL` (`PUBLIC_URL`), `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DATABASE_SSL=disable`,
  `API_ORIGIN` (`http://api:4000`), `NODE_ENV=production` and
  `BCONTEXT_PROCESS`.
- `web` receives only the variables listed under it in `docker-compose.yml`
  (Supabase URLs and anon key, `REALTIME_PUBLIC_URL`, `API_ORIGIN`, the
  error collector and Nango hosts).

## Instance (`.env`)

### Required — `setup.sh` fills these

| Variable | Default | Description |
|---|---|---|
| `BCONTEXT_DOMAIN` | `localhost` | Public hostname; `localhost` for a local try-out |
| `BCONTEXT_SITE_ADDRESS` | `http://localhost` | What Caddy serves: the bare domain (automatic HTTPS) or `http://localhost` |
| `PUBLIC_URL` | `http://localhost` | The origin people open, no trailing slash. Links, OAuth redirects, Auth and Storage URLs derive from it |
| `REALTIME_PUBLIC_URL` | `ws://localhost` | The same origin as a WebSocket URL (`ws://` or `wss://`), for presence and live editing |
| `POSTGRES_PASSWORD` | generated | Postgres password, also used by the Supabase service roles. Hex only. Taken by the database once, on first boot: never change it afterwards |
| `JWT_SECRET` | generated | Signs every Supabase JWT (sessions and the two keys below) |
| `ANON_KEY` | generated | HS256 JWT with `role=anon`, signed with `JWT_SECRET` |
| `SERVICE_ROLE_KEY` | generated | HS256 JWT with `role=service_role`, signed with `JWT_SECRET` |
| `REALTIME_SECRET` | generated | Shared secret of `POST /realtime/broadcast` between processes |
| `ERRORS_INGEST_KEY` | generated | Shared secret between the processes and the error collector |
| `PG_META_CRYPTO_KEY` | generated | Studio's key for postgres-meta (profile `studio`) |
| `ADMIN_EMAILS` | — | Comma-separated emails that may open `/admin`. Unset: nobody |
| `ORG_CREATION` | `open` | `open`: anyone may sign up and create an organization. `admin`: sign-up is closed and only `ADMIN_EMAILS` create organizations and invite their owners |

### Email

Without email, accounts are confirmed on creation, invitations are links you
copy, and password reset emails are not sent.

| Variable | Default | Description |
|---|---|---|
| `RESEND_API_KEY` | — | [Resend](https://resend.com) API key for Bcontext's own emails (confirmation, invitations, escalations, digest) |
| `EMAIL_FROM` | — | Sender of those emails, e.g. `Bcontext <no-reply@example.com>`; must be verified in Resend. No default: without it nothing is sent |
| `INSTANCE_NAME` | `Bcontext` | How the instance names itself in emails |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true` | Auth confirms accounts without email. `setup.sh` sets `false` once SMTP is configured |
| `SMTP_HOST` | — | SMTP server for Auth's own emails (password reset, email change); `smtp.resend.com` with `--resend-key` |
| `SMTP_PORT` | `465` | SMTP port |
| `SMTP_USER` | — | SMTP user (`resend` for Resend) |
| `SMTP_PASS` | — | SMTP password (the Resend API key for Resend) |
| `SMTP_ADMIN_EMAIL` | — | Sender address of Auth's emails |
| `SMTP_SENDER_NAME` | `Bcontext` | Sender name of Auth's emails |

### AI

Without a backend: keyword search, retrieval-only answers, no embeddings or
extraction.

| Variable | Default | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | — | Vercel AI Gateway key; model ids are `provider/model`. The only backend with rerank |
| `OPENAI_BASE_URL` | — | Any OpenAI-compatible server (Ollama, LiteLLM, vLLM). Wins over the gateway when set. A server on the Docker host is `http://host.docker.internal:<port>/v1` |
| `OPENAI_API_KEY` | — | Key for `OPENAI_BASE_URL`, when the server wants one |
| `CHAT_MODEL` | `anthropic/claude-sonnet-5` | Interactive answers: Nexo chat, `ask_nexo` / `ask_rag`, skills, autofix, meeting refine. In the backend's own naming |
| `EXTRACT_MODEL` | `deepseek/deepseek-v4-flash` | Structured extraction and judging: ingest, conflicts, contradiction sweep, integrations |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embeddings. **Must return 1536-dimensional vectors** (the columns are `vector(1536)`) |

### Operations

| Variable | Default | Description |
|---|---|---|
| `BCONTEXT_VERSION` | `latest` | Image tag of `ghcr.io/ibonarambarri/bcontext-api` and `bcontext-web` |
| `BCONTEXT_PULL_POLICY` | `missing` | `missing`: pull the image if it is not present, build from source if it cannot be pulled. `build`: always build locally |
| `HTTP_PORT` | `80` | Caddy's published HTTP port |
| `HTTPS_PORT` | `443` | Caddy's published HTTPS port (TCP and UDP) |
| `STUDIO_PORT` | `54323` | Supabase Studio on `127.0.0.1` (profile `studio`) |
| `ERRORS_INGEST_URL` | — | Set to `http://errors:4100` when running the `errors` profile, so every process reports to it |
| `JWT_EXPIRY` | `3600` | Session (access token) lifetime in seconds |
| `DISABLE_SIGNUP` | `true` | `false` re-opens GoTrue's own `/auth/v1/signup`. Accounts are otherwise created only through the API, which enforces `ORG_CREATION` |

### Nango (long-tail integrations)

| Variable | Default | Description |
|---|---|---|
| `NANGO_SERVER_URL` | — | Your Nango server as the API reaches it. Without it, Nango-backed integrations are off |
| `NANGO_SECRET_KEY` | — | Nango environment secret key |
| `NANGO_WEBHOOK_SECRET` | — | Nango webhook signing key |
| `NANGO_PUBLIC_URL` | — | Nango as the browser reaches it, when different; also the OAuth callback host |
| `NANGO_CONNECT_URL` | — | Nango's Connect UI origin, for the web app |

The other integrations (GitHub, Slack, Linear, Notion, Recall) are set with
the API variables below, added to the same `.env`.

## API, worker and error collector (`apps/api/.env.example`)

Variables already listed above (`ADMIN_EMAILS`, `ORG_CREATION`, email, AI,
Nango, `ERRORS_INGEST_*`) mean the same here. The `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`
and `NEXT_PUBLIC_ALLOWED_ORIGINS` spellings are still read as fallbacks until
2026-12-31; use the plain names.

### Core (set by compose)

| Variable | Default | Description |
|---|---|---|
| `SUPABASE_URL` | — | Supabase gateway (Kong). Without it and the service key the API runs on an in-memory demo store |
| `SUPABASE_PUBLIC_URL` | `SUPABASE_URL` | The same gateway as browsers reach it; storage URLs and the session cookie name use it |
| `SUPABASE_ANON_KEY` | — | Anon JWT, used to validate user sessions |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service-role JWT for server-side reads and writes |
| `DATABASE_URL` | — | Direct, session-mode Postgres URL (never a transaction pooler): worker queues, realtime `LISTEN/NOTIFY`, transactional webhooks |
| `APP_URL` | `http://localhost:3000` | Public URL of the web app: links, OAuth redirects, discovery documents. Required in production: the API and worker refuse to boot without it |

### Process, database and queue

| Variable | Default | Description |
|---|---|---|
| `BCONTEXT_PROCESS` | `api` | Which process the image starts: `api`, `worker` or `errors` |
| `API_PORT` | `4000` | Port the API listens on |
| `DATABASE_SSL` | auto | Unset: plain TCP on loopback, TLS elsewhere. `require` forces TLS, `disable` turns it off |
| `DATABASE_POOL_MAX` | `5` | Connections in the API/worker Postgres pool |
| `DATABASE_APP_NAME` | `bcontext-worker` | `application_name` the pool reports |
| `PGBOSS_POOL_MAX` | `3` | Connections pg-boss opens |
| `PGBOSS_SCHEMA` | `pgboss` | Schema pg-boss keeps its tables in |
| `TASKS_AUTO_ARCHIVE_DAYS` | `30` | Days a done, untouched task waits before the worker archives it |
| `API_ORIGIN` | — | Internal URL of the API, for a process without `DATABASE_URL` to relay realtime events |
| `REALTIME_SECRET` | — | Shared secret of `POST /realtime/broadcast` (same fallback) |
| `ALLOWED_ORIGINS` | — | Extra browser origins (comma-separated) the API accepts writes from, besides `APP_URL` |

### Retrieval and Nexo tuning

| Variable | Default | Description |
|---|---|---|
| `EXTRACT_PROVIDERS` | `azure,deepinfra,fireworks` | Gateway hosts allowed to serve open-weight extract models (gateway only) |
| `CONTEXTUAL_RETRIEVAL` | off | `1` adds a model-written context prefix to each chunk (measured not to help; costly) |
| `CONTEXT_MODEL` | `anthropic/claude-haiku-4-5` | Model for those prefixes, only with `CONTEXTUAL_RETRIEVAL=1` |
| `RERANK_MODEL` | `cohere/rerank-v3.5` | Rerank model on the gateway; ignored with `OPENAI_BASE_URL` |
| `RAG_FORCE_KEYWORD` | — | Measurement only: `1` forces keyword retrieval. Never in production |
| `NEXO_AUTO_ACCEPT_THRESHOLD` | `0.7` | Triage confidence at or above which extracted candidates are written without review |
| `NEXO_CONTRADICTIONS_MAX_PAIRS` | `50` | Contradiction-judge model calls per workspace per day; `0` disables it |

### Integrations

Webhook and callback URLs are `<PUBLIC_URL>/api/webhooks/<provider>` and
`<PUBLIC_URL>/api/connectors/<provider>/callback`; see
[self-hosting.md](self-hosting.md#integrations-optional). Unset connectors
answer 503 or 404.

| Variable | Default | Description |
|---|---|---|
| `GITHUB_APP_ID` | — | GitHub App id (permissions: Contents read/write, Issues read, Pull requests read) |
| `GITHUB_APP_SLUG` | — | GitHub App slug, for the install link |
| `GITHUB_APP_PRIVATE_KEY` | — | GitHub App private key (PEM) |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub webhook secret |
| `SLACK_CLIENT_ID` | — | Slack app OAuth client id |
| `SLACK_CLIENT_SECRET` | — | Slack app OAuth client secret |
| `SLACK_SIGNING_SECRET` | — | Slack request signing secret |
| `LINEAR_CLIENT_ID` | — | Linear OAuth client id |
| `LINEAR_CLIENT_SECRET` | — | Linear OAuth client secret |
| `LINEAR_WEBHOOK_SECRET` | — | Linear webhook signing secret |
| `NOTION_CLIENT_ID` | — | Notion OAuth client id (one-shot importer) |
| `NOTION_CLIENT_SECRET` | — | Notion OAuth client secret |
| `MEETING_BOT_PROVIDER` | `recall` | Meeting bot provider |
| `RECALL_API_KEY` | — | Recall.ai API key |
| `RECALL_WEBHOOK_SECRET` | — | Recall.ai webhook secret |
| `RECALL_API_BASE` | — | Recall.ai API base, only for a non-default region |
| `RECALL_TRANSCRIPT_PROVIDER` | `recallai_streaming` | Recall transcript provider |

### Telemetry

| Variable | Default | Description |
|---|---|---|
| `ERRORS_INGEST_URL` | — | Error collector every process reports to (e.g. `http://errors:4100`); no-op unless the key is set too |
| `ERRORS_INGEST_KEY` | — | Shared secret between reporters and the collector; the `errors` process refuses to boot without it |
| `ERRORS_PORT` | `4100` | Port the `errors` process listens on |
| `ERRORS_POOL_MAX` | `4` | Postgres connections of the `errors` process |
| `ERRORS_SAMPLE_CAP` | `5` | Error events kept per group per minute; counters stay exact |
| `ERRORS_EVENT_RETENTION_DAYS` | `30` | The worker deletes error events older than this |
| `ERRORS_GROUP_RETENTION_DAYS` | `90` | The worker deletes quiet, empty, un-noted error groups after this |
| `RELEASE_SHA` | `SOURCE_COMMIT` | Build a report belongs to; falls back to `SOURCE_COMMIT`, then `GIT_COMMIT_SHA` |
| `SOURCE_COMMIT` | — | Commit of the build (the `SOURCE_COMMIT` build arg); shown by `/api/health` |
| `BETTER_STACK_SOURCE_TOKEN` | — | Better Stack source token: ships warn/error logs when set with the URL below |
| `BETTER_STACK_INGESTING_URL` | — | Better Stack ingesting host URL |
| `BETTER_STACK_MIN_LEVEL` | `warn` | Lowest level shipped to Better Stack |

## Web app on its own (`apps/web/.env.example`)

Only needed to run `apps/web` outside the bundled compose (for example
`npm run dev`). Values are read at runtime (`src/lib/public-env.ts`, served
to the browser as `/env.js`), so one image serves any domain; the
`NEXT_PUBLIC_*` spellings are read as a build-time fallback.

| Variable | Default | Description |
|---|---|---|
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | — | Supabase gateway as this server reaches it. The web app only uses Auth; data goes through the API |
| `SUPABASE_PUBLIC_URL` | `SUPABASE_URL` | The gateway as browsers reach it |
| `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | — | Supabase anon key |
| `API_ORIGIN` | `http://localhost:4000` | The API. Read at **build** time by `next.config.mjs` (proxy rewrites for `/api/*`, `/mcp`, …) and at runtime for server-side calls. Required |
| `REALTIME_PUBLIC_URL` / `NEXT_PUBLIC_REALTIME_URL` | — | The API origin as a WebSocket URL. Unset: same-browser `BroadcastChannel` fallback |
| `NEXT_PUBLIC_APP_URL` | request origin | Public origin of the web app (email links, robots.txt, MCP endpoints in the docs) |
| `ERRORS_INGEST_URL`, `ERRORS_INGEST_KEY` | — | The error collector; server-side only. Both unset: no-op |
| `BETTER_STACK_SOURCE_TOKEN`, `BETTER_STACK_INGESTING_URL`, `BETTER_STACK_MIN_LEVEL` | — | Better Stack telemetry |
| `NANGO_PUBLIC_HOST` / `NEXT_PUBLIC_NANGO_HOST` | — | Nango's API as the browser reaches it |
| `NANGO_CONNECT_URL` / `NEXT_PUBLIC_NANGO_CONNECT_URL` | — | Nango's Connect UI as the browser reaches it |

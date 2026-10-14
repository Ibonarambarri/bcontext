# Local development stack

Two ways to run Bcontext locally.

## The whole product, as a self-hoster runs it

From the repository root: `./setup.sh --domain localhost -y && docker compose up -d --build`
(see the root `README.md`). Good for trying a change end to end; slow to
iterate on.

## The API from source, against a local Supabase

Uses the Supabase CLI and this directory's `supabase/config.toml`:

```sh
supabase start          # first run pulls images; applies every migration + seed.sql
./scripts/local-env.sh  # writes .env.development.local from `supabase status`
npm run build:api    && set -a && . ./.env.development.local && set +a && node dist/api.cjs     # api    :4000
npm run build:worker && set -a && . ./.env.development.local && set +a && node dist/worker.cjs  # worker
```

The web app (`apps/web`) has its own `scripts/local-env.sh` that points it at
this API on :4000; `npm run dev -w bcontext-web` serves it on :3000.

`supabase stop` keeps the data; `supabase db reset` replays every migration
from an empty database — the fastest way to check the migrations still
reproduce. The Supabase CLI skips files whose version is not purely numeric
(`0027b_…`, `0042b_…`); the compose runner (`deploy/migrate/migrate.sh`)
applies them, so check a new migration there too.

### Ports

Deliberately not the CLI defaults, so this can run beside another project's
local Supabase: API `55321`, Postgres `55322`, Inbucket (mail) `55324`.
Studio, Realtime, Analytics and Edge Runtime are off.

`.env.development.local` is gitignored and generated; delete it and the
processes go back to whatever `.env.local` says.

## Useful scripts

- `scripts/mcp-client.mjs` — call MCP tools from a terminal
  (`BCONTEXT_MCP_URL`, `BCONTEXT_MCP_TOKEN`).
- `scripts/session-cookie.mjs <email>` — a Cookie header for a signed-in
  local user, to `curl` server-rendered pages of the web app.
- `scripts/oauth-e2e.mjs`, `scripts/realtime-smoke.mjs`, `scripts/mcp-bench.mjs`
  — the OAuth flow, the realtime hub and `/mcp` latency, end to end.
- `scripts/rag-eval.mjs --dataset <file>` — retrieval quality against a set
  of questions you write for your own workspace.

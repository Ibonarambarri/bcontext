# Self-hosting Bcontext

Bcontext runs as one `docker compose` project on one machine: the web app,
the API and its worker, a minimal Supabase (Postgres with pgvector, Auth,
PostgREST, Storage) and Caddy in front. This guide covers installing,
configuring and operating it. Every variable is listed in
[configuration.md](configuration.md).

## Requirements

- A Linux server or a Mac/Windows machine with **Docker Engine and Compose
  v2** (`docker compose version`).
- **bash, openssl and awk** for `setup.sh`.
- **RAM**: 4 GB is comfortable. The running stack uses about 1 GB;
  building the images from source needs more while it runs.
- **Disk**: about 5 GB for the images (more for the build cache when you
  build from source), plus your data and uploaded files.
- **For a public instance**: a domain name with a DNS record (A/AAAA)
  pointing at the server, and **ports 80 and 443** reachable from the
  internet (443/udp too if you want HTTP/3). Nothing else is published:
  every service talks over the compose network.

## Install

Prefer to have a coding agent do it? Paste the prompt from the README's
Quickstart; the agent follows [install-with-an-agent.md](install-with-an-agent.md).

```bash
git clone https://github.com/Ibonarambarri/bcontext.git && cd bcontext
./setup.sh
docker compose up -d
```

`setup.sh` asks for the domain and the admin email, generates every secret
and writes `.env` (mode 600). Then `docker compose up -d` starts the stack;
the `migrate` service creates the schema on first boot, and `api` and
`worker` start once it has finished.

If no release image exists on the registry for `BCONTEXT_VERSION` (default
`latest`), Compose builds the images from the checkout instead, which takes
several minutes the first time. `docker compose up -d --build` forces a
build from source.

### `setup.sh`

Re-run it any time: secrets already in `.env` are kept, only empty ones are
generated, and the options you pass are updated.

| Option | Effect |
|---|---|
| `--domain <host>` | Public hostname. `localhost` (or `127.0.0.1`) serves plain HTTP for a local try-out; anything else gets automatic HTTPS |
| `--admin-email <email>` | Sets `ADMIN_EMAILS`: who may open `/admin` (comma-separated for several) |
| `--http-port <port>` | Caddy's HTTP port (default 80). For `localhost` only: it becomes part of the URL |
| `--https-port <port>` | Caddy's HTTPS port (default 443). A public domain needs 443 |
| `--resend-key <key>` | Turns on email through [Resend](https://resend.com); needs `--email-from` |
| `--email-from "<Name> <address>"` | Sender of every email; the domain must be verified in Resend |
| `--org-creation open\|admin` | Who may sign up and create organizations (see below) |
| `--rotate` | Regenerates every secret except `POSTGRES_PASSWORD`; signs everyone out |
| `-y`, `--yes` | Never prompt: use the flags and the defaults |

After changing `.env` by hand or with `setup.sh`, `docker compose up -d`
applies it.

## Domain and HTTPS

```bash
./setup.sh --domain ctx.example.com --admin-email you@example.com -y
docker compose up -d
```

For any domain other than `localhost`, `setup.sh` sets
`BCONTEXT_SITE_ADDRESS` to the bare domain and `PUBLIC_URL` to
`https://<domain>`. Caddy then obtains and renews a Let's Encrypt
certificate on its own; it needs the DNS record to point at this machine and
ports 80 and 443 open before the first request. Certificates are kept in the
`caddy-data` volume.

### Behind an existing reverse proxy

If the machine already runs a proxy on ports 80 and 443 (Traefik from
Coolify, nginx, another Caddy), let it terminate HTTPS and pass plain HTTP
to Bcontext's Caddy. After `setup.sh --domain ctx.example.com`, edit `.env`:

```bash
BCONTEXT_SITE_ADDRESS=http://ctx.example.com   # Caddy serves plain HTTP
HTTP_PORT=127.0.0.1:18080                      # loopback only
HTTPS_PORT=127.0.0.1:18443                     # unused, kept off 443
```

`PUBLIC_URL` stays `https://ctx.example.com`. Point the proxy at
`127.0.0.1:18080`, or put `caddy` on the proxy's Docker network and target
`http://bcontext-caddy-1:80`, keeping the `Host` header. Caddy trusts the
`X-Forwarded-*` headers of proxies on private addresses.

Everything is served from that one origin: the web app, the API (`/api/*`),
MCP (`/mcp`), realtime (`/realtime/*`), discovery (`/.well-known/*`) and the
Supabase gateway (`/auth/v1`, `/rest/v1`, `/storage/v1`). See
`deploy/caddy/Caddyfile`.

## The first admin and who may sign up

`ADMIN_EMAILS` lists the people who may open `/admin` (users,
organizations, and errors when the collector runs). Being an admin
comes from the email alone, so the admin signs up like anyone else:

1. Open `PUBLIC_URL` and go to `/start`.
2. Create the account with the admin email, then the organization; its first
   workspace is created with it.

`ORG_CREATION` decides who else can do that:

- `open` (default): anyone who reaches the instance may sign up and create
  an organization; others join existing organizations by invitation.
- `admin`: sign-up is closed and only `ADMIN_EMAILS` create organizations
  and invite their owners. Because sign-up is closed too, create the admin
  account first with `open`, then switch:
  `./setup.sh --org-creation admin -y && docker compose up -d`.

Accounts are created by the API. GoTrue's own `/auth/v1/signup` is disabled
(`DISABLE_SIGNUP=true`) so it cannot be used to bypass this policy.

## Email

Without email the instance still works: new accounts are confirmed on
creation, invitations are links you copy and send yourself, and password
reset emails are not sent.

There are two senders:

- **Bcontext's own emails** (sign-up confirmation, invitations, Nexo
  escalations, the weekly digest) go through the Resend API:
  `RESEND_API_KEY` and `EMAIL_FROM`.
- **Auth's emails** (password reset, email change) go through SMTP:
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`.

With Resend, one command sets both (Resend also offers SMTP):

```bash
./setup.sh --resend-key re_... --email-from "Bcontext <no-reply@ctx.example.com>" -y
docker compose up -d
```

With another provider, set the `SMTP_*` variables in `.env` for Auth's
emails and re-run `./setup.sh -y` (it turns off auto-confirmation once
`SMTP_HOST` and `SMTP_PASS` are set). Bcontext's own emails need Resend;
without it they are skipped and invitations stay copyable links.

## AI

Optional. Without an AI backend, search is keyword-only and `ask_nexo`
answers with retrieval alone; embeddings, extraction from integrations and
meetings, skills and the Nexos' chat need one. Choose one backend in `.env`:

- **Vercel AI Gateway**: `AI_GATEWAY_API_KEY`. Model ids are
  `provider/model`; the defaults are `CHAT_MODEL=anthropic/claude-sonnet-5`,
  `EXTRACT_MODEL=deepseek/deepseek-v4-flash` and
  `EMBEDDING_MODEL=openai/text-embedding-3-small`. The only backend with
  rerank.
- **Any OpenAI-compatible server** (Ollama, LiteLLM, vLLM, OpenAI itself):
  `OPENAI_BASE_URL` and, if the server wants one, `OPENAI_API_KEY`. It wins
  over the gateway when both are set. Set `CHAT_MODEL`, `EXTRACT_MODEL` and
  `EMBEDDING_MODEL` in that server's own naming: the defaults are gateway
  ids. A server on the Docker host is
  `http://host.docker.internal:<port>/v1` (for Ollama,
  `http://host.docker.internal:11434/v1`).

> **Embeddings must be 1536-dimensional.** The vector columns are
> `vector(1536)`. `text-embedding-3-small` fits; many local models do not
> (`nomic-embed-text` is 768, `mxbai-embed-large` is 1024), and with them
> every embedding write fails with Postgres' `expected 1536 dimensions`.
> Changing `EMBEDDING_MODEL` later leaves existing chunks on the old model;
> `apps/api/scripts/reembed-stale.ts` re-embeds a workspace.

Then `docker compose up -d`.

## Integrations (optional)

Each integration is off until its variables are set; the rest of the product
runs without them. Add the variables to the root `.env` (the `api`,
`worker` and `errors` containers read the whole file) and run
`docker compose up -d`. Webhook and OAuth callback URLs are on your public
origin:

| Integration | Variables | URLs to register with the provider |
|---|---|---|
| GitHub App | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | webhook `/api/webhooks/github`, setup/callback `/api/connectors/github/callback` |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | events `/api/webhooks/slack`, OAuth redirect `/api/connectors/slack/callback` |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | webhook `/api/webhooks/linear`, OAuth redirect `/api/connectors/linear/callback` |
| Notion (importer) | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | OAuth redirect `/api/connectors/notion/callback` |
| Meeting bots (Recall.ai) | `RECALL_API_KEY`, `RECALL_WEBHOOK_SECRET`, `RECALL_API_BASE` (non-default region) | webhook `/api/connectors/meeting-bot/webhook` |
| Nango (long tail) | `NANGO_SERVER_URL`, `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`, `NANGO_PUBLIC_URL`, `NANGO_CONNECT_URL` | webhook `/api/webhooks/nango` (in Nango) |

[Nango](https://nango.dev) handles auth and proxying for the long tail of
providers (Jira, HubSpot, Google, Microsoft and many more). It is **not
bundled**: it needs its own Postgres, Redis and two public origins, so run it
next to Bcontext with Nango's self-hosting guide.
`apps/api/docs/integrations-nango.md` describes the setup, the OAuth apps
and every provider. Without it, Nango-backed integrations answer 503.

External MCP servers and webhooks need no configuration on the instance:
workspace admins add them in the web app (Tools), and their secrets are
stored in Supabase Vault.

## Optional services

```bash
docker compose --profile errors up -d   # error collector, shown in /admin/errors
docker compose --profile studio up -d   # Supabase Studio on 127.0.0.1:54323
```

For the error collector, also set `ERRORS_INGEST_URL=http://errors:4100` in
`.env` (the key is generated by `setup.sh`) so the other processes report to
it. Studio has no login of its own and listens on loopback only; on a server,
reach it through an SSH tunnel.

## Updating

Migrations are read from the checkout (`apps/api/supabase/migrations`), so
the code and the images must move together.

- **Release images** (the default: `BCONTEXT_VERSION=latest` follows the
  newest release):

  ```bash
  git pull
  docker compose pull
  docker compose up -d
  ```

  To pin a version, check out its tag and set `BCONTEXT_VERSION` to it in
  `.env` (`git fetch --tags && git checkout v0.1.0`, `BCONTEXT_VERSION=0.1.0`).
- **Built from source** (a fork, or code ahead of the last release):

  ```bash
  git pull
  docker compose up -d --build
  ```

  Without `--build`, Compose keeps the images it already has.

Either way `migrate` applies the new migrations before `api` and `worker`
start again. Check it with `docker compose logs migrate`.

## Backups

State lives in three named volumes: `db-data` (Postgres), `db-config` (the
database's Vault key, which encrypts the secrets of connected MCP servers and
integrations) and `storage-data` (uploaded files). `caddy-data` only holds
certificates, which Caddy can obtain again. Keep a copy of `.env` too: its
secrets sign every session and key.

While the stack runs:

```bash
# Database (as supabase_admin, the only role that can read every schema)
docker compose exec -T db pg_dump -U supabase_admin -Fc postgres > bcontext-$(date +%F).dump
# Vault key: without it, restored integration secrets cannot be decrypted
docker compose exec -T db cat /etc/postgresql-custom/pgsodium_root.key > pgsodium_root.key
# Uploaded files
docker run --rm -v bcontext_storage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/bcontext-storage-$(date +%F).tgz -C /data .
```

Keep the dump, the key and the archive together, and the key as private as
`.env`.

To restore into a fresh instance (same checkout, same `.env`, empty volumes):

```bash
docker compose up -d db
# put the Vault key back, then restart so Postgres reads it
docker compose exec -T db sh -c 'cat > /etc/postgresql-custom/pgsodium_root.key' < pgsodium_root.key
docker compose restart db
docker compose exec -T db pg_restore -U supabase_admin -d postgres --clean --if-exists < bcontext-….dump
docker run --rm -v bcontext_storage-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/bcontext-storage-….tgz -C /data
docker compose up -d
```

`pg_restore` reports a few errors about objects that already exist or that
others depend on (for example `cannot drop constraint users_pkey`); they are
expected on a fresh database. `migrate` then finds every migration recorded
and applies nothing. Test a restore before you need one.

## Operating

- Status: `docker compose ps -a`. `api` and `web` have health checks; `migrate`
  shows `Exited (0)` when it is done.
- Logs: `docker compose logs -f api worker` (JSON lines; `worker.job.failed`
  for failed jobs).
- Health: `curl https://ctx.example.com/api/health` returns
  `{"status":"ok","db":"ok",…}`.
- Reset everything (destroys all data): `docker compose down -v`.

## Troubleshooting

**`env file .env not found` or `required variable PUBLIC_URL is missing a
value: run ./setup.sh first`.** Run `./setup.sh` in the repository root
before `docker compose`.

**`Bind for 0.0.0.0:80 failed: port is already allocated`** (or 443).
Another service holds the port. Locally, use other ports:
`./setup.sh --domain localhost --http-port 8080 --https-port 8443 -y`. A
public instance needs 80 and 443 for its certificate.

**`api` and `worker` never start.** They wait for `migrate` to exit
successfully. `docker compose logs migrate` shows the failing migration;
`migrate` itself waits for `db`, `auth` and `storage` to be healthy, so check
`docker compose ps` and their logs too.

**`auth`, `rest` or `storage` fail with `password authentication failed`.**
`POSTGRES_PASSWORD` in `.env` no longer matches the one the database volume
was initialised with (the roles take it once, on the first boot). Restore
the original value. `setup.sh --rotate` never changes it.

**The browser shows a certificate error or Caddy logs ACME failures.** The
DNS record does not point at this machine yet, or ports 80/443 are closed.
Fix that and `docker compose restart caddy`; `docker compose logs caddy`
shows the attempts.

**After `git pull`, the instance still runs the old code.** The images
already exist locally, so `docker compose up -d` reuses them. Use
`docker compose up -d --build`.

**`docker compose pull` fails with `manifest unknown`.** No release image
exists for `BCONTEXT_VERSION`. Build from source instead
(`docker compose up -d --build`), or set a version that was released.

**Links in emails or invitations point to the wrong host.** They are built
from `PUBLIC_URL`. Re-run `./setup.sh --domain <your domain> -y` and
`docker compose up -d`.

**Sign-up answers `429 rate_limited`.** Repeated sign-up attempts from one
address are limited; wait a minute.

**Embedding errors mentioning `expected 1536 dimensions`.** The embedding
model does not return 1536-dimensional vectors; see [AI](#ai).

**The AI backend on the host is unreachable from the containers.** Use
`http://host.docker.internal:<port>/v1`, not `localhost` (inside a container
that is the container itself), and make the server listen on an interface
Docker can reach (for Ollama, `OLLAMA_HOST=0.0.0.0`).

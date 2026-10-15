# Installing Bcontext with an agent

These are instructions for a coding agent (Claude Code, Codex, Cursor or any
agent with a shell) that a person asked to install Bcontext. The person
pasted the prompt from the README; follow these steps in order and keep
them informed in short messages.

People: you can read along, it is the same install as
[self-hosting.md](self-hosting.md), done for you.

## Rules

- Ask the person only for what you cannot decide: where it runs, the admin
  email, and AI keys. Use the defaults below for everything else.
- Never print, paste or commit the contents of `.env`: it holds every
  secret of the instance. Read single values with `grep` only when needed.
- Never run `docker compose down -v`, `setup.sh --rotate` or anything that
  deletes volumes on an existing install without the person's explicit OK:
  it destroys their data or signs everyone out.
- When a step fails, read the logs and the
  [Troubleshooting](self-hosting.md#troubleshooting) section before trying
  something else.

## 1. Check the machine

Run and check:

- `docker compose version`: Docker with Compose v2. If Docker is installed
  but not running, start it (on macOS `open -a Docker`, then wait until
  `docker info` succeeds).
- `git --version`, `openssl version`, `bash` and `awk`.
- Free RAM: about 1 GB to run, about 4 GB if the images have to be built
  from source (`free -m` on Linux, `vm_stat` or Docker Desktop's resource
  settings on macOS).

If something is missing, tell the person what and how to install it for
their OS, and stop until it is there.

## 2. Ask the person

Ask these in one message, with the defaults:

1. **Where does it run?** Default: *this machine, locally* (`localhost`).
   For a server, they give a domain whose DNS already points at it, and
   ports 80 and 443 must be open.
2. **Admin email**: the address they will sign up with. It may open
   `/admin`.
3. **AI backend** (optional, can be added later): a Vercel AI Gateway key,
   an OpenAI-compatible server (OpenAI, Ollama, LiteLLM…), or none. Without
   one, search is keyword-only.

## 3. Get the code

If there is no checkout yet:

```bash
git clone https://github.com/Ibonarambarri/bcontext.git && cd bcontext
```

If the person already has one (a `docker-compose.yml` and `setup.sh` in the
folder), this is an **update**: `git pull`, then
`docker compose pull && docker compose up -d` (or `docker compose up -d
--build` if they build from source). Their `.env` is kept; skip to step 5's
health check.

## 4. Configure

For a local install, check port 80 first (`lsof -iTCP:80 -sTCP:LISTEN` or
`ss -ltn`). If it is taken, add `--http-port 8080 --https-port 8443`.

```bash
# local
./setup.sh --domain localhost --admin-email <email> -y
# server
./setup.sh --domain <domain> --admin-email <email> -y
```

`setup.sh` writes `.env` with fresh secrets and is safe to re-run.

**AI**, if they chose one: set the values in `.env` by editing only those
lines (uncomment them; never rewrite the file):

- Gateway: `AI_GATEWAY_API_KEY=<key>`.
- OpenAI-compatible: `OPENAI_BASE_URL=<url>/v1` and, if needed,
  `OPENAI_API_KEY`, plus `CHAT_MODEL`, `EXTRACT_MODEL` and `EMBEDDING_MODEL`
  in that server's naming. For OpenAI itself:
  `OPENAI_BASE_URL=https://api.openai.com/v1`,
  `EMBEDDING_MODEL=text-embedding-3-small`, and a current chat model the
  person picks for `CHAT_MODEL` and `EXTRACT_MODEL`.
  A server on the same machine is `http://host.docker.internal:<port>/v1`.
  **The embedding model must return 1536 dimensions**: most local
  embedding models do not; warn the person if theirs does not.

Email (Resend or SMTP) is optional; skip it unless asked. Without it,
invitations are links to copy.

## 5. Start

```bash
docker compose up -d
```

The first run pulls the release images, or builds them from source if none
exist (several minutes). Then wait until it is ready, checking every
15 seconds for up to 10 minutes:

- `docker compose ps -a`: `migrate` has exited with code 0, `api` and
  `web` are `healthy`.
- `curl -fsS <PUBLIC_URL>/api/health` returns `"status":"ok"`.
  `PUBLIC_URL` is in `.env`: `http://localhost` (with `:8080` if you changed
  the port) or `https://<domain>`.

If it does not get there, `docker compose logs --tail 100 <service>` for
the failing one and see Troubleshooting.

## 6. Hand over to the person

Creating the account needs a password only they should know. Tell them:

> Open **<PUBLIC_URL>/start**, create your account with **<admin email>**
> and name your organization (its first workspace, `general`, is created
> for you). Tell me when you are in.

When they confirm, ask for the URL they see in the browser; it looks like
`<PUBLIC_URL>/w/<org>/<workspace>`. The two slugs are what you need.

## 7. Connect yourself

The workspace's MCP endpoint is `<PUBLIC_URL>/mcp/<org>/<workspace>`.

**Claude Code** (run in the folder where the person works, so the server is
scoped to that project):

```bash
claude mcp add --transport http bcontext <PUBLIC_URL>/mcp/<org>/<workspace>
```

It authenticates with OAuth: tell the person to run `/mcp` in Claude Code
and approve in the browser. For **other clients** (Cursor, Codex, Windsurf,
VS Code), write the client's MCP config with that URL as described in
[connect-agents.md](connect-agents.md); clients without OAuth need an agent
token: in the web app, **Agents → Add agent**, choose the *API key*
method and follow the wizard to the end (Method → Provider → Configure →
Connect); the token is shown once on the last step, with a ready-made
snippet for the client.

Then check: list the server's tools, call `brief` and confirm it answers
(an empty workspace is fine).

## 8. Report

Finish with a short summary:

- the URL of the instance, and that `/admin` is open to the admin email;
- where the checkout and `.env` live, and that `.env` must be backed up and
  kept private;
- what was left out (AI, email, integrations) and the
  [self-hosting guide](self-hosting.md) section for each;
- day-to-day commands: `docker compose ps`, `docker compose logs -f api`,
  and to update: `git pull && docker compose pull && docker compose up -d`.

# Connecting agents

Agents use Bcontext through its MCP server (Streamable HTTP). Every
workspace has its own endpoint:

```
https://ctx.example.com/mcp/<org>/<workspace>
```

`ctx.example.com` stands for your instance's `PUBLIC_URL`; `<org>` and
`<workspace>` are the slugs in the web app's URL (`/w/<org>/<workspace>`).
There is also a root endpoint, `/mcp`, that takes the workspace from the
token (see [Workspace tokens and user tokens](#workspace-tokens-and-user-tokens)).

The quickest way to get a working configuration is the web app: open the
workspace, go to **Agents → Add agent**, pick the client and the
authentication method, and copy the snippet it shows. The sections below
are the same configurations by hand.

## Authentication

- **OAuth 2.1** (recommended when the client supports it): no token to copy.
  The client discovers the authorization server from the endpoint, registers
  itself, and opens a browser for you to sign in and approve. Through
  `/mcp/<org>/<workspace>` the consent and the token are for that workspace
  only (30-day access token with refresh).
- **Agent token** (`bctx_live_…`): created in **Agents → Add agent** with the
  API-key method, shown once. Send it as `Authorization: Bearer <token>`. Its
  scopes decide what it can do, and `tools/list` only shows the tools it may
  call:
  - read-only: `nodes:read`, `agents:read`
  - writer: add `nodes:write`, `agents:write`
  - everything, including workspace administration: `admin:*`

Requests are rate-limited per token (reads 120/min, writes 60/min, chat
30/min); over the limit the server answers 429 with `Retry-After`.

## Claude Code

**With the plugin.** The Bcontext plugin registers the server and adds a
skill with the working conventions and a `/bcontext:brief` command. In
Claude Code:

```
/plugin marketplace add Ibonarambarri/bcontext
/plugin install bcontext@bcontext
```

The plugin reads three environment variables; set them in the shell that
starts Claude Code:

```bash
export BCONTEXT_URL="https://ctx.example.com"   # your instance, without /mcp
export BCONTEXT_TOKEN="bctx_live_…"             # an agent token
export BCONTEXT_WORKSPACE="acme/docs"           # only for a user token, see below
```

`BCONTEXT_URL` has no default: until it is set, the plugin's `bcontext`
server shows as failed in `/mcp`. If you connect per project with
`claude mcp add` (below), you can leave it unset and still use the plugin's
skill and `/bcontext:brief`. The plugin's source is in [`plugin/`](../plugin).

**Without the plugin**, add the server to the project:

```bash
# OAuth: Claude Code opens the browser the first time (or run /mcp)
claude mcp add --transport http bcontext https://ctx.example.com/mcp/acme/docs

# Agent token
claude mcp add --transport http bcontext https://ctx.example.com/mcp/acme/docs \
  --header "Authorization: Bearer bctx_live_…"
```

or write the entry in the project's `.mcp.json`, which is the natural place
for a per-workspace endpoint: the folder says which workspace it works in.

```json
{
  "mcpServers": {
    "bcontext": {
      "type": "http",
      "url": "https://ctx.example.com/mcp/acme/docs",
      "headers": { "Authorization": "Bearer ${BCONTEXT_MCP_TOKEN}" }
    }
  }
}
```

The instance also serves an installer that writes that entry:

```bash
curl -sSL https://ctx.example.com/install/mcp | node - --workspace acme/docs --token bctx_live_…
```

Restart Claude Code; `/mcp` should list the server as connected.

## Cursor, Codex and other clients

Any client that speaks MCP over HTTP works with the same URL and either
OAuth or the bearer header.

- **Cursor**: Settings → MCP → Add new MCP server, or `.cursor/mcp.json`:

  ```json
  {
    "mcpServers": {
      "bcontext": {
        "url": "https://ctx.example.com/mcp/acme/docs",
        "headers": { "Authorization": "Bearer bctx_live_…" }
      }
    }
  }
  ```

  Leave out `headers` to use OAuth.
- **Codex CLI**:

  ```bash
  # OAuth
  codex mcp add bcontext --url https://ctx.example.com/mcp/acme/docs
  # Agent token, read from an environment variable
  export BCONTEXT_MCP_TOKEN=bctx_live_…
  codex mcp add bcontext --url https://ctx.example.com/mcp/acme/docs \
    --bearer-token-env-var BCONTEXT_MCP_TOKEN
  ```

- **Claude Desktop / claude.ai**: Settings → Connectors → Add custom
  connector with the endpoint URL. Custom connectors use OAuth.
- **Others** (Windsurf, Zed, VS Code / Copilot, Gemini CLI, Cline, Goose…):
  **Agents → Add agent** shows the exact snippet for each.

## Workspace tokens and user tokens

- On `/mcp/<org>/<workspace>`, a workspace token must belong to that
  workspace (any other pair answers 404), and a user-scoped token is checked
  for membership.
- On `/mcp`, a workspace token is bound to its own workspace. A user-scoped
  token (OAuth through `/mcp`) chooses the workspace per request with the
  header `X-Bcontext-Workspace: <org>/<workspace>` (or `?workspace=`); this
  is what the plugin's `BCONTEXT_WORKSPACE` sets.

`initialize` reports `Bcontext · <org>/<workspace>` as the server title, so
you can check which workspace a session landed in.

## The working loop

The server's `instructions` (sent on `initialize`) teach agents the
conventions; the plugin's skill teaches them before connecting. The loop
they describe:

1. **Start with `brief`.** One read-only call: counts, the unblocked task
   queue by priority, open decisions, what is assigned to you and what
   changed since this token's previous brief.
2. **Pick or create a task** (`nodes`, `nodes_write`). A piece of work is one
   task node; its steps are subtasks (`subtasks_write`), not more tasks.
   Dependencies are typed links (`links_write` with `blocked_by`), so
   `nodes({ op: "list", kind: "task", unblocked: true })` answers "what can I
   start now".
3. **Mark it `in_progress`** so other agents and people see who is on it.
4. **Work, and write as you go.** Decisions, docs and findings are nodes with
   `##` sections; each section is addressable as `/n/<id>#<section>`. Edits
   that patch a body send `if_updated_at` (from your last read); a 409 means
   someone else wrote first: re-read, merge, retry. In long sessions,
   `list_changes({ since })` re-syncs cheaply.
5. **Close with `## Result`.** Append a `## Result` section
   (`nodes_write` with `op: "append"`) saying what was done, where, and what
   is left, then set the task to `done`. That section is what the next agent
   reads instead of the transcript.

Questions about the workspace go to `ask_nexo` (a cited answer with
confidence, freshness and gaps) or `ask_rag` (the ranked passages). Tools
from other MCP servers connected to the workspace, and the workspace's
skills, are found with `capability_search` and run with `capability_call`.

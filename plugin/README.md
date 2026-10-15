# Bcontext plugin for Claude Code

Teaches Claude Code to work a Bcontext workspace: loads the conventions
skill, adds `/bcontext:brief` and can register the MCP server for you. This
repository is also the plugin's marketplace
(`.claude-plugin/marketplace.json` at the root).

## Install

In Claude Code:

```
/plugin marketplace add Ibonarambarri/bcontext
/plugin install bcontext@bcontext
```

Then connect, one of two ways.

**Per project (recommended).** The workspace's own endpoint, OAuth in the
browser, no secret to manage:

```bash
claude mcp add -s project --transport http bcontext-<org>-<ws> https://ctx.example.com/mcp/<org>/<ws>
```

This writes a `.mcp.json` in the project folder (it holds only the URL, so
it can be committed). The token Claude Code obtains is bound to that
workspace: sessions in that folder read and write only there. The skill
and the command work with this server too.

**Per user, with an agent token.** The plugin's own `bcontext` server reads
these variables; set them in the shell that starts Claude Code:

```bash
export BCONTEXT_URL="https://ctx.example.com"   # your instance, without /mcp
export BCONTEXT_TOKEN="bctx_live_…"             # Agents → Add agent → API key
export BCONTEXT_WORKSPACE="acme/docs"           # only for a user-scoped token
```

`BCONTEXT_URL` has no default: until it is set, `/mcp` shows the plugin's
`bcontext` server as failed. That is expected when you connect per project
instead.

## What's inside

- `.mcp.json`: the `bcontext` MCP server (Streamable HTTP at
  `$BCONTEXT_URL/mcp`, bearer from `$BCONTEXT_TOKEN`, workspace header from
  `$BCONTEXT_WORKSPACE`).
- `skills/bcontext/SKILL.md`: how an agent works a workspace well: `brief`
  first, H2 blocks and `/n/<id>#<block>` refs, subtasks inside a task,
  goals, datasets, reusable tags, typed edges, the `if_updated_at` rule and
  the 409 rebase loop, cited retrieval with `ask_nexo` / `ask_rag`, and
  `list_changes` re-sync.
- `commands/brief.md`: `/bcontext:brief [since]`, a standup of the active
  workspace with a `/n/<id>` ref on every item.

## Keeping it in sync

The skill names concrete MCP tools. When `TOOLS` or
`CAPABILITY_ROUTING_TOOLS` change in `apps/api/src/lib/mcp/server.ts`,
update `SKILL.md` and the tool count in `.claude-plugin/plugin.json` in the
same pull request, and bump the plugin's version.

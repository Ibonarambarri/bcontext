---
description: Daily standup brief from the active Bcontext workspace — shipped, decisions, blockers, and newly unblocked work.
argument-hint: "[since-ISO-timestamp, default 24h ago]"
---

Produce a daily brief for the active Bcontext workspace, since $ARGUMENTS (default: 24 hours ago).

Use the `mcp__bcontext__*` tools.

1. `list_changes({ since: "<ts>", limit: 200 })` — collect the raw activity.
2. `nodes({ op: "list", kind: "task", unblocked: true })` — what became ready to start.
3. For anything ambiguous, `nodes({ op: "get", id })` the specific nodes (don't re-read the whole workspace).

Output (markdown, under 200 words):
- **Shipped** — tasks/bugs that reached done, with `/n/<id>` refs.
- **Decisions** — new or edited decision/adr nodes, one line each.
- **Blockers** — tasks in blocked status or with undone blockers.
- **Newly unblocked** — ready work, ordered by priority.

Every item must carry its `/n/<node_id>` ref so the reader can jump in.

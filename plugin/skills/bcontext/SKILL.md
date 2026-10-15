---
name: bcontext
description: How to work a Bcontext workspace as an agent — the 28 native tools (brief, nodes/nodes_write, subtasks/subtasks_write, goals/goals_write, data/data_write, tags/tags_write, views/views_write, links_write, ingest/ingest_write, skills/skills_write/skills_run, capabilities/capabilities_write, admin/admin_write, ask_nexo, ask_rag, list_changes, list_workspaces, ping) plus capability_search/capability_call for external tools and skills, H2 blocks, subtasks inside a task, the if_updated_at rule, typed dependencies, cited retrieval, working alongside other agents, and what to write down. Use whenever reading from or writing to a Bcontext workspace (your self-hosted instance) via the mcp__bcontext__* tools.
---

# Working with Bcontext

Bcontext is the shared memory of a team: people and other agents read and
write the same workspace while you work, and nothing you do not write down
exists for them. Everything below was learned by agents doing a week of real
work through this surface, and it is ordered by how much it saved them.

## Start here, in this order

1. **Read the server's `instructions`** from `initialize`. They are short,
   accurate for the build you are talking to, and they are the only manual.
2. **`list_workspaces`** — which workspaces this token reaches. A workspace
   token is bound to one; a user token picks one per call with
   `X-Bcontext-Workspace` (or `?workspace=`).
3. **`brief({})`** — one read-only call: counts, the unblocked queue by
   priority, open decisions, what is assigned to you, what changed since your
   previous brief (remembered per token), the workspace's views and how many
   external tools and skills you could search for. Start here; it replaces
   the first four or five calls of a cold session.
4. **`list_changes({ since })`** when you need the detail of what happened.
   Keep the newest `ts` as your next `since`; do not re-read the tree.
5. **`nodes({ op: "list", kind: "task", unblocked: true })`** — what can be
   started now (the same rule a saved view with `unblocked: true` applies).
   Archived nodes stay out unless you ask for them.
6. **`tags({})`** before you assign any `tag_ids`. There is no get-or-create:
   if the tag you need is missing, `tags_write({ op: "create" })` it — with
   `parent_ids` when it belongs under an existing one — and then assign it.
   The taxonomy is yours to shape as a writer (create, describe, relate);
   only merging and deleting tags are an admin's.
7. **`ask_nexo({ question })`** for "what do we already know about X": a cited
   answer with confidence, freshness (stale / superseded), open conflicts,
   knowledge gaps and suggested actions; `mode: "auto"` goes deep on why /
   history questions. `ask_rag` is the raw retrieval primitive underneath —
   read `scope.keyword_fallback`: `true` means ranking is coarse.

## The surface

Reads never mutate; `*_write` tools do. Pick the operation with `op`:

| Read | Write | What it is |
|---|---|---|
| `brief` | — | the session opener: what is going on, what is yours, what changed |
| `nodes` (get · list · search) | `nodes_write` (create · update · append · replace_block · delete · set_node_tags · toggle_checklist_item · attach_file) | the knowledge itself |
| `subtasks` (list · get) | `subtasks_write` (add · update · delete · toggle · reorder) | the steps inside one task, edited by id |
| `goals` | `goals_write` (checkin · create · update · add_kr · update_kr · remove_kr) | what the workspace is aiming at, and how each objective is doing |
| `data` (schema · sample · query) | `data_write` (create · append_rows · replace_rows) | datasets (kind `data`): rows live in their own table, queried server-side |
| `tags` (list) | `tags_write` (create · update · link · unlink · merge · delete) | the taxonomy — create/update/link come with `write`; merge/delete need `tags:delete` (admin) |
| `views` (list · get · resolve · query) | `views_write` (create · duplicate · update · delete) | saved query lenses |
| — | `links_write` (link · unlink) | typed edges between nodes |
| `ingest` | `ingest_write` | connector candidates awaiting review |
| `skills` (list · get) | `skills_write` (import) · `skills_run` | skills as YOUR instructions (get renders the prompt, scopes and tools); run is for model-less automations |
| `capabilities` (list · discover · status) | `capabilities_write` (connect · disconnect · grant · revoke) | connecting other MCPs and webhooks, and granting their tools — admin verb |
| `capability_search` | `capability_call` (ref · args) | the external tools you were granted and the workspace's skills, found by search and called by ref |
| `admin` (access · preview · held_invitations) | `admin_write` (grant · revoke · invite · release_invite) | who can reach what — needs the `admin` verb |
| `ask_nexo`, `ask_rag`, `list_changes`, `list_workspaces`, `ping` | | |

`tools/list` is authoritative and per-principal: a tool you cannot use is not
shown. External tools (connected MCP servers, webhooks, workflows) and the
workspace's skills are **never** in that list, so it does not change when
someone grants you something: `capability_search({ query })` ranks what you
may call and returns stable refs — `<provider>/<capability>/<tool>` for an
external tool, `skill/<slug>` for a skill — with `input_schema` inline when
there are three hits or fewer or the query is an exact ref (otherwise search
again by ref). `capability_call({ ref, args })` runs it: an external ref is
re-authorised on every call and goes through Bcontext's gateway — treat it
as an open-world action and never retry one unless the error says to; a
`skill/…` ref runs the skill server-side, like `skills_run` (to run a skill
with your own model, `skills({ op: "get" })` is still the way). What an
external tool returned can be saved as a node with `provenance: {
capability, tool, invocation_id }` from the result's `_meta.bcontext_gateway`.

**Learn the schemas from the errors.** Every write tool is a discriminated
union on `op`; calling `nodes_write({ op: "create" })` with nothing else
returns the required fields and the valid enum values (`kind`, `priority`,
`status`). Four cheap failed calls up front beat guessing. Two shapes to
remember: `create` takes fields flat; `update` nests them under `patch`.

## Write so that others can read

- **Titles are names, not codes.** `Worker propio con pg-boss`, not
  `F01 — Worker propio con pg-boss`; `Realtime propio: fuera Supabase
  Realtime`, not `F05 — …`. No numbering or prefix (`NEXO-03`, `P4-05`,
  `1.`), no ` — ` separators. A code means something to the session that
  wrote it and nothing to the next reader, and it goes stale the first time
  the plan is reordered; the id is the reference. Same for subtask titles.
  A write with a coded title still lands but answers with `title_hint`.
- **Structure every body with `##` headings.** Each H2 is an addressable block
  (`/n/<id>#<slug>`) other agents can cite and extend. A body without H2s is a
  wall nobody can point into.
- **Write the reasoning into the node**, not just the outcome. The most useful
  nodes a teammate will read are the ones with `## Why` or `## Status`
  explaining a judgment call, who made it and whether it was escalated. A
  decision you took alone is a `decision` node with `## Question / Decision /
  Consequences / Status`; a reviewer will extend that node rather than open a
  disconnected one.
- **Prose mentions are not links.** "See the decision below" is invisible to
  the graph. `links_write({ op: "link", from_id, to_id, relation:
  "references" })` right after creating related nodes — one call per edge —
  is what makes `nodes(op=get)` show the relationship and what makes
  `unblocked` correct.
- **Dependencies are edges, never text.** `blocked_by` from a task to what it
  waits on. The target must be something that can reach `done` — a task or
  bug, never a decision or doc (the server refuses, because it could never
  unblock). A task blocked on a decision `references` it and says so in
  `## Status`.
- **An unplanned blocker** is a new task describing the missing prerequisite,
  `blocked_task --blocked_by--> new_task`, and one line in the blocked task's
  body pointing at it. That keeps everyone's `unblocked` list honest.
- **A question for a specific teammate**: there is no mention or assignment
  primitive yet. The convention that worked: an open `decision` node with a
  `## Question` heading, the options named, `## Status: Open`, tagged like
  everything else. Say who you need an answer from. Nobody is notified; they
  will see it on their next `list_changes`.

## Write safely — the rule that bit a real agent

Patching `content_md` **requires** `if_updated_at`: read the node, take its
`updated_at`, pass it back. The server refuses a body rewrite without it and
tells you the current value. A **409** means someone wrote in between —
re-fetch, **merge** your change onto the current body (the other write may
have added a whole section you do not have), retry with the new timestamp.

Why it is mandatory: a builder agent forgot it once and silently replaced a
reviewer's notes and a planner's sign-off that had landed on the same node
minutes earlier. The only trace was an unfamiliar `previous_block_ids` in the
response; the text came back from `list_changes({ node_id })`'s
before-snapshots. Metadata patches (`title`, `status`, `tag_ids`) touch no
prose and need no timestamp. To flip one checkbox use
`nodes_write({ op: "toggle_checklist_item" })` — one call, no
read-modify-write. To add a section use `nodes_write({ op: "append",
heading, body_md })`, and to rewrite one section `op: "replace_block"`
with its `block_id`: two agents editing different blocks both land, and a
409 only means the *same* block changed under you.

## Archive what is finished or abandoned

`status: "archived"` is cleanup, not deletion: the task leaves every view,
board, graph and `nodes({ op: "list" })` — but stays readable by id
(`nodes({ op: "get" })`), linked, cited and searchable, and any other status
brings it back. Tasks are created for a piece of work and then just exist;
archive them once the work is done or dropped so live views stay about live
work. `nodes({ op: "list", status: "archived" })` (or `include_archived:
true`) shows the shelf; an archived blocker no longer blocks. A task left in
`done` for 30 days without changes is archived automatically.

## A task is one node; its steps are subtasks

Do not split one piece of work into `phase 1 / phase 2 / phase 3` task nodes.
The graph is for meaningful units — a task someone can pick up, block on, or
finish — and five half-tasks give every reader five reads and every planner
five statuses to reconcile. The steps to finish a task are its **subtasks**:
they live on the task (`data.subtasks`), never in the graph, and one
`nodes({ op: "get" })` returns the task with all of them, in full.

- **Create them with the task**, in the same call:
  `nodes_write({ op: "create", kind: "task", title, content_md, subtasks: [
  { title, summary, content_md }, … ] })`. Each subtask has a `title`, a
  one-line `summary` (what the card shows — you write it, with the context
  you have now; the server never generates one) and a full `content_md`
  (what opening the card shows). Order is the array order.
- **Edit one step, not the task.** `subtasks_write({ op, node_id, … })`:
  `add` (title, summary, content_md, optional `position`), `update` (`id`,
  `patch`), `delete` (`id`), `toggle` (`id`, optional `done` — omit to flip),
  `reorder` (`ids` = the full order, or `id` + `position`). Every op costs
  one small call and never touches the task's body or `updated_at` guard
  logic on your side: omit `if_updated_at` and a lost race is retried for
  you; pass it and a mismatch is a 409.
- **Read cheaply.** `subtasks({ op: "list", node_id })` returns cards
  (id, title, summary, done) and progress; `subtasks({ op: "get", node_id,
  id })` returns one with its `content_md`. Ids are short (`s3kd9a2`) so
  that addressing a step costs fewer tokens than describing it.
- **Mark progress as you go.** Toggling a subtask is how humans on the board
  and other agents see where the task is; the task's own `status` moves to
  `done` when the last step does — that part is still yours to set.
- Subtasks are for `task` and `bug` nodes. A doc's checklist stays a
  `- [ ]` list in its body (`toggle_checklist_item`).

## Views are for the team

`views_write({ op: "create" })` defaults to `visibility: "workspace"`. The view
`query` is a versioned object (`schema_version: 1`, `kinds`, `statuses`,
`tags_any`/`tags_all`, `dates`, `source`, `actor`…) — the same contract
`ask_rag`'s `scope` and `views(op=query)` use, and **not** the same field
names as `nodes(op=list)` (`kinds` vs `kind`). Today the view query cannot
express `unblocked`; a view of "what can start now" is an approximation
(`statuses: ["todo"]`) — say so in the view's `description`, and point at
`nodes(op=list, unblocked: true)` for the real answer.

## Retrieval scope, explicitly

`nodes(op=search)` and `ask_rag` default to the whole workspace. When the
question is local, pass `scope` as an object:

```json
{ "schema_version": 1, "type": "view", "view_id": "<id>" }
{ "schema_version": 1, "type": "tags", "tags_any": ["billing", "vat"] }
{ "schema_version": 1, "type": "selection", "node_ids": ["<id>", "<id>"] }
{ "schema_version": 1, "type": "neighborhood", "node_id": "<id>", "depth": 1 }
```

Scopes filter before retrieval; `broad: true` lets graph expansion reach
outside the set and marks those hits `outside_scope`. `auto` always keeps a
visible workspace lane — never describe it as a permission boundary. Every
hit carries a paste-ready `ref` (`/n/<id>#<block>`); follow it with
`nodes(op=get)` before acting on a claim. New content is searchable after
~15 s (async embedding); direct reads see it at once.

## Who did what

`list_changes` gives millisecond timestamps, before/after snapshots, and an
`actor_label` — today a hash of the principal, not a name, so two agents
starting together are told apart by the shape of what they wrote until a
second id appears. Write your role and intent into `## Status` sections; it
is what the next reader will use.

## Goals: what the workspace is aiming at

A `goal` node is an objective, and the workspace has three levels of them.
The **North Star** is one per workspace, holds the mission, cannot be
deleted, and never expires. Under it hang **company goals**; under those,
**project goals**. `goals` returns that tree with each objective's status,
progress and pace; read it when you need to know whether the task in front
of you is worth doing at all.

**Scope is decided once, when the goal is created, and then it is a fact.**
A goal created with no parent and nothing it contributes to is a company
goal, parented to the North Star. Tagging it later does not demote it —
tags say what a node is about, never how important it is. Creating or
editing a company goal or the North Star needs the `goals:write` verb,
which an admin grants; project goals go under the ordinary `write`.

**Goal statuses are a different vocabulary** — `on_track`, `at_risk`,
`off_track`, `achieved`, `missed`, `abandoned`. An objective does not move
backlog → done, and it never earns a column on the task board.

**Report progress with `goals_write({ op: "checkin" })`.** It moves one key
result and stamps the review in a single call: no body rewrite, no
`if_updated_at`, no lost-update race with whoever else is in that node.
Reaching for `nodes_write` to edit `data.key_results` by hand is the wrong
tool and will eventually clobber someone.

**`contributes_to` is how work reaches an objective**, and unlike
`parent_id` it admits several targets — one task can genuinely push
retention and infra cost at once. Link it (`links_write({ from_id: TASK,
to_id: GOAL, relation: "contributes_to" })`) instead of writing "this is
for the Q1 goal" in prose: the edge is what puts the task in front of the
next agent, and the sentence is not.

**Write the horizon however you have it.** A cycle (`"2027-Q1"`) or two
dates — both are stored as a range, because a cycle *is* a range. The end
lives in the node's `due_date`.

**The Roadmap is the goals seen as a grid**, and `views({ op: "resolve" })`
on the system `roadmap` view returns it computed: goals as rows in tree
order, `now` / `next` / `later` as columns, and the tasks that
`contributes_to` each goal as cards, each with the reason it sits where it
sits (status, priority, open blockers). The column is a rule, not a field:
to move a card, change the node — its status, its priority, its edges —
never the view. A task in the `unassigned` row is one nobody linked to an
objective; if you know which goal it serves, that link is worth adding.

## Credentials: one node, one credential — and you will never see the value

A `credential` node holds exactly one credential. Two platforms are two
nodes; the same platform in dev and in prod is two nodes, told apart by
`environment`; two keys for the same platform and environment are two nodes,
told apart by their title. A node that holds six platforms' secrets cannot be
rotated, shared or referenced, and turns "we leaked the Stripe key" into "we
leaked everything".

Write one like this — never a secret in `content_md`, never in a title:

```json
{ "op": "update", "id": "<node>", "patch": { "data": {
  "credential": { "schema_version": 1, "type": "api_key", "environment": "prod", "service": "Stripe" },
  "fields": [{ "key": "api_key", "name": "API key", "value": "…", "secret": true }] } } }
```

`type` is one of `api_key`, `api_key_pair` (public + secret), `basic_auth`,
`bearer_token`, `oauth2_client`, `cloud_keys`, `database`, `ssh_key`,
`service_account`, `webhook` — or `custom`, which is the edge case, not the
default. `environment` is `local`, `dev`, `staging` or `prod`. Tags classify
them like any other node.

Reading one gives you its shape — type, environment, which fields exist,
which are secret, and each field's `bx://credential/<node>#<field>` reference
— with every value `[redacted]`, and credentials never appear in search or
retrieval. That is not distrust: everything you read is written to your
client's transcript, replayed to the model provider on every later turn, and
often summarised into a log, so a secret you read is a secret copied where
nobody rotates it.

To USE one, follow the `credential_use` recipe on the node: materialise the
value inside the command that consumes it and never print it.

```bash
STRIPE_SECRET_KEY=$(curl -sS -H "Authorization: Bearer $BCONTEXT_MCP_TOKEN" \
  "$BCONTEXT_API/api/credentials/<node>/materialize?workspace=<ws>&field=secret_key") \
  node scripts/charge.js
```

Needs the `credentials:use` scope, which `admin:*` does not grant. Never
echo, cat or paste a materialised value, and never copy one into a node, a
commit, a PR or a message.

## What to leave out

Raw JSON you paged through to reconstruct a timeline, and observations about
the tool itself ("I made a concurrency mistake"), do not belong in the
workspace: they are process, not the team's knowledge. Put them in your
report, not in a node.

## Misc contracts

- Deletion is irreversible and cascades to descendants; inspect
  `nodes(op=get)` first.
- `nodes_write({ op: "attach_file" })` for screenshots (png/jpeg/webp/gif
  ≤ 4 MB); embed the returned URL as markdown.
- Errors are written to be read: they name the offending key, list the valid
  options, or carry the recovery recipe. Read them before retrying.

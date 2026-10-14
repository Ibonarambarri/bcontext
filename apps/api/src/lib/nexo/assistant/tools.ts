/**
 * The tools Nexo runs with.
 *
 * Three families:
 *
 *   read     find and read — `search_nodes` is the workhorse, because Nexo no
 *            longer gets the workspace in its prompt.
 *   write    change the graph. Every one returns `NexoWriteResult`, and body
 *            edits carry `before` so the client can offer a single undo.
 *   client   `open_node` / `open_view` — no server effect at all. The browser
 *            reads the `tool-call` off the stream and moves the user.
 *
 * Every tool binds to one scoped `Storage`, so the caller's grants are the
 * boundary: a node out of reach reads as "not found", and a write without the
 * verb comes back as a tool error the model can explain, never a silent pass.
 */
import { tool } from "ai";
import { z } from "zod";
import { log } from "@bcontext-dev/contract/log";
import { extractBlocks } from "@bcontext-dev/contract/rag/chunk";
import { resolveBlockReference } from "@bcontext-dev/contract/backlinks";
import {
  SubtaskDraftSchema,
  SUBTASK_LIMITS,
  subtasksFromDrafts,
} from "@bcontext-dev/contract/subtasks";
import {
  NEXO_MAX_ASK_OPTIONS,
  NEXO_UNDO_MAX_CHARS,
  type NexoWriteResult,
} from "@bcontext-dev/contract/nexo/assistant";
import type { NodeKind } from "@bcontext-dev/contract/types";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import { skeletonFor } from "@/lib/templates/kind-skeletons";
import { record as recordActivity } from "@/lib/activity";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { refForHit, retrieveScoped } from "@/lib/rag";
import type { Storage } from "@/lib/storage";

/** Kinds Nexo may create. `credential` is deliberately absent — secrets are not chat work. */
const CREATABLE_KINDS = [
  "doc",
  "task",
  "decision",
  "meeting",
  "bug",
  "adr",
  "entity",
] as const satisfies readonly NodeKind[];

/** Kinds whose steps live in `data.subtasks`. */
const SUBTASK_KINDS = new Set<string>(["task", "bug"]);

/** Typed edges Nexo may create — same vocabulary the MCP `links_write` uses. */
const EDGE_RELATIONS = [
  "blocked_by",
  "references",
  "caused_by",
  "relates_to",
  "supersedes",
] as const;

const NODE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
  "archived",
] as const;

const PRIORITIES = ["low", "med", "high", "urgent"] as const;

export interface NexoToolDeps {
  /** The caller's storage, already narrowed to their grant. Never a system one. */
  storage: Storage;
  /** `<org>/<workspace>` — what retrieval and the activity feed are keyed by. */
  workspaceRef: string;
  viewPrincipal?: ViewPrincipal;
  actorId?: string | null;
}

/**
 * The chat assistant's tool set, bound to the caller's scoped storage so every
 * read and write obeys the same reach as the MCP tools. Built per request.
 */
export function buildNexoTools(deps: NexoToolDeps) {
  const { storage, workspaceRef, viewPrincipal, actorId } = deps;

  // Realtime fan-out. Nexo is an agent surface like MCP: when it writes, every
  // connected tree must refresh live. Fire-and-forget — a Realtime hiccup can
  // never break a tool call.
  const broadcastUpdated = (nodeId: string): void => {
    if (storage.backend !== "supabase") return;
    void wsBroadcast.nodeUpdated(storage.workspace.id, nodeId);
  };
  const broadcastCreated = (nodeId: string): void => {
    if (storage.backend !== "supabase") return;
    void wsBroadcast.nodeCreated(storage.workspace.id, nodeId);
  };
  const broadcastBacklink = (targetId: string, sourceId: string): void => {
    if (storage.backend !== "supabase") return;
    void wsBroadcast.backlinkChanged(storage.workspace.id, targetId, sourceId);
  };

  /**
   * Nexo's writes belong in Changes like anyone else's — the old chat wrote
   * silently, which meant a body could change with no trace of who did it.
   */
  const trace = (
    kind: "create" | "update",
    nodeId: string,
    title: string,
    summary: string,
  ): void => {
    recordActivity(workspaceRef, kind, nodeId, title, summary, {
      actorKind: "agent",
      actorId: actorId ?? null,
      principalLabel: "Nexo",
    });
  };

  /** Body worth carrying back for undo, or null when it is too big to be worth it. */
  const undoable = (body: string | null | undefined): string | null =>
    typeof body === "string" && body.length <= NEXO_UNDO_MAX_CHARS ? body : null;

  const failed = (err: unknown): NexoWriteResult => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });

  return {
    // -- Finding ------------------------------------------------------------

    search_nodes: tool({
      description:
        "Search the workspace semantically. This is how you find things: the prompt only carries a small map of what is near the user, so anything the user describes rather than names starts here. Returns one hit per node with its matching blocks and a `/n/<id>#<block>` ref you can pass straight to read_block or open_node.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(2_000)
          .describe(
            "What to look for, in natural language. Describe the topic, not the expected title.",
          ),
        kinds: z
          .array(z.enum(["doc", "task", "decision", "meeting", "bug", "adr", "entity", "skill", "data"]))
          .max(9)
          .optional()
          .describe("Restrict to these node kinds. Omit to search everything."),
        k: z.number().int().min(1).max(15).default(6),
      }),
      execute: async ({ query, kinds, k }) => {
        try {
          const result = await retrieveScoped(workspaceRef, query, {
            k,
            storage,
            viewPrincipal,
            kinds: kinds as NodeKind[] | undefined,
          });
          log.info("nexo.search_nodes", {
            workspace: workspaceRef,
            hits: result.hits.length,
          });
          return {
            ok: true,
            hits: result.hits.map((hit) => ({
              ref: refForHit(hit),
              node_id: hit.node_id,
              title: hit.title,
              kind: hit.kind,
              block_id: hit.block_id,
              stale: hit.stale ?? false,
              superseded_by: hit.superseded_by ?? null,
              snippet: hit.content.slice(0, 600),
            })),
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    list_nodes: tool({
      description:
        "List nodes by kind, status or tag, for set questions (\"my open tasks\", \"every decision about pricing\"), not topic questions. Returns titles and ids only, no bodies. Use search_nodes when the user describes content instead of a filter.",
      inputSchema: z.object({
        kind: z.enum(["doc", "task", "decision", "meeting", "bug", "adr", "entity", "skill", "data"]).optional(),
        status: z.enum(NODE_STATUSES).optional(),
        tag_slugs: z.array(z.string().min(1).max(120)).max(10).optional(),
        limit: z.number().int().min(1).max(100).default(40),
      }),
      execute: async ({ kind, status, tag_slugs, limit }) => {
        try {
          const rows = await storage.listNodeSummaries({
            limit: 400,
            tagSlugs: tag_slugs,
            tagsMatch: "all",
          });
          const filtered = rows
            .filter((n) => (kind ? n.kind === kind : true))
            // Archived nodes are cleanup, not content: they stay out unless asked for.
            .filter((n) => (status ? n.status === status : n.status !== "archived"))
            .slice(0, limit);
          return {
            ok: true,
            count: filtered.length,
            nodes: filtered.map((n) => ({
              id: n.id,
              title: n.title,
              kind: n.kind,
              status: n.status,
              priority: n.priority,
              tags: n.tags?.map((t) => t.name) ?? [],
            })),
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    list_tags: tool({
      description:
        "The workspace tag taxonomy with stable ids and usage counts. Call this before creating or re-tagging a node so you classify with tags that already exist instead of inventing new vocabulary.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tags = await storage.listTags();
          const usage = await storage.countTagUsage().catch(() => new Map<string, number>());
          return {
            ok: true,
            tags: tags.map((t) => ({
              id: t.id,
              name: t.name,
              slug: t.slug,
              description: t.description,
              nodes: usage.get(t.id) ?? 0,
            })),
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    read_node: tool({
      description:
        "Read the full markdown body of a node by id (bare id, no `/n/` prefix). Read before you write, and read when the user asks about the content. Do not read a node just to describe it: the search hit and the nearby map already say what it is, and the user can open it. The body of the node the user has open is already in your prompt; do not re-read it unless you have edited it.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
      }),
      execute: async ({ node_id }) => {
        const node = await storage.getNode(stripPrefix(node_id));
        if (!node) return { ok: false, error: "node not found" };
        log.info("nexo.read_node", { workspace: workspaceRef, nodeId: node.id });
        return {
          ok: true,
          id: node.id,
          title: node.title,
          kind: node.kind,
          tags: node.tags,
          status: node.status,
          parent_id: node.parent_id,
          content_md: node.content_md,
        };
      },
    }),

    read_block: tool({
      description:
        "Read one H2 block of a node, ~5× cheaper than read_node when you already know the block id (from a search hit's ref or the nearby-graph `blocks:[…]` suffix). Pass the block id without the leading `#`.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
        block_id: z.string().min(1).max(200),
      }),
      execute: async ({ node_id, block_id }) => {
        const id = stripPrefix(node_id);
        const blockId = stripBlockHash(block_id);
        const node = await storage.getNode(id);
        if (!node) return { ok: false, error: "node not found" };
        const md = node.content_md ?? "";
        const blocks = extractBlocks(md);
        const match = blocks.find((b) => b.block_id === blockId);
        if (match) {
          log.info("nexo.read_block", {
            workspace: workspaceRef,
            nodeId: id,
            blockId,
            chars: match.body_md.length,
          });
          return {
            ok: true,
            id,
            block_id: match.block_id,
            heading: match.heading,
            body_md: match.body_md,
          };
        }
        // Not in the document today — say whether it was renamed, so the model
        // retries with the new id instead of concluding the content is gone.
        const resolved = resolveBlockReference(
          { content_md: md, data: node.data },
          blockId,
        );
        const currentIds = blocks.map((b) => `#${b.block_id}`).join(", ");
        return {
          ok: false,
          error:
            resolved.found === "previous"
              ? `block "${blockId}" was renamed; current blocks: [${currentIds}]`
              : `block not found; current blocks: [${currentIds}]`,
        };
      },
    }),

    // -- Writing ------------------------------------------------------------

    edit_node: tool({
      description:
        "Replace the entire markdown body of a node. Use only for wholesale rewrites or when the change touches most of the document; otherwise prefer replace_in_block. Pass the FULL new markdown; anything you omit is deleted. Always read first.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
        new_content_md: z.string().min(1).max(100_000),
        change_summary: z.string().min(1).max(240),
      }),
      execute: async ({ node_id, new_content_md, change_summary }): Promise<NexoWriteResult> => {
        try {
          const id = stripPrefix(node_id);
          const before = await storage.getNode(id);
          if (!before) return { ok: false, error: "node not found" };
          const updated = await storage.updateNode(id, {
            content_md: new_content_md,
          });
          if (!updated) return { ok: false, error: "node not found" };
          broadcastUpdated(id);
          trace("update", id, updated.title, change_summary);
          log.info("nexo.edit_node", {
            workspace: workspaceRef,
            nodeId: id,
            chars: new_content_md.length,
          });
          return {
            ok: true,
            id,
            title: updated.title,
            kind: updated.kind,
            before: undoable(before.content_md),
            summary: change_summary,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    replace_in_node: tool({
      description:
        "Find an exact substring in a node's markdown and replace it. The surgical edit: use it for a sentence, a paragraph, or the user's selected text. `find` must match verbatim and appear exactly once; add surrounding context to disambiguate. An empty `replace` deletes the match.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
        find: z.string().min(1).max(8_000),
        replace: z.string().max(20_000),
        change_summary: z.string().min(1).max(240),
      }),
      execute: async ({ node_id, find, replace, change_summary }): Promise<NexoWriteResult> => {
        try {
          const id = stripPrefix(node_id);
          const node = await storage.getNode(id);
          if (!node) return { ok: false, error: "node not found" };
          const md = node.content_md ?? "";
          const spliced = spliceUnique(md, find, replace);
          if ("error" in spliced) return { ok: false, error: spliced.error };
          const updated = await storage.updateNode(id, { content_md: spliced.next });
          if (!updated) return { ok: false, error: "node not found" };
          broadcastUpdated(id);
          trace("update", id, updated.title, change_summary);
          log.info("nexo.replace_in_node", {
            workspace: workspaceRef,
            nodeId: id,
            findLen: find.length,
            replaceLen: replace.length,
          });
          return {
            ok: true,
            id,
            title: updated.title,
            kind: updated.kind,
            before: undoable(md),
            summary: change_summary,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    replace_in_block: tool({
      description:
        "Find an exact substring inside one H2 block and replace it. Cheaper and safer than replace_in_node: `find` only has to be unique inside that block. Does NOT fall back: if the string is missing or ambiguous, fix the arguments or escalate yourself.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
        block_id: z.string().min(1).max(200),
        find: z.string().min(1).max(8_000),
        replace: z.string().max(20_000),
        change_summary: z.string().min(1).max(240),
      }),
      execute: async ({
        node_id,
        block_id,
        find,
        replace,
        change_summary,
      }): Promise<NexoWriteResult> => {
        try {
          const id = stripPrefix(node_id);
          const blockId = stripBlockHash(block_id);
          const node = await storage.getNode(id);
          if (!node) return { ok: false, error: "node not found" };
          const md = node.content_md ?? "";
          const blocks = extractBlocks(md);
          const match = blocks.find((b) => b.block_id === blockId);
          if (!match) {
            const resolved = resolveBlockReference(
              { content_md: md, data: node.data },
              blockId,
            );
            const currentIds = blocks.map((b) => `#${b.block_id}`).join(", ");
            return {
              ok: false,
              error:
                resolved.found === "previous"
                  ? "block was renamed; read_block again with the new id"
                  : `block not found; current blocks: [${currentIds}]`,
            };
          }
          const spliced = spliceUnique(match.body_md, find, replace);
          if ("error" in spliced) return { ok: false, error: spliced.error };
          // Pure offset splice — never indexOf on the parent doc, since the
          // same text can appear under a duplicate H2 elsewhere.
          const next = md.slice(0, match.start) + spliced.next + md.slice(match.end);
          const updated = await storage.updateNode(id, { content_md: next });
          if (!updated) return { ok: false, error: "node not found" };
          broadcastUpdated(id);
          trace("update", id, updated.title, change_summary);
          log.info("nexo.replace_in_block", {
            workspace: workspaceRef,
            nodeId: id,
            blockId,
            findLen: find.length,
            replaceLen: replace.length,
          });
          return {
            ok: true,
            id,
            title: updated.title,
            kind: updated.kind,
            before: undoable(md),
            summary: change_summary,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    create_node: tool({
      description:
        "Create a node. Pick the kind by what the thing IS: a choice with consequences is a `decision`, work to be done is a `task`, reference material is a `doc`, a person/company/product is an `entity`. Call list_tags first and classify with existing tag ids. Write the body as H2 sections. A task's steps go in `subtasks` here, never as separate task nodes. Titles are plain names: no codes, no dash explainers.",
      inputSchema: z.object({
        kind: z.enum(CREATABLE_KINDS),
        title: z.string().min(1).max(200),
        content_md: z
          .string()
          .max(100_000)
          .optional()
          .describe("Body in markdown, organised in `##` sections. Omit for a kind skeleton."),
        parent_id: z
          .string()
          .max(200)
          .nullish()
          .describe("Only for real hierarchy, not folders or categories."),
        tag_ids: z.array(z.string().min(1).max(200)).max(12).optional(),
        status: z.enum(NODE_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        subtasks: z
          .array(SubtaskDraftSchema)
          .max(SUBTASK_LIMITS.count)
          .optional()
          .describe("Steps of a task or bug: title, one-line summary, and content_md each."),
      }),
      execute: async (input): Promise<NexoWriteResult> => {
        try {
          if (input.subtasks?.length && !SUBTASK_KINDS.has(input.kind)) {
            return {
              ok: false,
              error: `subtasks belong to task or bug nodes, not a ${input.kind}; put steps in the body as \`- [ ]\` items`,
            };
          }
          const node = await storage.createNode({
            title: input.title,
            kind: input.kind,
            parent_id: input.parent_id ?? null,
            content_md: skeletonFor(input.kind, input.content_md),
            ...(input.subtasks?.length
              ? { data: { subtasks: subtasksFromDrafts(input.subtasks) } }
              : {}),
            // A status-less task is invisible to every unblocked/status sweep,
            // so actionable kinds default to todo rather than nothing.
            status:
              input.status ??
              (input.kind === "task" || input.kind === "bug" ? "todo" : null),
            priority: input.priority ?? null,
            tag_ids: input.tag_ids,
          });
          broadcastCreated(node.id);
          trace("create", node.id, node.title, `created ${node.kind}`);
          log.info("nexo.create_node", {
            workspace: workspaceRef,
            nodeId: node.id,
            kind: node.kind,
          });
          return {
            ok: true,
            id: node.id,
            title: node.title,
            kind: node.kind,
            created: true,
            summary: `created ${node.kind} "${node.title}"`,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    update_node_meta: tool({
      description:
        "Change a node's metadata without touching its body: title, status, priority, parent, tags. This is how you move a task across a board. Only the fields you pass are changed; `tag_ids` REPLACES the whole tag set, so read the node first if you mean to add one.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
        title: z.string().min(1).max(200).optional(),
        status: z.enum(NODE_STATUSES).nullish(),
        priority: z.enum(PRIORITIES).nullish(),
        parent_id: z.string().max(200).nullish(),
        tag_ids: z.array(z.string().min(1).max(200)).max(12).optional(),
        change_summary: z.string().min(1).max(240),
      }),
      execute: async (input): Promise<NexoWriteResult> => {
        try {
          const id = stripPrefix(input.node_id);
          const patch: Record<string, unknown> = {};
          if (input.title !== undefined) patch.title = input.title;
          if (input.status !== undefined) patch.status = input.status;
          if (input.priority !== undefined) patch.priority = input.priority;
          if (input.parent_id !== undefined) {
            patch.parent_id = input.parent_id ? stripPrefix(input.parent_id) : null;
          }
          if (Object.keys(patch).length === 0 && !input.tag_ids) {
            return { ok: false, error: "nothing to update" };
          }
          const updated =
            Object.keys(patch).length > 0
              ? await storage.updateNode(id, patch)
              : await storage.getNode(id);
          if (!updated) return { ok: false, error: "node not found" };
          if (input.tag_ids) await storage.setNodeTags(id, input.tag_ids);
          broadcastUpdated(id);
          trace("update", id, updated.title, input.change_summary);
          log.info("nexo.update_node_meta", {
            workspace: workspaceRef,
            nodeId: id,
            fields: Object.keys(patch),
          });
          // Metadata changes carry no `before`: undo here would mean restoring
          // a set of fields, which the interface already lets the user do.
          return {
            ok: true,
            id,
            title: updated.title,
            kind: updated.kind,
            summary: input.change_summary,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    link_nodes: tool({
      description:
        "Create a typed edge between two nodes: `blocked_by` (from waits on to), `supersedes` (from replaces to; the older one stays, flagged), `caused_by`, `relates_to`, `references`. Use this for real structure; use add_reference for a plain mention. Idempotent.",
      inputSchema: z.object({
        from_node_id: z.string().min(1).max(200),
        to_node_id: z.string().min(1).max(200),
        relation: z.enum(EDGE_RELATIONS),
        reason: z.string().min(1).max(240),
      }),
      execute: async ({ from_node_id, to_node_id, relation, reason }): Promise<NexoWriteResult> => {
        try {
          const fromId = stripPrefix(from_node_id);
          const toId = stripPrefix(to_node_id);
          if (fromId === toId) return { ok: false, error: "cannot link a node to itself" };
          const from = await storage.getNode(fromId);
          if (!from) return { ok: false, error: "from node not found" };
          const to = await storage.getNode(toId);
          if (!to) return { ok: false, error: "to node not found" };
          await storage.createEdge({ from_node: fromId, to_node: toId, relation });
          broadcastUpdated(fromId);
          broadcastUpdated(toId);
          trace("update", fromId, from.title, `${relation} → ${to.title}`);
          log.info("nexo.link_nodes", {
            workspace: workspaceRef,
            from: fromId,
            to: toId,
            relation,
          });
          return {
            ok: true,
            id: fromId,
            title: from.title,
            summary: `${from.title} ${relation} ${to.title} — ${reason}`,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    add_reference: tool({
      description:
        "Record that one node mentions another, so they read as connected in the graph. Stored in the source's `data.mentions[]`, separate from the body. Pass `to_block_id` (no `#`) when the connection is to one specific section. Do not fake a link by typing `/n/<id>` into prose.",
      inputSchema: z.object({
        from_node_id: z.string().min(1).max(200),
        to_node_id: z.string().min(1).max(200),
        to_block_id: z.string().min(1).max(200).optional(),
        reason: z.string().min(1).max(240),
      }),
      execute: async ({ from_node_id, to_node_id, to_block_id, reason }): Promise<NexoWriteResult> => {
        try {
          const fromId = stripPrefix(from_node_id);
          const toId = stripPrefix(to_node_id);
          const toBlockId = to_block_id ? stripBlockHash(to_block_id) : null;
          if (fromId === toId) {
            return { ok: false, error: "cannot reference a node to itself" };
          }
          const source = await storage.getNode(fromId);
          if (!source) return { ok: false, error: "from node not found" };
          const target = await storage.getNode(toId);
          if (!target) return { ok: false, error: "to node not found" };
          const records = readMentionList(source.data);
          // Dedupe on (id, block_id): two distinct blocks of the same node are
          // two independent mentions.
          const exists = records.some(
            (r) => r.id === toId && (r.block_id ?? null) === toBlockId,
          );
          if (exists) {
            return { ok: true, id: fromId, summary: "already referenced" };
          }
          const nextData = {
            ...(source.data ?? {}),
            mentions: serializeMentions([
              ...records,
              { id: toId, block_id: toBlockId },
            ]),
          };
          await storage.updateNode(fromId, { data: nextData });
          broadcastUpdated(fromId);
          broadcastBacklink(toId, fromId);
          trace("update", fromId, source.title, `referenced ${target.title}`);
          log.info("nexo.add_reference", {
            workspace: workspaceRef,
            from: fromId,
            to: toId,
            blockId: toBlockId,
          });
          return {
            ok: true,
            id: fromId,
            title: source.title,
            summary: `${source.title} → ${target.title}${toBlockId ? `#${toBlockId}` : ""} — ${reason}`,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    remove_reference: tool({
      description:
        "Remove an explicit reference added by add_reference. With `to_block_id` only that block-specific mention goes; without it, every mention pointing at the target node goes. Does not touch links written into the markdown body.",
      inputSchema: z.object({
        from_node_id: z.string().min(1).max(200),
        to_node_id: z.string().min(1).max(200),
        to_block_id: z.string().min(1).max(200).optional(),
        reason: z.string().min(1).max(240),
      }),
      execute: async ({ from_node_id, to_node_id, to_block_id, reason }): Promise<NexoWriteResult> => {
        try {
          const fromId = stripPrefix(from_node_id);
          const toId = stripPrefix(to_node_id);
          const toBlockId = to_block_id ? stripBlockHash(to_block_id) : null;
          const source = await storage.getNode(fromId);
          if (!source) return { ok: false, error: "from node not found" };
          const records = readMentionList(source.data);
          const next = records.filter((r) => {
            if (r.id !== toId) return true;
            if (toBlockId === null) return false;
            return (r.block_id ?? null) !== toBlockId;
          });
          if (next.length === records.length) {
            return { ok: true, id: fromId, summary: "no explicit reference to remove" };
          }
          const nextData = {
            ...(source.data ?? {}),
            mentions: serializeMentions(next),
          };
          await storage.updateNode(fromId, { data: nextData });
          broadcastUpdated(fromId);
          broadcastBacklink(toId, fromId);
          trace("update", fromId, source.title, `unlinked ${toId}`);
          log.info("nexo.remove_reference", {
            workspace: workspaceRef,
            from: fromId,
            to: toId,
            blockId: toBlockId,
          });
          return {
            ok: true,
            id: fromId,
            title: source.title,
            summary: `unlinked ${fromId} → ${toId}${toBlockId ? `#${toBlockId}` : ""} — ${reason}`,
          };
        } catch (err) {
          return failed(err);
        }
      },
    }),

    // -- Driving the app ----------------------------------------------------
    //
    // These two do nothing here on purpose. The browser is watching the stream
    // and acts on the `tool-call` line; the server just acknowledges so the
    // model can keep going without waiting for a round-trip.

    open_node: tool({
      description:
        "Open a node in the user's interface, optionally scrolled to one block. Use it when showing beats describing: after finding what they asked for, or before explaining a change. Do not announce it; once it is open, one line about what they are looking at is enough, then ask what they want to know.",
      inputSchema: z.object({
        node_id: z.string().min(1).max(200),
        block_id: z.string().min(1).max(200).nullish(),
      }),
      execute: async ({ node_id, block_id }) => {
        const id = stripPrefix(node_id);
        log.info("nexo.open_node", { workspace: workspaceRef, nodeId: id });
        return {
          ok: true,
          node_id: id,
          block_id: block_id ? stripBlockHash(block_id) : null,
        };
      },
    }),

    ask_user: tool({
      description:
        "Put a choice in front of the user instead of guessing or writing a paragraph of clarification. Use it when two or three readings of the request would lead to genuinely different work: which node they meant, which kind a new node should be, whether to change one thing or all of them. Offer options that are complete answers, in their language, and then say nothing else: the turn ends here and their pick arrives as the next message. Do not use it for yes/no confirmation of something they already asked for.",
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .max(240)
          .describe("The question, in one short line."),
        options: z
          .array(
            z.object({
              label: z
                .string()
                .min(1)
                .max(80)
                .describe("What the button says: a whole answer, not a word."),
            }),
          )
          .min(2)
          .max(NEXO_MAX_ASK_OPTIONS),
      }),
      execute: async ({ question, options }) => {
        log.info("nexo.ask_user", {
          workspace: workspaceRef,
          options: options.length,
        });
        return { ok: true, question, options };
      },
    }),

    open_view: tool({
      description:
        "Switch the user to one of the workspace's views by slug (for example the tasks board or the graph). Only use a slug you have actually seen; never guess one.",
      inputSchema: z.object({
        view_slug: z.string().min(1).max(200),
      }),
      execute: async ({ view_slug }) => {
        log.info("nexo.open_view", { workspace: workspaceRef, view: view_slug });
        return { ok: true, view_slug };
      },
    }),
  };
}

// -- Helpers ------------------------------------------------------------------

/**
 * Replace `find` in `text`, but only when it appears exactly once. Returning
 * the reason on failure matters: the model uses it to widen the context and
 * retry instead of falling back to a full rewrite.
 */
function spliceUnique(
  text: string,
  find: string,
  replace: string,
): { next: string } | { error: string } {
  const idx = text.indexOf(find);
  if (idx === -1) {
    return {
      error:
        "find string not found verbatim; include more surrounding context and retry",
    };
  }
  if (text.indexOf(find, idx + 1) !== -1) {
    return {
      error:
        "find string matched more than once; include more surrounding context so the match is unique",
    };
  }
  return { next: text.slice(0, idx) + replace + text.slice(idx + find.length) };
}

/**
 * The model sees `/n/<id>` everywhere it looks, so it passes that form to
 * tools. Tolerate both rather than failing on a prefix.
 */
function stripPrefix(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("/n/")) return t.slice(3);
  if (t.startsWith("n/")) return t.slice(2);
  return t;
}

/** Same tolerance for the `#vision` form of a block id. */
function stripBlockHash(raw: string): string {
  const t = raw.trim();
  return t.startsWith("#") ? t.slice(1) : t;
}

interface MentionRecord {
  id: string;
  block_id: string | null;
}

/**
 * Read `data.mentions`, tolerating both the legacy bare-string shape and the
 * `{ id, block_id }` one. Dedup key is the pair, so a node referenced from two
 * blocks stays as two records.
 */
function readMentionList(
  data: Record<string, unknown> | null | undefined,
): MentionRecord[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as Record<string, unknown>).mentions;
  if (!Array.isArray(raw)) return [];
  const out: MentionRecord[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    let id: string | null = null;
    let block_id: string | null = null;
    if (typeof v === "string") {
      id = v.trim();
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      if (typeof obj.id === "string") id = obj.id.trim();
      if (typeof obj.block_id === "string") {
        const b = obj.block_id.trim();
        block_id = b ? b : null;
      }
    }
    if (!id) continue;
    const key = `${id}#${block_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, block_id });
  }
  return out;
}

/**
 * Back to the JSONB shape. Records without a block id stay plain strings so we
 * don't inflate the column for callers that never used block-level mentions.
 */
function serializeMentions(
  records: MentionRecord[],
): Array<string | { id: string; block_id: string }> {
  return records.map((r) => (r.block_id ? { id: r.id, block_id: r.block_id } : r.id));
}

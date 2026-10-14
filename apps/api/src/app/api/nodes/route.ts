/**
 * The node collection over REST — the web's tree/list and create paths, and
 * the REST twin of MCP `nodes(op=list)` / `nodes_write(op=create)`.
 *
 *   GET  /api/nodes?workspace=…[&tag_id=&tag=&tags_match=&fields=&limit=&cursor=]
 *   POST /api/nodes   { workspace, title, kind, parent_id, …, subtasks?, change_context? }
 *
 * Verbs read / write via `openWorkspace`; the list is what the scoped
 * storage lets the principal see. Creating, like MCP, fans out to the activity feed, the audit log, webhooks and the realtime hub.
 * A goal is the one kind whose create input is rewritten first, so its
 * scope is decided here exactly as MCP decides it.
 */
import { z } from "zod";
import { record as recordActivity } from "@/lib/activity";
import { readJsonBody } from "@/lib/parse-json";
import { openWorkspace } from "@/lib/auth/workspace";
import {
  NodeWriteError,
  TagNotFoundError,
} from "@/lib/storage";
import {
  decodeNodeCursor,
  paginateNodeSummaries,
  parseNodeFieldPreset,
  projectNodeSummary,
  type NodeFieldPreset,
} from "@/lib/node-fields";
import { withRoute } from "@/lib/route";
import { emitEvent } from "@/lib/webhooks/dispatch";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { appendAudit, type ActorType } from "@/lib/audit";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { changePayload } from "@bcontext-dev/contract/changes";
import { SUBTASK_LIMITS, SubtaskDraftSchema, subtasksFromDrafts } from "@bcontext-dev/contract/subtasks";
import { SUBTASK_KINDS } from "@/lib/subtasks";
import { NODE_STATUSES } from "@bcontext-dev/contract/types";
import { goalCreateInput } from "@/lib/goals";

export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const tagIds = new URL(req.url).searchParams.getAll("tag_id").filter(Boolean);
  const tagSlugs = new URL(req.url).searchParams
    .getAll("tag")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const tagsMatch = new URL(req.url).searchParams.get("tags_match") === "all" ? "all" : "any";

  // Optional, backward-compatible read shaping: `fields` picks a per-view
  // preset (see src/lib/node-fields.ts), `limit` + `cursor` page by keyset
  // over the canonical (position, id) ordering. Omitting all three returns
  // the exact same payload as before.
  const fieldsRaw = new URL(req.url).searchParams.get("fields");
  const parsedFields = fieldsRaw !== null ? parseNodeFieldPreset(fieldsRaw) : null;
  if (fieldsRaw !== null && parsedFields === null) {
    return Response.json({ error: "invalid_fields_preset" }, { status: 400 });
  }
  const fields: NodeFieldPreset = parsedFields ?? "summary";
  const limitRaw = new URL(req.url).searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(2000, Number(limitRaw) || 0)) : undefined;
  const cursorRaw = new URL(req.url).searchParams.get("cursor");
  const cursor = cursorRaw ? decodeNodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return Response.json({ error: "invalid_cursor" }, { status: 400 });
  }

  const summaries = await storage.listNodeSummaries({ tagIds, tagSlugs, tagsMatch });
  const paged = limit !== undefined || cursor
    ? paginateNodeSummaries(summaries, { limit, cursor })
    : { items: summaries, next_cursor: null };
  return Response.json({
    nodes: paged.items.map((node) => projectNodeSummary(node, fields)),
    next_cursor: paged.next_cursor,
    fields,
    filters: { tag_ids: tagIds, tags: tagSlugs, tags_match: tagsMatch },
  });
});

const ChangeContextSchema = z.object({
  source: z.string().trim().min(1).max(500).optional(),
  sources: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  references: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  block_id: z.string().trim().min(1).max(200).optional(),
  review: z.object({
    status: z.enum(["pending", "accepted", "rejected"]),
    label: z.string().trim().min(1).max(200),
    review_url: z.string().trim().max(2000).nullable().optional(),
  }).strict().optional(),
}).strict();

const CreateSchema = z.object({
  workspace: z.string().min(1),
  title: z.string().min(1).max(200),
  kind: z.enum([
    "doc",
    "task",
    "decision",
    "meeting",
    "bug",
    "adr",
    "entity",
    "skill",
    "data",
    "credential",
    "goal",
  ]),
  parent_id: z.string().nullable(),
  content_md: z.string().optional(),
  // Both vocabularies: the column is shared, and which one is legal depends
  // on the node's kind, not on the route. `statusLabel` reads either.
  status: z.enum(NODE_STATUSES).nullable().optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  data: z.record(z.unknown()).optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  // Subtasks written by the creator in the same call (see contract/subtasks).
  subtasks: z.array(SubtaskDraftSchema).max(SUBTASK_LIMITS.count).optional(),
  change_context: ChangeContextSchema.optional(),
}).strict();

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { workspace, change_context, subtasks, ...input } = parsed.data;
  if (subtasks && subtasks.length > 0 && !SUBTASK_KINDS.has(input.kind)) {
    return Response.json(
      { error: "subtasks_wrong_kind", message: `subtasks belong to task or bug nodes, not a ${input.kind}` },
      { status: 400 },
    );
  }
  const rest =
    subtasks && subtasks.length > 0
      ? { ...input, data: { ...(input.data ?? {}), subtasks: subtasksFromDrafts(subtasks) } }
      : input;
  const ctx = await openWorkspace(req, workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;

  let node;
  try {
    // Same resolution as MCP: a goal's scope is decided once, here, and a
    // company goal is parented to the North Star. The storage seam then reads
    // that scope to decide whether this write needed `goals:write`.
    node = await storage.createNode(
      rest.kind === "goal" ? await goalCreateInput(storage, rest) : rest,
    );
  } catch (error) {
    if (error instanceof TagNotFoundError) {
      return Response.json(
        { error: "unknown_or_inactive_tag", tag_id: error.tagId },
        { status: 400 },
      );
    }
    if (error instanceof NodeWriteError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
  recordActivity(workspace, "create", node.id, node.title, node.kind, {
    actorKind: gated.kind === "agent" || gated.kind === "agent_user" ? "agent" : "human",
    actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
    principalId: gated.kind === "agent" || gated.kind === "agent_user" ? gated.agentId : null,
    payload: changePayload({
      after: node,
      via: gated.kind === "user" ? "web" : "rest",
      source: change_context?.source,
      sources: change_context?.sources,
      references: change_context?.references,
      blockId: change_context?.block_id,
      review: change_context?.review
        ? { ...change_context.review, review_url: change_context.review.review_url ?? null }
        : null,
    }),
  });
  if (storage.backend === "supabase") {
    const actorType: ActorType =
      gated.kind === "agent" || gated.kind === "agent_user"
        ? "agent"
        : gated.kind === "user"
          ? "user"
          : "demo";
    void appendAudit({
      workspaceId: storage.workspace.id,
      actorType,
      actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
      agentTokenId: gated.kind === "agent" || gated.kind === "agent_user" ? gated.tokenId : null,
      action: "node.create",
      targetType: "node",
      targetId: node.id,
      input: rest,
      output: { id: node.id, kind: node.kind, title: node.title },
    });
    try {
      void emitEvent(getSupabaseAdmin(), {
        workspaceId: storage.workspace.id,
        workspaceSlug: storage.workspace.slug,
        type: "node.created",
        data: {
          id: node.id,
          kind: node.kind,
          title: node.title,
          slug: node.slug,
          parent_id: node.parent_id,
        },
      });
    } catch {
      // emit is best-effort; never break the write path.
    }
    void wsBroadcast.nodeCreated(
      storage.workspace.id,
      node.id,
      gated.kind === "user" ? gated.userId : undefined,
    );
  }
  return Response.json({ node }, { status: 201 });
});

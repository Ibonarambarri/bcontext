/**
 * Agent write endpoint.
 *
 * Lets agents propose changes inside a specific workspace: create new nodes
 * (docs/tasks/decisions), patch existing ones, or batch a small transaction.
 * Always returns the resulting node objects so the agent can verify what
 * landed.
 *
 *   POST /api/agents/write
 *   {
 *     "workspace": "bcontext",
 *     "ops": [
 *       { "op": "create", "node": { ... } },
 *       { "op": "patch",  "id": "xxx", "patch": { ... } }
 *     ]
 *   }
 */
import { z } from "zod";
import { record as recordActivity } from "@/lib/activity";
import { skeletonFor } from "@/lib/templates/kind-skeletons";
import { getIdempotent, setIdempotent } from "@/lib/idempotency";
import { readJsonBody } from "@/lib/parse-json";
import { gate } from "@/lib/auth/require";
import { openWorkspaceForActor } from "@/lib/auth/workspace";
import {
  NodeWriteError,
  TagNotFoundError,
  type UpdateNodePatch,
} from "@/lib/storage";
import { withRoute } from "@/lib/route";
import { emitEvent } from "@/lib/webhooks/dispatch";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { appendAudit, type ActorType } from "@/lib/audit";
import type { WebhookEventType } from "@bcontext-dev/contract/webhooks/events";
import { NODE_STATUSES, type NodeStatus } from "@bcontext-dev/contract/types";
import { goalCreateInput } from "@/lib/goals";
import { changePayload } from "@bcontext-dev/contract/changes";
import { redactCredentialForAgents } from "@/lib/credentials";

const NodeCreate = z.object({
  title: z.string().min(1),
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
  data: z.record(z.unknown()).optional(),
  status: z.string().nullable().optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
}).strict();

const NodePatch = z.object({
  title: z.string().optional(),
  slug: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
  content_md: z.string().optional(),
  // Goal statuses live in the same column; a goal patched here must be able to
  // move on_track → at_risk without a second surface.
  status: z.enum(NODE_STATUSES).nullable().optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  data: z.record(z.unknown()).optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
}).strict();

const ChangeContext = z.object({
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

const Op = z.union([
  z.object({ op: z.literal("create"), node: NodeCreate, change_context: ChangeContext.optional() }),
  z.object({
    op: z.literal("patch"),
    id: z.string(),
    patch: NodePatch,
    // Optimistic-concurrency guard, same contract as PATCH /api/nodes/[id]:
    // mismatch → per-op 409 error instead of last-write-wins. min(1): an
    // empty string must be a validation error, never a dropped guard.
    if_updated_at: z.string().min(1).optional(),
    change_context: ChangeContext.optional(),
  }),
]);

const Schema = z.object({
  workspace: z.string().min(1),
  ops: z.array(Op).max(20),
});

export const POST = withRoute(async (req: Request) => {
  const idemKey = req.headers.get("idempotency-key");

  // Authenticate before reading the body. The workspace lives inside the body,
  // so authentication and authorisation are split: `gate` here, then parse,
  // then `openWorkspaceForActor`. One gate, one rate-limit charge, and an
  // unauthenticated caller cannot get JSON parsed for it — the same shape
  // /api/upload uses.
  const gate0 = await gate(req, "agents:write");
  if (gate0 instanceof Response) return gate0;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;

  const rawWorkspace = (parsedBody.data as { workspace?: unknown } | null)?.workspace;
  if (typeof rawWorkspace !== "string" || rawWorkspace.length === 0) {
    // No workspace means nothing to authorise against, so this 400 is the one
    // response that is *not* recorded idempotently: writing to the cache
    // before authorising would let an unauthenticated caller occupy a key.
    const parsedAnyway = Schema.safeParse(parsedBody.data);
    return Response.json(
      { error: parsedAnyway.success ? { formErrors: [], fieldErrors: {} } : parsedAnyway.error.flatten() },
      { status: 400 },
    );
  }

  const opened = await openWorkspaceForActor(gate0, rawWorkspace, "write");
  if (opened instanceof Response) {
    // Deliberately NOT cached. A 401, 403, 404 or 429 is not a result to
    // replay: the canonical client behaviour after a 429 is to retry with the
    // same Idempotency-Key, and caching it would replay that 429 forever and
    // the write would never happen. Caching a 401 would also let an
    // unauthenticated caller occupy a key.
    return opened;
  }
  const { storage, actor: gated } = opened;

  // Replay is checked after authorisation, not before it. A cached body is a
  // previous caller's response; handing it back on the strength of a header
  // alone would answer a request that was never authorised.
  if (idemKey) {
    const cached = getIdempotent(idemKey);
    if (cached) {
      return Response.json(cached.body, {
        status: cached.status,
        headers: { "Idempotent-Replay": "true" },
      });
    }
  }

  const parsed = Schema.safeParse(parsedBody.data);
  if (!parsed.success) {
    const body = { error: parsed.error.flatten() };
    if (idemKey) setIdempotent(idemKey, 400, body);
    return Response.json(body, { status: 400 });
  }
  const { ops } = parsed.data;
  const workspace = storage.workspace.slug;

  const fireNodeEvent = (
    type: WebhookEventType,
    data: Record<string, unknown>,
  ): void => {
    if (storage.backend !== "supabase") return;
    try {
      void emitEvent(getSupabaseAdmin(), {
        workspaceId: storage.workspace.id,
        workspaceSlug: storage.workspace.slug,
        type,
        data,
      });
    } catch {
      // best-effort
    }
  };

  // Both `agent` (workspace-scoped) and `agent_user` (user-scoped) tokens
  // map to the audit "agent" actor type — they're both bearer-token-driven
  // agent writes. For user-scoped tokens we also fill `actorId` with the
  // user behind the token so the audit row links to a person.
  const actorType: ActorType =
    gated.kind === "agent" || gated.kind === "agent_user"
      ? "agent"
      : gated.kind === "user"
        ? "user"
        : "demo";
  const auditCommon = {
    workspaceId: storage.workspace.id,
    actorType,
    actorId:
      gated.kind === "user"
        ? gated.userId
        : gated.kind === "agent_user"
          ? gated.userId
          : null,
    agentTokenId:
      gated.kind === "agent" || gated.kind === "agent_user"
        ? gated.tokenId
        : null,
  };

  const results: unknown[] = [];
  for (const op of ops) {
    if (op.op === "create") {
      let node;
      try {
        const create = {
          title: op.node.title,
          kind: op.node.kind,
          parent_id: op.node.parent_id,
          // Same per-kind H2 skeleton the MCP surface pre-fills — REST
          // creates must not produce structurally different nodes.
          content_md: skeletonFor(op.node.kind, op.node.content_md),
          data: op.node.data,
          status: (op.node.status as NodeStatus | null | undefined) ?? null,
          priority: op.node.priority ?? null,
          tag_ids: op.node.tag_ids,
        };
        // And the same goal resolution: scope decided once, company goals under
        // the North Star, whichever surface the create came in through.
        node = await storage.createNode(
          create.kind === "goal" ? await goalCreateInput(storage, create) : create,
        );
      } catch (error) {
        if (error instanceof TagNotFoundError) {
          results.push({
            op: "create",
            error: "unknown_or_inactive_tag",
            tag_id: error.tagId,
          });
          continue;
        }
        if (error instanceof NodeWriteError) {
          results.push({
            op: "create",
            error: error.code,
            message: error.message,
          });
          continue;
        }
        throw error;
      }
      recordActivity(workspace, "create", node.id, node.title, node.kind, {
        actorKind: "agent",
        actorId: auditCommon.actorId,
        principalId: gated.kind === "agent" || gated.kind === "agent_user" ? gated.agentId : null,
        payload: changePayload({
          after: node,
          via: "rest",
          source: op.change_context?.source,
          sources: op.change_context?.sources,
          references: op.change_context?.references,
          blockId: op.change_context?.block_id,
          review: op.change_context?.review
            ? { ...op.change_context.review, review_url: op.change_context.review.review_url ?? null }
            : null,
        }),
      });
      if (storage.backend === "supabase") {
        void appendAudit({
          ...auditCommon,
          action: "agent.write.create",
          targetType: "node",
          targetId: node.id,
          input: op.node,
          output: { id: node.id, kind: node.kind, title: node.title },
        });
      }
      fireNodeEvent("node.created", {
        id: node.id,
        kind: node.kind,
        title: node.title,
        slug: node.slug,
        parent_id: node.parent_id,
      });
      // Realtime fan-out: agents create nodes too — collaborators' trees must
      // refresh live, same as a human edit. Awaited so the broadcast POST lands
      // before the response returns (after()/void is dropped on serverless).
      if (storage.backend === "supabase") {
        await wsBroadcast.nodeCreated(storage.workspace.id, node.id);
      }
      results.push({ op: "create", node: redactCredentialForAgents(node) });
    } else {
      const existing = await storage.getNode(op.id);
      if (!existing) {
        results.push({ op: "patch", id: op.id, error: "not found" });
        continue;
      }
      const patch = op.patch as UpdateNodePatch;
      let node;
      try {
        node = await storage.updateNode(op.id, patch, {
          ifUpdatedAt: op.if_updated_at,
        });
      } catch (err) {
        const { ConflictError } = await import("@/lib/storage");
        if (err instanceof ConflictError) {
          results.push({
            op: "patch",
            id: op.id,
            error: "conflict",
            message: err.message,
            current_updated_at: err.currentUpdatedAt,
          });
          continue;
        }
        if (err instanceof TagNotFoundError) {
          results.push({
            op: "patch",
            id: op.id,
            error: "unknown_or_inactive_tag",
            tag_id: err.tagId,
          });
          continue;
        }
        if (err instanceof NodeWriteError) {
          results.push({
            op: "patch",
            id: op.id,
            error: err.code,
            message: err.message,
          });
          continue;
        }
        throw err;
      }
      if (node) {
        recordActivity(
          workspace,
          "update",
          node.id,
          node.title,
          Object.keys(patch).join(", ") || null,
          {
            actorKind: "agent",
            actorId: auditCommon.actorId,
            principalId: gated.kind === "agent" || gated.kind === "agent_user" ? gated.agentId : null,
            payload: changePayload({
              before: existing,
              after: node,
              via: "rest",
              source: op.change_context?.source,
              sources: op.change_context?.sources,
              references: op.change_context?.references,
              blockId: op.change_context?.block_id,
              review: op.change_context?.review
                ? { ...op.change_context.review, review_url: op.change_context.review.review_url ?? null }
                : null,
            }),
          },
        );
        if (storage.backend === "supabase") {
          void appendAudit({
            ...auditCommon,
            action: "agent.write.patch",
            targetType: "node",
            targetId: node.id,
            input: patch,
            output: { id: node.id, changed: Object.keys(patch) },
          });
        }
        fireNodeEvent("node.updated", {
          id: node.id,
          kind: node.kind,
          title: node.title,
          slug: node.slug,
          parent_id: node.parent_id,
          changed: Object.keys(patch),
        });
        // Realtime fan-out: pick the most specific event so the tree refreshes
        // once per kind of change instead of double-firing.
        if (storage.backend === "supabase") {
          const titleChanged =
            typeof patch.title === "string" &&
            patch.title.trim() !== existing.title;
          const parentChanged =
            "parent_id" in patch && patch.parent_id !== existing.parent_id;
          if (titleChanged) {
            await wsBroadcast.nodeRenamed(
              storage.workspace.id,
              node.id,
              node.title,
            );
          } else if (parentChanged) {
            await wsBroadcast.nodeMoved(
              storage.workspace.id,
              node.id,
              node.parent_id,
            );
          } else {
            await wsBroadcast.nodeUpdated(storage.workspace.id, node.id);
          }
        }
      }
      results.push({
        op: "patch",
        node: node ? redactCredentialForAgents(node) : node,
      });
    }
  }

  const body = { results };
  if (idemKey) setIdempotent(idemKey, 200, body);
  return Response.json(body);
});

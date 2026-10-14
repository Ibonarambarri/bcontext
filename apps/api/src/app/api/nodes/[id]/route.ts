/**
 * One node over REST — the web's save path and the REST twin of MCP
 * `nodes(op=get)` / `nodes_write(op=update|delete)`.
 *
 *   GET    /api/nodes/:id?workspace=…
 *   PATCH  /api/nodes/:id     { workspace, if_updated_at?, ...fields, change_context? }
 *   DELETE /api/nodes/:id?workspace=…
 *
 * Verbs read / write / delete via `openWorkspace`. `if_updated_at` is the
 * optimistic lock: a stale value is 409 with `current_updated_at`, never a
 * silent overwrite. A successful write fans out the same way MCP does —
 * activity feed, audit row, webhook event, realtime broadcast to open
 * clients (the most specific event: rename, move or update, plus backlink
 * invalidation for nodes whose mention set changed) — and, fire-and-forget,
 * pushes to the connectors that mirror this node (Linear-linked tasks,
 * GitHub-exported skills).
 */
import { z } from "zod";
import { NODE_STATUSES } from "@bcontext-dev/contract/types";
import { record as recordActivity } from "@/lib/activity";
import { readJsonBody } from "@/lib/parse-json";
import { openWorkspace } from "@/lib/auth/workspace";
import {
  ConflictError,
  NodeWriteError,
  TagNotFoundError,
} from "@/lib/storage";
import type { Storage } from "@/lib/storage";
import { withRoute } from "@/lib/route";
import { emitEvent } from "@/lib/webhooks/dispatch";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { WebhookEventType } from "@bcontext-dev/contract/webhooks/events";
import { syncTaskToLinearIfLinked } from "@/lib/connectors/linear/push";
import { pushSkillExports } from "@/lib/skills/push-to-github";
import { withSkillVersionBump } from "@/lib/skills/version";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { appendAudit, type ActorType } from "@/lib/audit";
import { changePayload } from "@bcontext-dev/contract/changes";

function readMentionIds(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as Record<string, unknown>).mentions;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function fireNodeEvent(
  storage: Storage,
  type: WebhookEventType,
  data: Record<string, unknown>,
): void {
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
}

function getWs(req: Request): string | null {
  return new URL(req.url).searchParams.get("workspace");
}

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const ctx = await openWorkspace(req, getWs(req), "read");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const node = await ctx.storage.getNode(id);
  if (!node) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ node });
});

const PatchSchema = z.object({
  workspace: z.string().min(1),
  // Optimistic-concurrency guard: the updated_at the caller last read.
  // Mismatch → 409 instead of last-write-wins.
  if_updated_at: z.string().min(1).optional(),
  title: z.string().optional(),
  slug: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
  content_md: z.string().optional(),
  // Task statuses and goal statuses share the column; the node's kind decides
  // which vocabulary is meaningful, so the route accepts both.
  status: z.enum(NODE_STATUSES).nullable().optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  data: z.record(z.unknown()).optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  change_context: z.object({
    source: z.string().trim().min(1).max(500).optional(),
    sources: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
    references: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
    block_id: z.string().trim().min(1).max(200).optional(),
    review: z.object({
      status: z.enum(["pending", "accepted", "rejected"]),
      label: z.string().trim().min(1).max(200),
      review_url: z.string().trim().max(2000).nullable().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = PatchSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { workspace, if_updated_at, change_context, ...patch } = parsed.data;
  const ctx = await openWorkspace(req, workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  const before = await storage.getNode(id);
  let node;
  try {
    node = await storage.updateNode(id, withSkillVersionBump(before, patch), {
      ifUpdatedAt: if_updated_at,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      return Response.json(
        {
          error: "conflict",
          message: err.message,
          current_updated_at: err.currentUpdatedAt,
        },
        { status: 409 },
      );
    }
    if (err instanceof TagNotFoundError) {
      return Response.json(
        { error: "unknown_or_inactive_tag", tag_id: err.tagId },
        { status: 400 },
      );
    }
    if (err instanceof NodeWriteError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: 400 },
      );
    }
    throw err;
  }
  if (!node) return Response.json({ error: "not found" }, { status: 404 });

  const titleChanged =
    typeof patch.title === "string" &&
    before !== null &&
    patch.title.trim() !== before.title;
  const slugChanged =
    typeof patch.slug === "string" &&
    before !== null &&
    patch.slug !== before.slug;
  const parentChanged =
    "parent_id" in patch &&
    before !== null &&
    patch.parent_id !== before.parent_id;

  const actor = {
    actorKind:
      gated.kind === "agent" || gated.kind === "agent_user" ? ("agent" as const) : ("human" as const),
    actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
    principalId: gated.kind === "agent" || gated.kind === "agent_user" ? gated.agentId : null,
    payload: changePayload({
      before,
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
  };
  if (titleChanged || slugChanged) {
    const summary =
      before && titleChanged
        ? `${before.title} → ${node.title}`
        : before && slugChanged
          ? `${before.slug} → ${node.slug}`
          : null;
    recordActivity(workspace, "rename", node.id, node.title, summary, actor);
  } else if (parentChanged) {
    recordActivity(
      workspace,
      "move",
      node.id,
      node.title,
      "parent changed",
      actor,
    );
  } else {
    const fields = Object.keys(patch).filter((k) => k !== "workspace");
    recordActivity(
      workspace,
      "update",
      node.id,
      node.title,
      fields.length > 0 ? fields.join(", ") : null,
      actor,
    );
  }
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
      action: titleChanged || slugChanged ? "node.rename" : parentChanged ? "node.move" : "node.update",
      targetType: "node",
      targetId: node.id,
      input: patch,
      output: { id: node.id, changed: Object.keys(patch) },
    });
  }
  fireNodeEvent(storage, "node.updated", {
    id: node.id,
    kind: node.kind,
    title: node.title,
    slug: node.slug,
    parent_id: node.parent_id,
    changed: Object.keys(patch).filter((k) => k !== "workspace"),
  });

  // Realtime fan-out for collaborators. Choose the most specific event so the
  // tree refreshes once per kind of change instead of double-firing.
  if (storage.backend === "supabase") {
    const wsId = storage.workspace.id;
    const from = gated.kind === "user" ? gated.userId : undefined;
    if (titleChanged) {
      void wsBroadcast.nodeRenamed(wsId, node.id, node.title, from);
    } else if (parentChanged) {
      void wsBroadcast.nodeMoved(wsId, node.id, node.parent_id, from);
    } else {
      void wsBroadcast.nodeUpdated(wsId, node.id, from, {
        status: node.status,
        priority: node.priority,
        due_date: node.due_date,
        updated_at: node.updated_at,
        source: typeof node.data?.source === "string" ? node.data.source : null,
      });
    }

    // Backlink invalidation: any node that this update added or removed from
    // the mention set has its inbound-link panel out of date.
    if ("data" in patch && before) {
      const beforeIds = new Set(readMentionIds(before.data));
      const afterIds = new Set(readMentionIds(node.data));
      const affected = new Set<string>();
      for (const id of beforeIds) if (!afterIds.has(id)) affected.add(id);
      for (const id of afterIds) if (!beforeIds.has(id)) affected.add(id);
      for (const targetId of affected) {
        void wsBroadcast.backlinkChanged(wsId, targetId, node.id, from);
      }
    }
  }

  // Linear push-side: fire-and-forget status sync for a task linked to an issue.
  if (storage.backend === "supabase") {
    void syncTaskToLinearIfLinked({
      workspaceId: storage.workspace.id,
      before,
      after: node,
    }).catch(() => {});
  }

  // GitHub push-side: re-sync AGENTS.md when a skill changes.
  if (storage.backend === "supabase" && node.kind === "skill") {
    void pushSkillExports({
      workspaceId: storage.workspace.id,
      workspaceName: storage.workspace.name,
      storage: storage,
    }).catch(() => {});
  }

  return Response.json({ node });
});

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const ctx = await openWorkspace(req, getWs(req), "delete");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  const ws = storage.workspace.slug;
  const { id } = await params;
  const existing = await storage.getNode(id);
  try {
    await storage.deleteNode(id);
  } catch (error) {
    if (error instanceof NodeWriteError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
  recordActivity(
    ws,
    "delete",
    id,
    existing?.title ?? null,
    existing?.kind ?? null,
    {
      actorKind: gated.kind === "agent" || gated.kind === "agent_user" ? "agent" : "human",
      actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
      principalId: gated.kind === "agent" || gated.kind === "agent_user" ? gated.agentId : null,
      payload: changePayload({
        before: existing,
        via: gated.kind === "user" ? "web" : "rest",
      }),
    },
  );
  fireNodeEvent(storage, "node.deleted", {
    id,
    kind: existing?.kind ?? null,
    title: existing?.title ?? null,
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
      action: "node.delete",
      targetType: "node",
      targetId: id,
      input: { id },
      output: { deleted: true },
    });
    void wsBroadcast.nodeDeleted(
      storage.workspace.id,
      id,
      gated.kind === "user" ? gated.userId : undefined,
    );
  }
  return Response.json({ ok: true });
});

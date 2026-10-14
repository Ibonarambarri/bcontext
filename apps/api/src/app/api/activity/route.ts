/**
 * GET /api/activity?workspace=… — the Changes feed, one page at a time.
 *
 * The web's Changes view and REST clients page through it; MCP has the same
 * feed as `list_changes`. Read verb on the workspace via `openWorkspace`, and
 * the storage it opens is already scoped, so a principal only sees changes to
 * nodes it may read. Filters (`kind(s)`, `actor`, `node_kind`, `tag`,
 * `source`, `since`/`from`/`to`, `node`) are all optional; an undecodable
 * `cursor` is a 400 rather than a silent restart from the top.
 */
import {
  listChangePageForStorage,
  slimActivityEntry,
  type ActivityKind,
} from "@/lib/activity";
import { openWorkspace } from "@/lib/auth/workspace";
import { decodeChangeCursor } from "@bcontext-dev/contract/changes";
import { inspectorCanWrite } from "@bcontext-dev/contract/node-inspector";
import { withRoute } from "@/lib/route";
import { NODE_KINDS, type NodeKind } from "@bcontext-dev/contract/types";

const VALID_KINDS: ActivityKind[] = [
  "create",
  "update",
  "delete",
  "agent",
  "rename",
  "move",
  "workspace",
];

function isActivityKind(v: string): v is ActivityKind {
  return (VALID_KINDS as string[]).includes(v);
}

function commaValues(req: Request, key: string): string[] {
  return (new URL(req.url).searchParams.get(key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  const slug = storage.workspace.slug;
  const limitRaw = new URL(req.url).searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;

  const kinds: ActivityKind[] = [];
  const kindParam = new URL(req.url).searchParams.get("kind");
  if (kindParam && isActivityKind(kindParam)) kinds.push(kindParam);
  const kindsParam = new URL(req.url).searchParams.get("kinds");
  if (kindsParam) {
    for (const part of kindsParam.split(",")) {
      const trimmed = part.trim();
      if (isActivityKind(trimmed) && !kinds.includes(trimmed)) {
        kinds.push(trimmed);
      }
    }
  }

  const nodeId = new URL(req.url).searchParams.get("node") ?? undefined;
  const actorKinds = commaValues(req, "actor").filter(
    (value): value is "human" | "agent" | "system" =>
      value === "human" || value === "agent" || value === "system",
  );
  const nodeKinds = commaValues(req, "node_kind").filter(
    (value): value is NodeKind => (NODE_KINDS as readonly string[]).includes(value),
  );
  const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
  if (cursor && !decodeChangeCursor(cursor)) {
    return Response.json({ error: "invalid_cursor" }, { status: 400 });
  }
  const page = await listChangePageForStorage(storage, slug, {
    limit,
    nodeId,
    kinds: kinds.length > 0 ? kinds : undefined,
    actorKinds: actorKinds.length > 0 ? actorKinds : undefined,
    nodeKinds: nodeKinds.length > 0 ? nodeKinds : undefined,
    tagId: new URL(req.url).searchParams.get("tag") ?? undefined,
    source: new URL(req.url).searchParams.get("source") ?? undefined,
    since: new URL(req.url).searchParams.get("since") ?? undefined,
    from: new URL(req.url).searchParams.get("from") ?? undefined,
    to: new URL(req.url).searchParams.get("to") ?? undefined,
    cursor,
  });
  const canWrite = inspectorCanWrite(
    gated.kind,
    gated.kind === "agent" || gated.kind === "agent_user" ? gated.scopes : [],
  );
  // `fields=list` returns feed rows without before/after snapshots — the
  // expanded diff loads lazily via GET /api/activity/[id]. Default (omitted)
  // keeps the full-entry contract for existing REST/agent clients.
  const fields = new URL(req.url).searchParams.get("fields");
  if (fields !== null && fields !== "list" && fields !== "full") {
    return Response.json({ error: "invalid_fields_preset" }, { status: 400 });
  }
  const entries = fields === "list" ? page.entries.map(slimActivityEntry) : page.entries;
  return Response.json({
    changes: entries,
    // Temporary compatibility for older clients that still read `activity`.
    activity: entries,
    next_cursor: page.next_cursor,
    retention: page.retention,
    permissions: {
      read: true,
      review: canWrite,
      revert: false,
    },
  });
});

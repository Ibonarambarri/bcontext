/**
 * Field presets per view type — the single vocabulary for "how much node do
 * you actually need". Every renderer maps to a preset; list endpoints accept
 * `?fields=<preset>` plus `limit`/`cursor` keyset pagination so each view
 * fetches exactly the rows and columns it paints, nothing more.
 *
 *   - `summary`  — full NodeSummary (no content_md / no arbitrary data).
 *                  Back-compat default of `GET /api/nodes`.
 *   - `list`     — id/kind/title/slug/status/tags/dates. List + decisions
 *                  renderers.
 *   - `board`    — list + priority/due_date/assignee/position/source and the
 *                  subtask done/total. Board cards (blockers arrive
 *                  separately from the resolver).
 *   - `graph`    — id/title/kind/status/parent_id/tags. Graph snapshots never
 *                  carry bodies; links/edges travel separately.
 *
 * Node bodies (`content_md`) are NEVER part of any preset: they load lazily
 * per node (`GET /api/nodes/[id]`, node page, inspector) when one is opened.
 */
import type { NodeSummary, WorkspaceTag } from "@bcontext-dev/contract/types";

const NODE_FIELD_PRESETS = [
  "summary",
  "list",
  "board",
  "graph",
] as const;

export type NodeFieldPreset = (typeof NODE_FIELD_PRESETS)[number];

/** Wire-format tag for slim presets — enough to render a chip and filter. */
export interface SlimTag {
  id: string;
  name: string;
  slug: string;
}

const LIST_FIELDS = [
  "id",
  "workspace_id",
  "kind",
  "slug",
  "title",
  "status",
  "created_at",
  "updated_at",
] as const;

const BOARD_FIELDS = [
  ...LIST_FIELDS,
  "priority",
  "due_date",
  "assignee_id",
  "parent_id",
  "position",
] as const;

const GRAPH_FIELDS = [
  "id",
  "workspace_id",
  "kind",
  "slug",
  "title",
  "status",
  "parent_id",
  "updated_at",
] as const;

export function isNodeFieldPreset(value: unknown): value is NodeFieldPreset {
  return (
    typeof value === "string" &&
    (NODE_FIELD_PRESETS as readonly string[]).includes(value)
  );
}

/**
 * Parse an inbound `?fields=` value. Accepts the retired `timeline` preset
 * (renderer removed 2026-07-21) as an alias for `list` so older API clients
 * keep working; anything else unknown is rejected by the caller.
 */
export function parseNodeFieldPreset(value: string): NodeFieldPreset | null {
  if (value === "timeline") return "list";
  return isNodeFieldPreset(value) ? value : null;
}

/** Renderer name (saved-view presentation) → the preset its cards need. */
export function presetForRenderer(renderer: string): NodeFieldPreset {
  switch (renderer) {
    case "board":
    case "roadmap": // same cards as the board: status, priority, subtasks, due_date
      return "board";
    case "graph":
    case "browse": // needs parent_id to build the folder tree — graph preset carries it
      return "graph";
    case "list":
    case "table":
    case "timeline": // retired renderer — stored views coerce to list
      return "list";
    case "credentials":
      // No preset carries `data` (fields live in node.data, never on the
      // summary row) — the renderer fetches each credential's fields
      // individually via GET /api/nodes/[id]/inspector. `list` still gets
      // the right rows (id/title/kind) to build the card scaffold from.
      return "list";
    default:
      return "summary";
  }
}

function slimTags(tags: WorkspaceTag[] | undefined): SlimTag[] {
  return (tags ?? []).map((tag) => ({ id: tag.id, name: tag.name, slug: tag.slug }));
}

/**
 * Project one summary row onto a preset. `summary` returns the row untouched
 * (existing contract); the slim presets emit only their declared keys plus
 * slim tags (and `source` where the renderer paints provenance).
 */
export function projectNodeSummary(
  node: NodeSummary,
  preset: NodeFieldPreset,
): NodeSummary | Record<string, unknown> {
  if (preset === "summary") return node;
  const keys: readonly (keyof NodeSummary)[] =
    preset === "board" ? BOARD_FIELDS
    : preset === "graph" ? GRAPH_FIELDS
    : LIST_FIELDS;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = node[key];
  out.tags = slimTags(node.tags);
  if (preset === "board") {
    out.source = node.source;
    out.subtasks = node.subtasks;
  }
  return out;
}

export interface NodePageCursor {
  position: number;
  id: string;
}

/** Opaque keyset cursor for node pages; `decodeNodeCursor` returns null for anything foreign. */
export function encodeNodeCursor(value: NodePageCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeNodeCursor(cursor: string): NodePageCursor | null {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof value.position !== "number" || !Number.isFinite(value.position)) return null;
    if (typeof value.id !== "string" || !value.id) return null;
    return { position: value.position, id: value.id };
  } catch {
    return null;
  }
}

export interface NodePage<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Keyset pagination over the canonical (position, id) ordering shared by the
 * summaries RPC and the demo store. Deterministic: the same cursor always
 * resumes exactly after the last returned row, regardless of inserts above.
 */
export function paginateNodeSummaries(
  nodes: NodeSummary[],
  opts: { limit?: number; cursor?: NodePageCursor | null },
): NodePage<NodeSummary> {
  const sorted = [...nodes].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
  const start = opts.cursor
    ? sorted.findIndex(
        (node) =>
          node.position > opts.cursor!.position ||
          (node.position === opts.cursor!.position && node.id > opts.cursor!.id),
      )
    : 0;
  if (start === -1) return { items: [], next_cursor: null };
  const limit = Math.max(1, Math.min(2000, opts.limit ?? sorted.length));
  const items = sorted.slice(start, start + limit);
  const last = items.at(-1);
  const hasMore = start + items.length < sorted.length;
  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeNodeCursor({ position: last.position, id: last.id })
        : null,
  };
}

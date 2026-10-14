/**
 * The node inspector (drawer / rail beside a node): the payload
 * `GET /api/nodes/:id/inspector` returns and the pure helpers the web uses to
 * read it — URL/hash encoding of the selection, dependency and relation
 * folding, layout choice by width, and when a cached payload must be
 * refreshed after a realtime event. Shared so the API builds exactly the
 * shape the web renders.
 */
import type { Backlink, GraphData } from "./backlinks.js";
import type { ActivityEntry } from "./activity.js";
import type { KnowledgeNode } from "./types.js";
import { isTerminalStatus } from "./types.js";
import type { NodeEdge } from "./types.js";

export interface InspectorDependency {
  node_id: string;
  title: string | null;
  status: KnowledgeNode["status"];
  done: boolean;
}

export interface InspectorDependencies {
  blocked_by: InspectorDependency[];
  blocks: InspectorDependency[];
  unblocked: boolean;
}

export interface InspectorRelation extends NodeEdge {
  direction: "incoming" | "outgoing";
  node_id: string;
  title: string | null;
  kind: KnowledgeNode["kind"] | null;
}

export interface NodeInspectorPayload {
  node: KnowledgeNode;
  backlinks: Backlink[];
  forward_links: Backlink[];
  graph: GraphData;
  dependencies: InspectorDependencies;
  relations: InspectorRelation[];
  activity: ActivityEntry[];
  provenance: Array<{ label: string; value: string }>;
  freshness: {
    updated_at: string;
    age_days: number;
    state: "fresh" | "aging" | "stale";
  };
  permissions: { read: boolean; write: boolean };
}

export interface InspectorSelection {
  nodeId: string | null;
  blockId: string | null;
}

/** Parent candidates must exclude the node itself and every descendant. */
export function descendantIds(nodes: KnowledgeNode[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parent_id && result.has(node.parent_id) && !result.has(node.id)) {
        result.add(node.id);
        changed = true;
      }
    }
  }
  return result;
}

export function parseInspectorSelection(search: string): InspectorSelection {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const nodeId = params.get("inspect")?.trim() || null;
  const blockId = nodeId ? params.get("block")?.trim() || null : null;
  return { nodeId, blockId };
}

export function blockIdFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim() || null;
  } catch {
    return raw.trim() || null;
  }
}

export function inspectorSelectionUrl(
  pathname: string,
  search: string,
  selection: InspectorSelection,
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (selection.nodeId) params.set("inspect", selection.nodeId);
  else params.delete("inspect");
  if (selection.nodeId && selection.blockId) params.set("block", selection.blockId);
  else params.delete("block");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function fullNodeUrl(args: {
  /** `<org>/<workspace>` — a bare slug names one workspace per organization. */
  workspace: string;
  nodeId: string;
  blockId?: string | null;
  returnTo: string;
}): string {
  const params = new URLSearchParams({
    inspect: args.nodeId,
    return_to: args.returnTo,
  });
  if (args.blockId) params.set("block", args.blockId);
  return `/w/${args.workspace}/n/${encodeURIComponent(args.nodeId)}?${params.toString()}${args.blockId ? `#${encodeURIComponent(args.blockId)}` : ""}`;
}

export function inspectorLayoutForWidth(width: number): "drawer" | "rail" {
  return width < 768 ? "drawer" : "rail";
}

export function inspectorCanWrite(
  actorKind: "agent" | "agent_user" | "user" | "demo",
  scopes: readonly string[] = [],
): boolean {
  if (actorKind === "user" || actorKind === "demo") return true;
  return scopes.includes("nodes:write") || scopes.includes("admin:*");
}

export function shouldRefreshInspector(
  kind: string,
  payload: unknown,
  nodeId: string,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const data = payload as Record<string, unknown>;
  if (kind === "backlink.changed") {
    return data.targetNodeId === nodeId || data.sourceNodeId === nodeId;
  }
  return data.nodeId === nodeId;
}

export function buildInspectorRelations(
  node: KnowledgeNode,
  nodes: KnowledgeNode[],
  edges: NodeEdge[],
): { dependencies: InspectorDependencies; relations: InspectorRelation[] } {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const touching = edges.filter(
    (edge) => edge.from_node === node.id || edge.to_node === node.id,
  );
  const dep = (id: string): InspectorDependency => {
    const other = byId.get(id);
    return {
      node_id: id,
      title: other?.title ?? null,
      status: other?.status ?? null,
      done: isTerminalStatus(other?.status),
    };
  };
  const blocked_by = touching
    .filter((edge) => edge.relation === "blocked_by" && edge.from_node === node.id)
    .map((edge) => dep(edge.to_node));
  const blocks = touching
    .filter((edge) => edge.relation === "blocked_by" && edge.to_node === node.id)
    .map((edge) => dep(edge.from_node));
  const relations = touching.map((edge): InspectorRelation => {
    const outgoing = edge.from_node === node.id;
    const otherId = outgoing ? edge.to_node : edge.from_node;
    const other = byId.get(otherId);
    return {
      ...edge,
      direction: outgoing ? "outgoing" : "incoming",
      node_id: otherId,
      title: other?.title ?? null,
      kind: other?.kind ?? null,
    };
  });
  return {
    dependencies: {
      blocked_by,
      blocks,
      unblocked: blocked_by.every((item) => item.done),
    },
    relations,
  };
}

export function nodeProvenance(node: KnowledgeNode): Array<{ label: string; value: string }> {
  const data = node.data ?? {};
  const fields: Array<[string, unknown]> = [
    ["Source", data.source],
    ["Provider", data.provider],
    ["External URL", data.source_url ?? data.url],
    ["Imported from", data.imported_from],
    ["Created by", node.created_by],
  ];
  return fields
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([label, value]) => ({ label, value }));
}

/**
 * Age-only thresholds (90/30 days) are the default so a caller without read
 * activity gets the plain answer. When `readActivity.last_read_at` is
 * within `ACTIVE_READ_DAYS` (see `src/lib/rag/staleness.ts`), the state
 * is demoted one tier — a node stale by edit age but still actively
 * queried isn't truly dead knowledge.
 */
export function nodeFreshness(
  node: KnowledgeNode,
  now = Date.now(),
  readActivity?: { last_read_at: string | null } | null,
): NodeInspectorPayload["freshness"] {
  const updated = new Date(node.updated_at).getTime();
  const ageDays = Number.isFinite(updated)
    ? Math.max(0, Math.floor((now - updated) / 86_400_000))
    : 0;
  let state: "fresh" | "aging" | "stale" =
    ageDays >= 90 ? "stale" : ageDays >= 30 ? "aging" : "fresh";
  const lastReadAt = readActivity?.last_read_at;
  if (lastReadAt) {
    const readAgeDays = Math.floor((now - new Date(lastReadAt).getTime()) / 86_400_000);
    if (Number.isFinite(readAgeDays) && readAgeDays <= 30) {
      if (state === "stale") state = "aging";
      else if (state === "aging") state = "fresh";
    }
  }
  return {
    updated_at: node.updated_at,
    age_days: ageDays,
    state,
  };
}

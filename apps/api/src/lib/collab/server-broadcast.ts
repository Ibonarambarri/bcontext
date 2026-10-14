/**
 * Server-side broadcast onto a workspace's realtime room.
 *
 * Used by API routes (node create/update/delete, mention edits) and by MCP
 * tools to push invalidation events to every connected client after a
 * mutation succeeds. The delivery lives in `@/lib/realtime/publish`: local
 * sockets first when this process holds the hub, then Postgres NOTIFY so the
 * other API instances and the worker's events reach every socket, and the
 * HTTP `POST /realtime/broadcast` only where there is no `DATABASE_URL`.
 * This file keeps the typed event catalogue and the wrappers routes call.
 *
 * Failures here MUST NOT propagate: a realtime hiccup must never break a
 * user's edit. Logged and swallowed, one level down.
 */
import { publishWorkspaceEvent } from "@/lib/realtime/publish";

const BROADCAST_KIND = [
  "node.created",
  "node.updated",
  "node.renamed",
  "node.deleted",
  "node.moved",
  "backlink.changed",
  "tree.invalidated",
  "meeting_bot.status",
  "view.changed",
  "graph.changed",
] as const;

export type WorkspaceBroadcastKind = (typeof BROADCAST_KIND)[number];

export interface WorkspaceBroadcastEvent<T = unknown> {
  kind: WorkspaceBroadcastKind;
  payload: T;
  /** Originating client id (or user id) — receivers can ignore their own echo. */
  from?: string | number;
  ts?: number;
}

/** Send a single event to a workspace room, wherever its sockets are. */
export async function broadcastWorkspace(
  workspaceId: string,
  event: WorkspaceBroadcastEvent,
): Promise<void> {
  if (!workspaceId) return;
  await publishWorkspaceEvent(workspaceId, {
    kind: event.kind,
    payload: event.payload,
    from: event.from ?? null,
    ts: event.ts ?? Date.now(),
  });
}

/**
 * Convenience wrappers for the most common events. Keeps API route call sites
 * tidy and gives us one place to evolve the payload shape if we need to.
 */
export const wsBroadcast = {
  graphChanged: (
    workspaceId: string,
    resource: "taxonomy" | "edge",
    action: string,
    id?: string,
    from?: string,
  ) =>
    broadcastWorkspace(workspaceId, {
      kind: "graph.changed",
      payload: { resource, action, ...(id ? { id } : {}) },
      from,
    }),
  viewChanged: (
    workspaceId: string,
    viewId: string,
    action: "created" | "updated" | "deleted",
    from?: string,
  ) =>
    broadcastWorkspace(workspaceId, {
      kind: "view.changed",
      payload: { viewId, action },
      from,
    }),
  nodeCreated: (workspaceId: string, nodeId: string, from?: string) =>
    broadcastWorkspace(workspaceId, {
      kind: "node.created",
      payload: { nodeId },
      from,
    }),
  nodeUpdated: (
    workspaceId: string,
    nodeId: string,
    from?: string,
    summary?: Record<string, unknown>,
  ) =>
    broadcastWorkspace(workspaceId, {
      kind: "node.updated",
      payload: { nodeId, ...(summary ? { summary } : {}) },
      from,
    }),
  nodeRenamed: (
    workspaceId: string,
    nodeId: string,
    title: string,
    from?: string,
  ) =>
    broadcastWorkspace(workspaceId, {
      kind: "node.renamed",
      payload: { nodeId, title },
      from,
    }),
  nodeDeleted: (workspaceId: string, nodeId: string, from?: string) =>
    broadcastWorkspace(workspaceId, {
      kind: "node.deleted",
      payload: { nodeId },
      from,
    }),
  nodeMoved: (
    workspaceId: string,
    nodeId: string,
    parentId: string | null,
    from?: string,
  ) =>
    broadcastWorkspace(workspaceId, {
      kind: "node.moved",
      payload: { nodeId, parentId },
      from,
    }),
  /**
   * Coarse "the whole tree may have changed" signal. Use for bulk operations
   * (template apply, import) where firing one event per node would be noisy —
   * receivers debounce a single tree refresh.
   */
  treeInvalidated: (workspaceId: string, from?: string) =>
    broadcastWorkspace(workspaceId, {
      kind: "tree.invalidated",
      payload: {},
      from,
    }),
  /**
   * Notify each affected target that *its* backlinks changed. Pass one call
   * per target id; clients viewing that target refresh their context lens.
   */
  backlinkChanged: (
    workspaceId: string,
    targetNodeId: string,
    sourceNodeId: string,
    from?: string,
  ) =>
    broadcastWorkspace(workspaceId, {
      kind: "backlink.changed",
      payload: { targetNodeId, sourceNodeId },
      from,
    }),
};

"use client";

/**
 * The two ways a node leaves the board, shared by the panel, the board cards
 * and the archive shelf so they behave the same everywhere.
 *
 * Archive is cleanup: a status change, optimistic, reversible from the shelf.
 * Delete is the end: the node, its subtasks, its child nodes and every link
 * to it go, and nothing brings them back — so it always asks first, in its
 * own dialog, and the dialog says exactly what is about to disappear and
 * points at Archive for the "just get it out of the way" case.
 */

import { Archive, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { nodeSubtaskProgress } from "@bcontext-dev/contract/subtasks";
import { descendantIds } from "@bcontext-dev/contract/node-inspector";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { CardAction } from "@/components/card-actions-menu";
import { useWorkspace } from "@/components/workspace-context";
import { workspaceApiRef } from "@/web/workspace-url";

/**
 * The least a caller must know about a node to archive or delete it: a board
 * card or a summary row qualifies, not only a full inspector payload.
 * `updated_at` is the optimistic-concurrency guard the archive PATCH sends.
 */
export type NodeRef = Pick<KnowledgeNode, "id" | "title" | "kind" | "status" | "updated_at"> & {
  data?: Record<string, unknown>;
  subtasks?: { done: number; total: number } | null;
};

const ARCHIVE_ACTION: CardAction = { id: "archive", label: "Archive", Icon: Archive };
const DELETE_ACTION: CardAction = { id: "delete", label: "Delete", Icon: Trash2, danger: true };

/** Actions a task-like node offers: Archive while it is live, Delete always. */
export function nodeActionsFor(node: Pick<KnowledgeNode, "kind" | "status">): CardAction[] {
  const canArchive = (node.kind === "task" || node.kind === "bug") && node.status !== "archived";
  return canArchive ? [ARCHIVE_ACTION, DELETE_ACTION] : [DELETE_ACTION];
}

/**
 * Archive a node optimistically: the summary patch removes it from `nodes`
 * (and so from the board and the graph) in the same tick; a failure puts it
 * back with a toast, a 409 reloads the caller's view.
 */
export function useArchiveNode() {
  const { address, patchNodeSummary, toast } = useWorkspace();
  return useCallback(async (node: NodeRef): Promise<boolean> => {
    const previous = node.status;
    patchNodeSummary(node.id, { status: "archived" });
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceApiRef(address), if_updated_at: node.updated_at, status: "archived" }),
      });
      if (!response.ok) {
        patchNodeSummary(node.id, { status: previous });
        toast.error(response.status === 409 ? "This node changed elsewhere. Open it and archive from there." : "Couldn’t archive the node.");
        return false;
      }
      const body = (await response.json()) as { node: KnowledgeNode };
      patchNodeSummary(node.id, { status: body.node.status, updated_at: body.node.updated_at });
      return true;
    } catch {
      patchNodeSummary(node.id, { status: previous });
      toast.error("Couldn’t archive the node.");
      return false;
    }
  }, [address, patchNodeSummary, toast]);
}

/**
 * Delete flow as state + dialog: `request(node)` opens it, the dialog does
 * the rest through the workspace's `deleteNode` (which closes tabs, leaves
 * the page if it was open, and broadcasts).
 */
export function useDeleteNode(onDeleted?: (id: string) => void) {
  const { nodes, archivedNodes, deleteNode } = useWorkspace();
  const [pending, setPending] = useState<NodeRef | null>(null);
  const [busy, setBusy] = useState(false);

  const blastRadius = useMemo(() => {
    if (!pending) return { subtasks: 0, children: 0 };
    const everyNode = [...nodes, ...archivedNodes];
    const children = descendantIds(everyNode, pending.id).size - 1;
    const progress = nodeSubtaskProgress({ data: pending.data, subtasks: pending.subtasks });
    return { subtasks: progress?.total ?? 0, children: Math.max(0, children) };
  }, [pending, nodes, archivedNodes]);

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending ? `Delete “${pending.title}”?` : "Delete?"}
      body={
        pending ? (
          <>
            {describeBlast(pending, blastRadius)} Links pointing at it stop resolving. This cannot be undone.
            {pending.status !== "archived" && (pending.kind === "task" || pending.kind === "bug") ? (
              <> If it only needs to be out of the way, <span className="text-[var(--ink)]">archive</span> it instead.</>
            ) : null}
          </>
        ) : null
      }
      confirmLabel={busy ? "Deleting…" : "Delete"}
      tone="danger"
      icon={<Trash2 size={15} />}
      busy={busy}
      onCancel={() => { if (!busy) setPending(null); }}
      onConfirm={() => {
        if (!pending) return;
        const target = pending;
        setBusy(true);
        void deleteNode(target.id).then((deleted) => {
          setBusy(false);
          setPending(null);
          if (deleted) onDeleted?.(target.id);
        });
      }}
    />
  );

  return { request: (node: NodeRef) => setPending(node), dialog };
}

function describeBlast(node: NodeRef, blast: { subtasks: number; children: number }): string {
  const parts: string[] = [];
  if (blast.subtasks > 0) parts.push(`its ${blast.subtasks} subtask${blast.subtasks === 1 ? "" : "s"}`);
  if (blast.children > 0) parts.push(`${blast.children} child node${blast.children === 1 ? "" : "s"} under it`);
  const what = parts.length === 0 ? `This ${node.kind}` : `This ${node.kind}, ${parts.join(" and ")},`;
  return `${what} ${parts.length === 0 ? "is" : "are"} removed for everyone, people and agents alike.`;
}

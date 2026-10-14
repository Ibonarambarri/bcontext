"use client";

/**
 * The shelf behind the tasks board's Archive button: every task or bug with
 * status `archived`, newest first, each with a way back. Archiving is
 * cleanup, not deletion — the node keeps its id, links and body, it just
 * stops occupying the board and the graph — so restoring is only a status
 * change, done optimistically like every other status change in the app.
 */

import { ArchiveRestore, Bug, CheckSquare, Hash, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Chip } from "@heroui/react";
import type { KnowledgeNode, TaskStatus } from "@bcontext-dev/contract/types";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { useWorkspace } from "@/components/workspace-context";
import { useDeleteNode } from "@/components/node-actions";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/** Where a restored task lands: the neutral column, not "in progress". */
const RESTORE_TO: TaskStatus = "backlog";

export function ArchivedTasks({ workspace }: { workspace: WorkspaceAddress }) {
  const { archivedNodes, selectNode, patchNodeSummary, toast } = useWorkspace();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const { request: requestDelete, dialog: deleteDialog } = useDeleteNode();
  const tasks = useMemo(
    () =>
      archivedNodes
        .filter((node) => node.kind === "task" || node.kind === "bug")
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [archivedNodes],
  );

  async function restore(node: KnowledgeNode) {
    if (busy.has(node.id)) return;
    setBusy((current) => new Set(current).add(node.id));
    // Optimistic: the row leaves the shelf and the card reappears on the board now.
    patchNodeSummary(node.id, { status: RESTORE_TO });
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(node.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceApiRef(workspace), if_updated_at: node.updated_at, status: RESTORE_TO }),
      });
      if (response.status === 409) {
        patchNodeSummary(node.id, { status: "archived" });
        toast.error("This task changed elsewhere. Open it and restore from there.");
        return;
      }
      if (!response.ok) throw new Error("restore failed");
      const body = (await response.json()) as { node: KnowledgeNode };
      patchNodeSummary(node.id, { status: body.node.status, updated_at: body.node.updated_at });
    } catch {
      patchNodeSummary(node.id, { status: "archived" });
      toast.error("Couldn’t restore the task. It stays archived.");
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(node.id);
        return next;
      });
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-[10px] bg-[var(--paper-2)] px-5 py-6 text-[12.5px] text-[var(--ink-3)]" data-testid="archived-tasks-empty">
        Nothing archived. Set a task’s status to <span className="text-[var(--ink)]">Archived</span> to take it off the board and the graph; it stays readable by id and comes back with any other status.
      </div>
    );
  }

  return (
    <div data-testid="archived-tasks">
      <div className="mono mb-2 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
        <span>Archived</span>
        <span className="text-[var(--ink-3)]">{tasks.length}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {tasks.map((node) => {
          const Icon = node.kind === "bug" ? Bug : CheckSquare;
          const restoring = busy.has(node.id);
          return (
            <li
              key={node.id}
              className="group flex items-center gap-3 rounded-[10px] bg-[var(--paper-2)] px-3.5 py-2.5 transition-[background-color] duration-150 hover:bg-[var(--paper-3)] motion-reduce:transition-none"
            >
              <Icon size={12} className="shrink-0 text-[var(--ink-mute)]" aria-label={node.kind} />
              <button
                type="button"
                onClick={() => selectNode(node.id)}
                className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)]"
              >
                {node.title}
              </button>
              {node.tags.slice(0, 2).map((tag) => (
                <Chip key={tag.id} size="sm" variant="tertiary" className="hidden gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)] sm:inline-flex">
                  <Hash size={9} /> <Chip.Label>{tag.name}</Chip.Label>
                </Chip>
              ))}
              <span className="mono shrink-0 text-[10px] text-[var(--ink-mute)]" title={node.updated_at}>
                {formatRelative(node.updated_at)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={restoring}
                onPress={() => void restore(node)}
                className={cn("shrink-0 gap-1.5 text-[11px] text-[var(--ink-3)]", "opacity-70 group-hover:opacity-100")}
                aria-label={`Restore ${node.title}`}
              >
                <ArchiveRestore size={11} /> {restoring ? "Restoring…" : "Restore"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={restoring}
                onPress={() => requestDelete(node)}
                className="shrink-0 gap-1.5 text-[11px] text-[var(--ink-3)] opacity-70 hover:text-danger group-hover:opacity-100"
                aria-label={`Delete ${node.title}`}
              >
                <Trash2 size={11} /> Delete
              </Button>
            </li>
          );
        })}
      </ul>
      {deleteDialog}
    </div>
  );
}

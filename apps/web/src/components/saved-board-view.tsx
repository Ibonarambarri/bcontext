"use client";

/**
 * The board surface of a saved view with the `board` renderer — the Tasks
 * system view and any custom board — chosen by `view-canvas.tsx`.
 *
 * Membership vs data: this component resolves WHICH nodes are on the board
 * (`POST /api/views/:id/resolve` → `node_ids`, plus the blocker map) and
 * hands the actual node objects from the workspace context's `nodes` to
 * `BoardRenderer`. So a status or title change anywhere converges through
 * the context's summary patches without touching this file, and this file
 * only refetches when membership may have changed (realtime, debounced) or
 * when the board asks for canonical truth after a conflict.
 *
 * The Archive switch shows `archivedNodes` — out of every resolved view by
 * design — in place of the columns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { Button } from "@heroui/react";
import { ArchivedTasks } from "@/components/archived-tasks";
import { BoardSkeleton } from "@/components/skeletons";
import { BoardRenderer } from "@/components/board-renderer";
import { useWorkspace } from "@/components/workspace-context";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import type { BoardBlockerState } from "@bcontext-dev/contract/board/model";
import type { SavedView, ResolvedViewQuery } from "@bcontext-dev/contract/views/types";
import { BOARD_REALTIME_EVENTS } from "@/lib/board/realtime";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

type Payload = {
  view: SavedView;
  result: ResolvedViewQuery;
  board?: { blockers?: Record<string, BoardBlockerState> };
};

export function SavedBoardView({ workspace, viewId }: { workspace: WorkspaceAddress; viewId: string }) {
  const router = useRouter();
  const { nodes, archivedNodes } = useWorkspace();
  const [payload, setPayload] = useState<Payload | null>(null);
  // The shelf: archived tasks are out of `nodes` (and of every resolved
  // view), so the board can only show them through this switch.
  const [showArchive, setShowArchive] = useState(false);
  const archivedCount = useMemo(
    () => archivedNodes.filter((node) => node.kind === "task" || node.kind === "bug").length,
    [archivedNodes],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const listed = await fetch(`/api/views?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`);
      if (!listed.ok) {
        setPayload(null);
        setError(listed.status === 403 ? "You do not have permission to read views." : "Views could not be loaded.");
        return;
      }
      const readable = await listed.json() as { views: SavedView[] };
      const selected = readable.views.find((view) => view.id === viewId || view.slug === viewId);
      if (!selected) {
        setPayload(null);
        setError("This view does not exist or is not shared with you.");
        return;
      }
      const response = await fetch(`/api/views/${encodeURIComponent(selected.id)}/resolve?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        setPayload(null);
        setError(response.status === 403
          ? "You do not have permission to read this view."
          : response.status === 404
            ? "This view does not exist or is not shared with you."
            : "This view could not be resolved.");
        return;
      }
      const next = await response.json() as Payload;
      if (next.view.presentation.renderer !== "board") {
        setPayload(null);
        setError(`“${next.view.name}” uses the ${next.view.presentation.renderer} renderer, not board.`);
        return;
      }
      setPayload(next);
      setError(null);
    } catch {
      setError("This view could not be resolved.");
    } finally {
      setLoading(false);
    }
  }, [viewId, workspace]);

  useEffect(() => { void load(); }, [load]);

  // Full canonical refetch — reserved for the rare paths where server truth
  // must be re-read (409 conflict on a move, create-in-column membership).
  // Never runs on a successful optimistic move.
  const canonicalRefresh = useCallback(() => {
    router.refresh();
    void load();
  }, [load, router]);

  // Realtime events only re-resolve view membership (debounced — a burst of
  // node.* events costs one fetch). Node DATA already flows without any
  // refetch: WorkspaceProvider folds `node.updated` summaries into `nodes`
  // and schedules its own debounced RSC refresh for tree-shape events, so
  // calling router.refresh() here too would double every refetch — including
  // on the author's own server echo after each move, which is what made the
  // whole Tasks page visibly reload on every drag.
  const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeResync = useCallback(() => {
    if (loadDebounceRef.current) return;
    loadDebounceRef.current = setTimeout(() => {
      loadDebounceRef.current = null;
      void load();
    }, 250);
  }, [load]);
  useEffect(() => () => {
    if (loadDebounceRef.current) clearTimeout(loadDebounceRef.current);
  }, []);
  useBoardRealtime(realtimeResync);

  const items = useMemo(() => {
    if (!payload) return [];
    const ids = new Set(payload.result.node_ids);
    return nodes.filter((node) => ids.has(node.id));
  }, [nodes, payload]);

  if (loading) {
    // Column skeleton in the exact frame BoardRenderer will occupy.
    return (
      <section className="scroll h-full overflow-y-auto bg-[var(--paper)]">
        <div className="mx-auto max-w-none px-6 pb-7 pt-3 sm:px-10">
          <BoardSkeleton />
        </div>
      </section>
    );
  }
  if (error || !payload) return <ViewMessage>{error ?? "View unavailable."}</ViewMessage>;

  return (
    <section className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-none px-6 pb-7 pt-3 sm:px-10">
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant={showArchive ? "secondary" : "ghost"}
            onPress={() => setShowArchive((open) => !open)}
            aria-pressed={showArchive}
            className="gap-1.5 text-[11.5px] text-[var(--ink-2)]"
          >
            <Archive size={12} />
            {showArchive ? "Board" : "Archive"}
            {archivedCount > 0 ? <span className="mono text-[10px] text-[var(--ink-mute)]">{archivedCount}</span> : null}
          </Button>
        </div>
        {showArchive ? (
          <div className="mt-3">
            <ArchivedTasks workspace={workspace} />
          </div>
        ) : (
          <BoardRenderer
            workspace={workspace}
            items={items}
            allNodes={nodes}
            query={payload.view.query}
            presentation={payload.view.presentation}
            blockers={payload.board?.blockers}
            onRefresh={canonicalRefresh}
          />
        )}
      </div>
    </section>
  );
}

// One subscription per event, unrolled: hooks cannot be called in a loop,
// and the tuple is fixed-length, so this is the whole list.
function useBoardRealtime(refresh: () => void): void {
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[0], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[1], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[2], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[3], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[4], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[5], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[6], refresh);
}

function ViewMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[var(--ink-3)]">{children}</div>;
}

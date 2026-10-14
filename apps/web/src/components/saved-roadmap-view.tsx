"use client";

/**
 * The roadmap surface of a saved view with the `roadmap` renderer — the
 * Roadmap system view and any custom roadmap — chosen by `view-canvas.tsx`.
 *
 * Unlike the board, the rows here are not the resolved nodes: they are the
 * workspace's goals, joined to the resolved tasks through `contributes_to`
 * and to each other through `parent_id`, and the columns are a rule over
 * status, priority and blockers. All of that is one read on the server
 * (`POST /api/views/:id/resolve` → `roadmap`), so this file re-resolves
 * when something may have moved — the same debounced realtime events the
 * board listens to — and draws whatever comes back. No optimistic state:
 * nothing is edited from this surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RoadmapRenderer } from "@/components/roadmap-renderer";
import { RoadmapSkeleton } from "@/components/skeletons";
import { useWorkspaceBroadcast } from "@/lib/collab/workspace-realtime";
import { BOARD_REALTIME_EVENTS } from "@/lib/board/realtime";
import type { RoadmapModel } from "@bcontext-dev/contract/roadmap/model";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

type Payload = { view: SavedView; roadmap?: RoadmapModel };

export function SavedRoadmapView({ workspace, viewId }: { workspace: WorkspaceAddress; viewId: string }) {
  const [model, setModel] = useState<RoadmapModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const listed = await fetch(`/api/views?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`);
      if (!listed.ok) {
        setError(listed.status === 403 ? "You do not have permission to read views." : "Views could not be loaded.");
        return;
      }
      const readable = (await listed.json()) as { views: SavedView[] };
      const selected = readable.views.find((view) => view.id === viewId || view.slug === viewId);
      if (!selected) {
        setError("This view does not exist or is not shared with you.");
        return;
      }
      const response = await fetch(`/api/views/${encodeURIComponent(selected.id)}/resolve?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        setError(response.status === 403
          ? "You do not have permission to read this view."
          : response.status === 404
            ? "This view does not exist or is not shared with you."
            : "This view could not be resolved.");
        return;
      }
      const next = (await response.json()) as Payload;
      if (next.view.presentation.renderer !== "roadmap" || !next.roadmap) {
        setError(`“${next.view.name}” uses the ${next.view.presentation.renderer} renderer, not roadmap.`);
        return;
      }
      setModel(next.roadmap);
      setError(null);
    } catch {
      setError("This view could not be resolved.");
    } finally {
      setLoading(false);
    }
  }, [viewId, workspace]);

  useEffect(() => { void load(); }, [load]);

  // A burst of node events costs one re-resolve; the model is small and the
  // server is where the rows are decided, so there is nothing to patch locally.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resync = useCallback(() => {
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void load();
    }, 250);
  }, [load]);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);
  useRoadmapRealtime(resync);

  return (
    <section className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-none px-6 pb-7 pt-3 sm:px-10">
        {loading ? (
          <RoadmapSkeleton />
        ) : error || !model ? (
          <div className="flex h-full items-center justify-center px-6 py-16 text-center text-[12px] text-[var(--ink-3)]">{error ?? "View unavailable."}</div>
        ) : (
          <RoadmapRenderer model={model} />
        )}
      </div>
    </section>
  );
}

// One subscription per event, unrolled: hooks cannot be called in a loop,
// and the tuple is fixed-length, so this is the whole list.
function useRoadmapRealtime(refresh: () => void): void {
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[0], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[1], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[2], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[3], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[4], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[5], refresh);
  useWorkspaceBroadcast(BOARD_REALTIME_EVENTS[6], refresh);
}

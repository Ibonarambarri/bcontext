"use client";

/**
 * The switch from a saved view to its renderer, mounted by the
 * `/v/[view]` route. Finds the view in the workspace context (by slug,
 * system key or id) and hands it to the board, roadmap, list, browse,
 * credentials, graph or changes surface. Every renderer reads the resolved query from
 * the context (`activeViewResult`) except the board, which resolves its
 * own membership, and the graph, which reads the tag API for its Tags focus.
 *
 * While views are still loading, the skeleton is chosen from a per-view
 * renderer hint remembered in localStorage, so a cold navigation shows the
 * right shape from the first frame.
 */

import { useEffect } from "react";
import { useWorkspace } from "./workspace-context";
import { SavedBoardView } from "./saved-board-view";
import { SavedRoadmapView } from "./saved-roadmap-view";
import { SavedListView } from "./saved-list-view";
import { BrowseRenderer } from "./browse-renderer";
import { CredentialsRenderer } from "./credentials-renderer";
import { GraphView } from "./graph-view";
import { ChangesView } from "./changes-view";
import { BoardSkeleton, GraphSkeleton, RoadmapSkeleton, ViewSkeleton } from "./skeletons";
import { rememberViewRenderer, useViewRendererHint } from "@/lib/view-renderer-hint";

export function ViewCanvas({ viewSlug }: { viewSlug: string }) {
  const {
    address,
    views,
    viewsLoading,
    viewsError,
    activeView,
    activeViewResult,
  } = useWorkspace();

  const view =
    activeView?.slug === viewSlug || activeView?.system_key === viewSlug
      ? activeView
      : views.find((candidate) => candidate.id === viewSlug || candidate.slug === viewSlug || candidate.system_key === viewSlug) ?? null;

  const hint = useViewRendererHint(address, viewSlug);
  // Remember each view's renderer so the NEXT cold navigation can show the
  // right skeleton from the first frame (see src/lib/view-renderer-hint.ts).
  useEffect(() => {
    if (!view) return;
    rememberViewRenderer(address, [view.slug, view.system_key, view.id], view.presentation.renderer);
  }, [view, address]);

  if (viewsLoading && !view) {
    if (hint === "graph") return <GraphSkeleton />;
    if (hint === "board") return <BoardSkeleton />;
    if (hint === "roadmap") return <RoadmapSkeleton />;
    // "browse" (and everything else) share the generic list-shaped skeleton.
    return <ViewSkeleton />;
  }
  if (!view) return <CenteredMessage>{viewsError ?? "This view is not available to your account."}</CenteredMessage>;
  if (view.presentation.renderer === "board") {
    return <SavedBoardView workspace={address} viewId={view.id} />;
  }
  // The roadmap resolves its own rows (goals + edges) server-side, like the board resolves membership.
  if (view.presentation.renderer === "roadmap") {
    return <SavedRoadmapView workspace={address} viewId={view.id} />;
  }
  if (view.presentation.renderer === "changes") {
    return <ChangesView title={view.system_key === "changes" ? "Activity" : view.name} description={view.description ?? undefined} />;
  }
  // The graph owns its own loading state: its Tags focus reads the tag API
  // rather than the resolved query, and must render before that lands.
  if (view.presentation.renderer === "graph") {
    return <GraphView key={view.id} view={view} />;
  }
  if (!activeViewResult) {
    return <ViewSkeleton />;
  }

  if (view.presentation.renderer === "browse") {
    return <BrowseRenderer key={view.id} view={view} />;
  }

  if (view.presentation.renderer === "credentials") {
    return <CredentialsRenderer key={view.id} view={view} />;
  }

  // Every remaining renderer (`list`, `table`, and old `timeline` views the
  // contract coerces to `list`) shares the one list surface.
  return <SavedListView key={view.id} view={view} />;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--ink-3)]">{children}</div>;
}

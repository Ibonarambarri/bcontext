"use client";

import { useParams } from "next/navigation";
import { BoardSkeleton, GraphSkeleton, RoadmapSkeleton, ViewSkeleton } from "@/components/skeletons";
import { useViewRendererHint } from "@/lib/view-renderer-hint";

/**
 * Saved-view route loading state. The concrete renderer is only known once
 * the view resolves client-side, but the last known renderer per view is
 * remembered in sessionStorage (src/lib/view-renderer-hint.ts) — so a graph
 * view shows the graph skeleton from the very first frame instead of
 * flashing the generic list skeleton and swapping. Unknown views (first
 * ever visit) keep the neutral list skeleton.
 */
export default function Loading() {
  const params = useParams<{ org?: string; ws?: string; view?: string }>();
  const hint = useViewRendererHint(
    params.org && params.ws ? { org: params.org, slug: params.ws } : undefined,
    params.view,
  );
  if (hint === "graph") return <GraphSkeleton />;
  if (hint === "board") return <BoardSkeleton />;
  if (hint === "roadmap") return <RoadmapSkeleton />;
  return <ViewSkeleton />;
}

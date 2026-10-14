/**
 * `/w/<org>/<ws>/v/<view>`: every view a workspace has, under one route.
 *
 * `<view>` is either a system surface with a component of its own (the
 * agents, tools and conflicts admin pages) or the slug/id of a saved view,
 * which `ViewCanvas` resolves and renders client-side. Old surface slugs
 * redirect rather than 404 so bookmarks keep working: integrations are
 * connected to a Nexo (the general one owns whatever is unassigned).
 */
import type { Route } from "next";
import { redirect } from "next/navigation";
import { ViewCanvas } from "@/components/view-canvas";
import { WorkspaceAdminPage, type WorkspaceAdminSurface } from "@/components/agents-dashboard";
import { nexoDetailPath, systemViewPath } from "@/lib/view-shell";
import type { WorkspaceAddress } from "@/web/workspace-url";

const ADMIN_SURFACES = new Set<WorkspaceAdminSurface>(["agents", "tools", "conflicts"]);

/** Legacy slugs (nav reorgs 2026-07-21, 2026-09-08 and Nexos) → where that surface lives now. */
const LEGACY_REDIRECTS: Record<string, (ws: WorkspaceAddress) => Route> = {
  review: (ws) => systemViewPath(ws, "conflicts"),
  ingest: (ws) => nexoDetailPath(ws, "general", { tab: "setup", section: "sources" }),
  integrations: (ws) => nexoDetailPath(ws, "general", { tab: "setup", section: "sources" }),
};

export default async function WorkspaceViewPage({
  params,
}: {
  params: Promise<{ org: string; ws: string; view: string }>;
}) {
  const { org, ws, view } = await params;
  const address = { org, slug: ws };
  const decoded = decodeURIComponent(view);
  const legacy = LEGACY_REDIRECTS[decoded];
  if (legacy) redirect(legacy(address));
  if (ADMIN_SURFACES.has(decoded as WorkspaceAdminSurface)) {
    return <WorkspaceAdminPage workspace={address} surface={decoded as WorkspaceAdminSurface} />;
  }
  return <ViewCanvas viewSlug={decoded} />;
}

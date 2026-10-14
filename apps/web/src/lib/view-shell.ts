/**
 * Where things are inside a workspace: the system view keys and the URL
 * builders the sidebar, header and inspector share. Everything returns a
 * typed `Route` on top of `workspacePath`, so a renamed section is a
 * one-file change.
 */
import type { Route } from "next";
import { workspacePath, type WorkspaceAddress } from "@/web/workspace-url";

/** The built-in views, in no particular order; `v/[view]/page.tsx` renders each by key. */
export const SYSTEM_VIEW_KEYS = [
  "overview",
  "graph",
  "tasks",
  "roadmap",
  "browse",
  "credentials",
  "changes",
  "agents",
  "tools",
  // `review` is a legacy slug kept so old links resolve; v/[view]/page.tsx
  // redirects it to Conflicts. The retired `ingest` and `integrations` slugs
  // redirect to the general Nexo's Setup → Sources from the same place.
  "review",
  "conflicts",
] as const;

export type SystemViewKey = (typeof SYSTEM_VIEW_KEYS)[number];
/** Where the person was last in a workspace, kept in this browser's localStorage (`local-settings.ts`). */
export interface WorkspaceNavigationPreference {
  last_view_slug: string;
}

export const DEFAULT_WORKSPACE_NAVIGATION: WorkspaceNavigationPreference = {
  last_view_slug: "overview",
};

/** Overview is the workspace root itself; every other system view lives under `v/`. */
export function systemViewPath(ws: WorkspaceAddress, key: SystemViewKey): Route {
  if (key === "overview") return workspacePath(ws) as Route;
  return workspacePath(ws, `v/${key}`) as Route;
}

/** The tabs of a Nexo's page, in display order; `nexos/tabs.ts` resolves a URL to one. */
export const NEXO_TABS = ["chat", "inbox", "activity", "setup"] as const;
export type NexoTab = (typeof NEXO_TABS)[number];

/** The sections of a Nexo's Setup tab, top to bottom; each is an anchor (`#nexo-<section>`). */
export type NexoSetupSection = "sources" | "abilities" | "behaviour" | "escalation" | "instructions" | "budget" | "danger";

/**
 * The Nexos section: the team page and, under it, one page per Nexo. Not a
 * `v/` view — it is not a query over nodes, it is the people-shaped part of
 * the workspace.
 */
export function nexosPath(ws: WorkspaceAddress): Route {
  return workspacePath(ws, "nexos") as Route;
}

/**
 * One Nexo's page. `nexo` is its id, or `general` for the workspace's general
 * Nexo — the one address that never changes, which is what the launcher, the
 * guide and old links need.
 */
export function nexoDetailPath(
  ws: WorkspaceAddress,
  nexo: string,
  opts: { tab?: NexoTab; section?: NexoSetupSection; conversationId?: string } = {},
): Route {
  const params = new URLSearchParams();
  if (opts.tab && opts.tab !== "chat") params.set("tab", opts.tab);
  if (opts.tab === "setup" && opts.section) params.set("section", opts.section);
  if (opts.conversationId) params.set("c", opts.conversationId);
  const query = params.toString();
  return `${workspacePath(ws, `nexos/${encodeURIComponent(nexo)}`)}${query ? `?${query}` : ""}` as Route;
}

/** The general Nexo's chat: where "open in the page" and the guide's "Ask Nexo" land. */
export function nexoPath(ws: WorkspaceAddress, conversationId?: string): Route {
  return nexoDetailPath(ws, "general", { conversationId });
}

export function customViewPath(ws: WorkspaceAddress, viewSlug: string): Route {
  return workspacePath(ws, `v/${encodeURIComponent(viewSlug)}`) as Route;
}

/** `/n/<id>#<block>` — the address agents and backlinks use for a section. */
export function nodeDeepLink(
  ws: WorkspaceAddress,
  nodeId: string,
  blockId?: string | null,
): Route {
  const base = workspacePath(ws, `n/${encodeURIComponent(nodeId)}`);
  return (blockId ? `${base}#${encodeURIComponent(blockId)}` : base) as Route;
}

/**
 * The fullscreen node route with the state the inspector needs to come back:
 * which node is open, which block, and where the person was standing.
 */
export function fullNodeUrl(
  ws: WorkspaceAddress,
  args: { nodeId: string; blockId?: string | null; returnTo: string },
): Route {
  const params = new URLSearchParams({ inspect: args.nodeId, return_to: args.returnTo });
  if (args.blockId) params.set("block", args.blockId);
  const base = workspacePath(ws, `n/${encodeURIComponent(args.nodeId)}`);
  const hash = args.blockId ? `#${encodeURIComponent(args.blockId)}` : "";
  return `${base}?${params.toString()}${hash}` as Route;
}

/** The view slug a pathname is showing, for highlighting nav; null outside the view routes. */
export function viewSlugFromPathname(pathname: string, ws: WorkspaceAddress): string | null {
  const base = workspacePath(ws);
  const normalized = pathname.replace(/\/$/, "") || "/";
  if (normalized === base) return "overview";
  if (normalized === `${base}/views`) return "overview";
  // Nexos live outside `v/`, but the sidebar and the header title key off this
  // slug — without the branch the previous view would stay lit.
  if (
    normalized === `${base}/nexo` ||
    normalized === `${base}/nexos` ||
    normalized.startsWith(`${base}/nexos/`)
  ) {
    return "nexos";
  }
  const prefix = `${base}/v/`;
  if (!normalized.startsWith(prefix)) return null;
  const segment = normalized.slice(prefix.length).split("/")[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export type LegacyAdminSurface = "agents" | "connections";

/**
 * Map the retired Connections/tabs URLs to where each surface lives now: the
 * `agents` and `tools` views, and the general Nexo's Setup → Sources (an
 * integration is connected to a Nexo; the general one owns anything
 * unassigned). The rest of the query rides along.
 */
export function legacyAdminDestination(
  ws: WorkspaceAddress,
  source: LegacyAdminSurface,
  query: URLSearchParams,
): Route {
  const next = new URLSearchParams(query);
  const tab = next.get("tab");
  next.delete("tab");
  if (tab === "integrations") return nexoDetailPath(ws, "general", { tab: "setup", section: "sources" });
  const surface = tab === "providers" || tab === "tools" ? "tools" : "agents";
  if (source === "connections" && !tab) next.delete("surface");
  const suffix = next.toString();
  return `${systemViewPath(ws, surface)}${suffix ? `?${suffix}` : ""}` as Route;
}

/** The retired `/browse` and `/nodes` pages: same query, on the workspace root. */
export function legacyBrowseDestination(ws: WorkspaceAddress, query: URLSearchParams): Route {
  const suffix = query.toString();
  return `${workspacePath(ws)}${suffix ? `?${suffix}` : ""}` as Route;
}

/**
 * Where a workspace lives, in URLs and in API calls.
 *
 * A workspace slug is unique inside its organization, not across the
 * product — two companies both get to have a `docs`. So every address
 * carries the organization: `/w/<org>/<workspace>` for the pages people
 * open, and `<org>~<workspace>` for the single REST path segment the API
 * takes, where a slash would split the path.
 */
import {
  workspaceRefPath,
  workspaceRefName,
} from "@bcontext-dev/contract/workspace-ref";

/** The `<org>/<workspace>` pair a route carries; a slug alone addresses nothing. */
export interface WorkspaceAddress {
  org: string;
  slug: string;
}

/** The page URL: /w/<org>/<workspace>, plus anything below it. */
export function workspacePath(ws: WorkspaceAddress, sub = ""): string {
  const tail = sub ? `/${sub.replace(/^\/+/, "")}` : "";
  return `/w/${ws.org}/${ws.slug}${tail}`;
}

/** The API path segment: <org>~<workspace>. */
export function workspaceApiRef(ws: WorkspaceAddress): string {
  return workspaceRefPath(ws.org, ws.slug);
}

/** How a workspace is named to a person or to an agent: <org>/<workspace>. */
export function workspaceName(ws: WorkspaceAddress): string {
  return workspaceRefName(ws.org, ws.slug);
}

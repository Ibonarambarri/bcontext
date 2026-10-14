/**
 * What the workspace shell reads, once per request.
 *
 * The layout and the active page render in the same request and both need
 * the caller's workspace list and the node tree; `React.cache` collapses
 * those into one API call each. The cache lives for the request only, so a
 * workspace switch is a fresh fetch and the `force-dynamic` layout keeps its
 * live tree.
 *
 * Reach is the API's job. A workspace the person cannot see is missing from
 * the list and answers 404 on the tree; the page turns either into
 * `notFound()` and never has to know why.
 *
 * Everything here is addressed by the `<org>/<workspace>` pair the URL
 * carries — a bare slug names a workspace in every organization that chose
 * the same name, so the API resolves nothing from one.
 */
import { cache } from "react";
import { apiJson, apiJsonOrNull } from "@/web/api-client";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import type { KnowledgeNode, NodeSummary } from "@bcontext-dev/contract/types";
import type {
  OrganizationCard,
  WorkspaceCard,
  WorkspacesResponse,
} from "@bcontext-dev/contract/workspaces";

/**
 * The workspaces the signed-in person belongs to (every seeded one in demo).
 *
 * `?stats=1` is what carries the organization each workspace lives in, and a
 * slug means nothing without it: the shell has to tell `acme/docs` apart from
 * `globex/docs` both to pick the current one and to link to either.
 */
const listWorkspaceHub = cache(async (): Promise<WorkspacesResponse> => {
  const body = await apiJson<WorkspacesResponse>("/api/workspaces?stats=1");
  return { workspaces: body.workspaces, organizations: body.organizations ?? [] };
});

/** The workspaces the signed-in person can open, across every organization. */
export async function listWorkspaces(): Promise<WorkspaceCard[]> {
  return (await listWorkspaceHub()).workspaces;
}

/**
 * The organizations behind those workspaces, with their workspace and member
 * counts. The shell reads them for one reason only: to decide whether the
 * organization level is worth showing at all (`@/lib/org-layer`).
 */
export async function listOrganizations(): Promise<OrganizationCard[]> {
  return (await listWorkspaceHub()).organizations;
}

/** The current workspace, or null when it is not one of the caller's. */
export async function findWorkspace(ws: WorkspaceAddress): Promise<WorkspaceCard | null> {
  const workspaces = await listWorkspaces();
  return (
    workspaces.find(
      (item) => item.slug === ws.slug && item.organization.slug === ws.org,
    ) ?? null
  );
}

/**
 * The workspace index — every node the caller may see, without bodies.
 * Null when the workspace does not resolve for this person.
 */
export function listNodeSummaries(ws: WorkspaceAddress): Promise<NodeSummary[] | null> {
  return summariesByRef(workspaceApiRef(ws));
}

/** One node with its body, or null when it is not there for this person. */
export function getNode(ws: WorkspaceAddress, nodeId: string): Promise<KnowledgeNode | null> {
  return nodeByRef(workspaceApiRef(ws), nodeId);
}

/*
 * The memoised reads take the `<org>~<workspace>` ref rather than the pair,
 * because `React.cache` keys on argument identity: the layout and the page
 * each build their own `{ org, slug }` for the same workspace, and two
 * objects that are equal but not identical would be two fetches.
 */

const summariesByRef = cache(async (ref: string): Promise<NodeSummary[] | null> => {
  const body = await apiJsonOrNull<{ nodes: NodeSummary[] }>(
    `/api/nodes?workspace=${encodeURIComponent(ref)}`,
  );
  return body?.nodes ?? null;
});

const nodeByRef = cache(async (ref: string, nodeId: string): Promise<KnowledgeNode | null> => {
  const body = await apiJsonOrNull<{ node: KnowledgeNode }>(
    `/api/nodes/${encodeURIComponent(nodeId)}?workspace=${encodeURIComponent(ref)}`,
  );
  return body?.node ?? null;
});

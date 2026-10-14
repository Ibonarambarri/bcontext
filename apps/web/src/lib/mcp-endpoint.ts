/**
 * The shape of Bcontext's MCP endpoint URLs, in one place.
 *
 * The API serves the root `/mcp` (the credential decides the workspace) and
 * one endpoint per workspace, `/mcp/<org>/<workspace>`, whose OAuth tokens
 * are bound to that workspace. Two things in the web need to agree on that
 * shape: the "Add agent" box builds the URL for the workspace the person is
 * in, and the consent screen reads the URL a client asked for back into a
 * workspace (the `resource` parameter of RFC 8707). Both come through here
 * so the two can never drift.
 *
 * Pure, no React, no I/O — `mcp-endpoint.test.ts` pins the parsing.
 */
import type { WorkspaceAddress } from "@/web/workspace-url";

/** Where a client snippet points and what it files the server under. */
export interface McpTarget {
  /** The workspace endpoint, `<origin>/mcp/<org>/<ws>`. */
  endpoint: string;
  /** The key under `mcpServers` (or the CLI's server name): `bcontext-<org>-<ws>`. */
  serverName: string;
}

/** Both halves of a target for one workspace, from the origin a person has open. */
export function mcpTargetFor(origin: string, ws: WorkspaceAddress): McpTarget {
  return { endpoint: workspaceMcpEndpoint(origin, ws), serverName: mcpServerName(ws) };
}

/** The workspace-bound endpoint: `<origin>/mcp/<org>/<workspace>`. */
export function workspaceMcpEndpoint(origin: string, ws: WorkspaceAddress): string {
  return `${origin.replace(/\/+$/, "")}/mcp/${ws.org}/${ws.slug}`;
}

/**
 * The key a client config files the server under. Per workspace, so a
 * project folder can carry its own `.mcp.json` next to another project's
 * without the two entries colliding.
 */
export function mcpServerName(ws: WorkspaceAddress): string {
  return `bcontext-${ws.org}-${ws.slug}`;
}

/** What a `resource` URL names, when it is one of ours. */
export type McpResource =
  | { kind: "root" }
  | { kind: "workspace"; org: string; slug: string };

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reads the `resource` an MCP client sent to the consent screen. Lenient on
 * the noise a client may add — a trailing slash, a query, a fragment — and
 * strict on the rest: only the app's own origin counts, and the path must
 * be exactly `/mcp` or `/mcp/<org>/<workspace>`. Anything else (absent,
 * a foreign origin, garbage, a deeper path) is `null`: the consent screen
 * then behaves as if no resource were given and lets the API, which sees
 * the same field, be the authority.
 */
export function parseMcpResource(
  resource: string | null | undefined,
  appOrigin: string,
): McpResource | null {
  if (!resource) return null;
  let url: URL;
  let origin: URL;
  try {
    url = new URL(resource);
    origin = new URL(appOrigin);
  } catch {
    return null;
  }
  if (url.origin !== origin.origin) return null;
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts[0] !== "mcp") return null;
  if (parts.length === 1) return { kind: "root" };
  if (parts.length !== 3) return null;
  const [, org, slug] = parts as [string, string, string];
  if (!SEGMENT.test(org) || !SEGMENT.test(slug)) return null;
  return { kind: "workspace", org, slug };
}

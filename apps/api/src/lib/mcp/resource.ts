/**
 * The MCP server as an OAuth protected resource (RFC 9728, RFC 8707).
 *
 * There is one MCP endpoint per workspace, `/mcp/<org>/<workspace>`, next to
 * the root `/mcp` that picks the workspace from the token or a header. Every
 * piece of the product that has to name one of them as a URL — the 401 that
 * tells a client where discovery lives, the protected-resource document, the
 * `resource` parameter an MCP client sends to the authorize and token
 * endpoints — goes through here, so the spelling is decided once.
 *
 * Called by the `/mcp` routes, the `/.well-known/oauth-protected-resource`
 * routes and the OAuth authorize/token endpoints. Nothing here touches the
 * database: whether a workspace exists is the caller's question, asked only
 * where the answer is not a leak.
 */
import { appUrl as configuredAppUrl } from "@/lib/env";
import { parseWorkspaceRef, workspaceRefName, type WorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

/**
 * The origin the server names itself by: the configured app URL when there
 * is one (links and discovery documents must agree with what the web app
 * proxies), the request's own origin otherwise.
 */
export function baseUrlFor(req: Request): string {
  const env = configuredAppUrl();
  if (env) return env.replace(/\/$/, "");
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Every origin a client may legitimately have been configured with. The web
 * app proxies `/mcp` to the API, so a client can be pointed at either host and
 * will send the one it knows as `resource`; both are this server.
 */
function acceptedBases(req: Request): string[] {
  const u = new URL(req.url);
  const own = `${u.protocol}//${u.host}`;
  const configured = configuredAppUrl()?.replace(/\/$/, "");
  return configured && configured !== own ? [configured, own] : [own];
}

/** `<base>/mcp` for the root endpoint, `<base>/mcp/<org>/<workspace>` for a workspace's. */
export function mcpResourceUrl(base: string, workspaceRef?: string | null): string {
  return workspaceRef ? `${base}/mcp/${workspaceRef}` : `${base}/mcp`;
}

/**
 * Where the protected-resource metadata of an endpoint lives. RFC 9728 §3.1:
 * the resource's path is appended to the well-known path, so a client that
 * only knows `/mcp/acme/docs` can find the document without guessing.
 */
export function protectedResourceMetadataUrl(base: string, workspaceRef?: string | null): string {
  const wellKnown = `${base}/.well-known/oauth-protected-resource`;
  return workspaceRef ? `${wellKnown}/mcp/${workspaceRef}` : wellKnown;
}

/** The RFC 9728 document for one endpoint. Same content for all of them but the `resource`. */
export function protectedResourceMetadata(base: string, workspaceRef?: string | null): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(base, workspaceRef),
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["nodes:read", "nodes:write", "chat:run", "agents:read", "agents:write"],
    resource_documentation: `${base}/docs/quickstart`,
  };
}

/** What a `resource` parameter names once it has been read. */
export type McpResource =
  | { kind: "root" }
  | { kind: "workspace"; ref: WorkspaceRef; name: string };

/**
 * Read the `resource` an MCP client sent (RFC 8707). A trailing slash, a
 * query string or a fragment are tolerated; a different host, a different
 * path or a malformed workspace pair are not, and come back as null so the
 * caller answers `invalid_target`. An absent parameter comes back as
 * undefined and binds nothing: clients that predate resource indicators
 * keep working unchanged.
 */
export function parseMcpResource(
  req: Request,
  resource: string | null | undefined,
): McpResource | null | undefined {
  const raw = (resource ?? "").trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const origin = `${url.protocol}//${url.host}`;
  if (!acceptedBases(req).includes(origin)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/mcp") return { kind: "root" };
  if (!path.startsWith("/mcp/")) return null;
  const ref = parseWorkspaceRef(path.slice("/mcp/".length));
  if (!ref) return null;
  return { kind: "workspace", ref, name: workspaceRefName(ref.org, ref.workspace) };
}

/**
 * The MCP Streamable HTTP transport: bearer auth, workspace resolution,
 * permission narrowing, then one fresh server per request.
 *
 * Called by the two route families that serve it — `/mcp`, where the token
 * (or a header) says which workspace, and `/mcp/<org>/<workspace>`, where
 * the path does. Everything else is the same request, which is why the
 * routes are two lines each and this is where the behaviour lives.
 *
 * Stateless mode: every request creates a fresh transport. This trades
 * resumability/sessions for simplicity; stateful sessions can come later
 * behind a workspace setting.
 *
 * Not to be broken: an unauthenticated call answers 401 with the
 * `resource_metadata` hint of the endpoint that was called (MCP clients run
 * OAuth discovery from it); a workspace the caller cannot reach is a 404
 * indistinguishable from one that does not exist.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { gate, resolveAgentWorkspaceOr401, actingUserId } from "@/lib/auth/require";
import { buildMcpServer } from "@/lib/mcp/server";
import { baseUrlFor, protectedResourceMetadataUrl } from "@/lib/mcp/resource";
import { agentDisplayName } from "@/lib/agents/names";
import { annotateRequest } from "@bcontext-dev/contract/correlation";

export interface McpRequestOptions {
  /**
   * `<org>/<workspace>` when the path names the workspace. For a user token
   * it replaces the `X-Bcontext-Workspace` header; for a workspace token it
   * must be the token's own workspace.
   */
  workspaceRef?: string;
}

function mcpWwwAuthenticate(req: Request, workspaceRef?: string): string {
  // Per MCP authorization spec (2025-06-18): every 401 from a protected
  // MCP resource MUST advertise the protected-resource metadata URL so
  // clients can run OAuth discovery without out-of-band knowledge. The
  // per-workspace endpoint points at its own document, so the OAuth that
  // follows is bound to that workspace.
  const resourceMetadata = protectedResourceMetadataUrl(baseUrlFor(req), workspaceRef);
  return `Bearer realm="bcontext", resource_metadata="${resourceMetadata}"`;
}

function workspaceNotFound(workspaceRef?: string): Response {
  return Response.json(
    {
      error: "workspace_not_found",
      message: workspaceRef
        ? `workspace "${workspaceRef}" not found. Generate a token for it or check the /mcp/<organization>/<workspace> path.`
        : "workspace not found. Generate a new token or pass a valid X-Bcontext-Workspace header.",
    },
    { status: 404 },
  );
}

export async function handleMcpRequest(req: Request, options: McpRequestOptions = {}): Promise<Response> {
  const { workspaceRef: pathRef } = options;
  // MCP requires a bearer token. No scope is enforced at the transport
  // layer — individual tools call requireScope themselves. `allowAnonymous`
  // lets us reach the spec-compliant 401 below instead of gate()'s generic
  // 401 (which lacks the resource_metadata hint MCP clients rely on).
  const gated = await gate(req, undefined, { allowAnonymous: true });
  if (gated instanceof Response) {
    // Invalid-token path: gate already returned 401 invalid_token. Enrich
    // its WWW-Authenticate so the client can rediscover OAuth and retry.
    if (gated.status === 401) {
      const headers = new Headers(gated.headers);
      headers.set("WWW-Authenticate", mcpWwwAuthenticate(req, pathRef));
      return new Response(gated.body, {
        status: gated.status,
        headers,
      });
    }
    return gated;
  }
  if (gated.kind !== "agent" && gated.kind !== "agent_user") {
    // Anonymous / cookie-session callers don't have MCP tokens. Tell them
    // where to find OAuth discovery so MCP clients (Claude Desktop, Cursor,
    // Claude Code) launch the browser-based consent dance.
    return Response.json(
      {
        error: "bearer_required",
        message:
          "MCP requires authentication. Your client should follow the OAuth flow advertised in WWW-Authenticate.",
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": mcpWwwAuthenticate(req, pathRef) },
      },
    );
  }

  // Telemetry for the request log. `principal_kind` and the JSON-RPC method
  // are known here (`rpc_method`, because `method` on that line is the HTTP
  // verb); `tool`/`op` are added by the server when a tools/call actually
  // runs, and `bytes_out` once the response exists.
  annotateRequest({ principal_kind: gated.kind, rpc_method: await jsonRpcMethod(req) });

  // Workspace-scoped tokens carry their workspace_id directly (and the path,
  // when there is one, has to agree with it). User-scoped tokens pick a
  // workspace per request from the path, else the X-Bcontext-Workspace
  // header (or ?workspace=); membership is verified inside the helper.
  const resolved = await resolveAgentWorkspaceOr401(req, gated, { workspaceRef: pathRef });
  if (resolved instanceof Response) return resolved;

  const { getStorageById } = await import("@/lib/storage");
  const inner = await getStorageById(resolved.workspaceId);
  if (!inner) return workspaceNotFound(pathRef);

  // Every tool reads through `ctx.storage`, so narrowing it here narrows all 42
  // at once — the MCP is the best-canalised surface in the repo, which is why
  // this is three lines rather than a migration.
  const { resolveGrant, isDenied } = await import("@/lib/auth/grants");
  const { scopedStorage } = await import("@/lib/storage/scoped");
  const grant = await resolveGrant(gated, resolved.workspaceId);
  if (isDenied(grant)) {
    // Same shape as a missing workspace: a distinct "forbidden" would tell a
    // token holder that a workspace it cannot touch exists.
    return workspaceNotFound(pathRef);
  }
  const storage = scopedStorage(inner, grant);

  const { workspaceRefFor } = await import("@/lib/workspaces/ref");
  const [workspaceRef, agentLabel] = await Promise.all([
    // The full `<org>/<workspace>` name: what the agent echoes back, writes
    // into a config, or hands to a person. A bare slug would name several.
    workspaceRefFor(storage.workspace),
    // Who is writing, by name. Cached, never throws; null leaves the feed on
    // its labelled-id fallback. See `@/lib/agents/names`.
    agentDisplayName(gated.agentId),
  ]);
  const server = buildMcpServer({
    workspaceId: resolved.workspaceId,
    workspaceRef,
    scopes: gated.scopes,
    tokenId: gated.tokenId,
    storage,
    grant,
    tokenScope: gated.kind === "agent" ? "workspace" : "user",
    userId: gated.kind === "agent_user" ? gated.userId : undefined,
    agentId: gated.agentId ?? undefined,
    agentLabel: agentLabel ?? undefined,
    subjectUserId: actingUserId(gated),
  });
  // Best-effort provider attribution: persist the MCP initialize
  // clientInfo (e.g. "claude-code", "cursor-vscode") on the durable agent
  // identity so the Agents page can show the real runtime. The columns
  // ship in migration 0052 — until it is applied the update is a silent
  // no-op (Supabase returns an error we deliberately ignore).
  const agentId = gated.agentId ?? null;
  if (agentId) {
    server.oninitialized = () => {
      const info = server.getClientVersion();
      if (!info?.name) return;
      void (async () => {
        try {
          const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
          await getSupabaseAdmin()
            .from("agents")
            .update({
              client_name: String(info.name).slice(0, 200),
              client_version: info.version ? String(info.version).slice(0, 100) : null,
            })
            .eq("id", agentId);
        } catch {
          // Never let telemetry break the MCP request path.
        }
      })();
    };
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return withBytesOut(await transport.handleRequest(req));
}

/**
 * The JSON-RPC method of a POST body (`initialize`, `tools/list`,
 * `tools/call`…), read from a clone so the transport still gets the stream.
 * Anything that is not a single JSON-RPC object — a batch, a GET, a broken
 * body — reads as unknown; the transport reports those on its own terms.
 */
async function jsonRpcMethod(req: Request): Promise<string | undefined> {
  if (req.method !== "POST") return undefined;
  try {
    const body = (await req.clone().json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const method = (body as { method?: unknown }).method;
      return typeof method === "string" ? method : undefined;
    }
  } catch {
    // Not JSON: the transport will answer with a parse error.
  }
  return undefined;
}

/**
 * Size of what went back to the agent. JSON responses (every tool result in
 * stateless mode) are buffered to count them; that costs one copy of a
 * payload that already sits in memory. An SSE stream is left alone — its
 * length is not known until the client hangs up, and holding it here would
 * turn a stream into a wait.
 */
async function withBytesOut(res: Response): Promise<Response> {
  if (!res.body) {
    annotateRequest({ bytes_out: 0 });
    return res;
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return res;
  const buf = await res.arrayBuffer();
  annotateRequest({ bytes_out: buf.byteLength });
  return new Response(buf, {
    status: res.status,
    statusText: res.statusText,
    headers: new Headers(res.headers),
  });
}

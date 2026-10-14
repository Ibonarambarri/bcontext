/**
 * The MCP endpoint of one workspace: `/mcp/<org>/<workspace>`.
 *
 *   POST /mcp/:org/:workspace   — JSON-RPC requests
 *   GET  /mcp/:org/:workspace   — SSE stream for server-pushed messages
 *
 * The path fixes the workspace, so a project folder can carry its own
 * `.mcp.json` and the OAuth a client runs from here is bound to that
 * workspace (the 401 advertises this endpoint's own protected-resource
 * document). A user token is checked for membership like an explicit
 * `X-Bcontext-Workspace`; a workspace token must belong to this workspace.
 * A pair that is not well-formed is a 404 like a workspace that does not
 * exist — the path is public, the answer must not say more than that.
 */
import { handleMcpRequest } from "@/lib/mcp/http";
import { withRoute } from "@/lib/route";
import { parseWorkspaceRef, workspaceRefName } from "@bcontext-dev/contract/workspace-ref";

type Params = { params: Promise<{ org: string; workspace: string }> };

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { org, workspace } = await params;
  const ref = parseWorkspaceRef(workspaceRefName(org, workspace));
  if (!ref) {
    return Response.json(
      { error: "workspace_not_found", message: `workspace "${org}/${workspace}" not found` },
      { status: 404 },
    );
  }
  return handleMcpRequest(req, { workspaceRef: workspaceRefName(ref.org, ref.workspace) });
}

export const POST = withRoute(handle);

export const GET = withRoute(handle);

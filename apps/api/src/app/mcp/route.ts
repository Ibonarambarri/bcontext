/**
 * The root MCP endpoint: the token (or `X-Bcontext-Workspace`) says which
 * workspace. `/mcp/<org>/<workspace>` is the per-workspace form.
 *
 *   POST /mcp   — JSON-RPC requests
 *   GET  /mcp   — SSE stream for server-pushed messages
 *
 * The transport itself lives in `@/lib/mcp/http`, shared with the
 * per-workspace route.
 */
import { handleMcpRequest } from "@/lib/mcp/http";
import { withRoute } from "@/lib/route";

export const POST = withRoute(async (req: Request) => handleMcpRequest(req));

export const GET = withRoute(async (req: Request) => handleMcpRequest(req));

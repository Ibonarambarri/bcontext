/**
 * GET /.well-known/oauth-authorization-server
 *
 * Authorization-server metadata document per RFC 8414. MCP clients hit
 * this to discover the authorize / token / register endpoints + the
 * supported PKCE methods.
 */
import { withRoute } from "@/lib/route";
import { baseUrlFor } from "@/lib/mcp/resource";
import { authorizationServerMetadata } from "@/lib/auth/oauth";

export const GET = withRoute(async (req: Request) => {
  return Response.json(authorizationServerMetadata(baseUrlFor(req)), {
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
});

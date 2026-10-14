/**
 * GET /.well-known/oauth-protected-resource
 *
 * Per the MCP authorization spec (2025 revision): the protected MCP
 * server publishes this document so MCP clients can discover which
 * authorization server to use. Pointed at by the `resource_metadata=`
 * parameter that the /mcp 401 response carries in its `WWW-Authenticate`
 * header. The per-workspace endpoints publish theirs under
 * `/.well-known/oauth-protected-resource/mcp/<org>/<workspace>`.
 *
 * Body shape mirrors RFC 9728 (OAuth 2.0 Protected Resource Metadata).
 */
import { withRoute } from "@/lib/route";
import { baseUrlFor, protectedResourceMetadata } from "@/lib/mcp/resource";

export const GET = withRoute(async (req: Request) => {
  return Response.json(protectedResourceMetadata(baseUrlFor(req)), {
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
});

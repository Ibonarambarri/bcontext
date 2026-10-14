/**
 * POST /api/capabilities/discover — list the tools a provider exposes before
 * registering it. The Connections page calls it when the admin pastes an
 * endpoint; session-cookie owner|admin (`capabilityAdmin`).
 */
import { z } from "zod";
import { capabilityAdmin, parseJson } from "@/lib/capabilities/admin";
import { CapabilityConnectionInputSchema } from "@/lib/capabilities/admin-schemas";
import { CapabilityDiscoveryError, discoverProviderTools } from "@/lib/capabilities/discover";
import { withRoute } from "@/lib/route";

const DiscoverSchema = z.object({
  workspace_id: z.string().uuid(),
  connection: CapabilityConnectionInputSchema,
});

// The discovery itself lives in `@/lib/capabilities/discover` so the MCP
// `capabilities(op=discover)` tool and this route see exactly the same tools
// under the same egress rules.
export const POST = withRoute(async (req: Request) => {
  const input = await parseJson(req, DiscoverSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;
  try {
    return Response.json(await discoverProviderTools({
      workspaceId: input.workspace_id,
      userId: auth.userId,
      connection: input.connection,
    }));
  } catch (error) {
    if (error instanceof CapabilityDiscoveryError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.httpStatus });
    }
    throw error;
  }
});

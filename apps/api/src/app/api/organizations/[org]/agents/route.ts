/**
 * GET /api/organizations/[org]/agents — every agent connected anywhere in the
 * organization, with the workspaces it reaches and the scopes it holds there.
 *
 * The same rows `/api/agents/connections` serves one workspace at a time, but
 * transposed: an administrator asking "what can read our data" cannot answer
 * it a project at a time.
 */
import { gateOrgAdmin } from "@/lib/organizations/admin";
import { listOrgAgents } from "@/lib/organizations/agents";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string }> },
) => {
  const { org } = await params;
  const gated = await gateOrgAdmin(req, org, { platformAdmin: "read" });
  if (gated instanceof Response) return gated;

  return Response.json(await listOrgAgents(gated.org.id));
});

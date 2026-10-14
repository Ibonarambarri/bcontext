/**
 * GET /api/organizations/[org]/usage — what this organization is consuming
 * this month, measured. See `src/lib/organizations/usage.ts` for what each
 * figure is and, more importantly, what it is not: nothing here is priced.
 */
import { gateOrgAdmin } from "@/lib/organizations/admin";
import { getOrgUsage } from "@/lib/organizations/usage";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string }> },
) => {
  const { org } = await params;
  const gated = await gateOrgAdmin(req, org, { platformAdmin: "read" });
  if (gated instanceof Response) return gated;

  return Response.json(await getOrgUsage(gated.org.id));
});

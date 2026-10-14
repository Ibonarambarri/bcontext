/**
 * GET /api/admin/organizations/health — one row per organization answering,
 * without a second click, whether anyone accepted, whether anyone has ever
 * signed in, whether an agent has ever connected, and whether the place is
 * still moving this month.
 *
 * This is the screen that makes onboarding twenty customers by hand possible:
 * without it those four questions cost twenty page visits and a model held in
 * somebody's head. Platform admins only.
 *
 * It survived `GET /api/admin/organizations` growing the same figures because
 * the two answer different questions. The list answers "show me this page of
 * customers, worst first" and is cut to a page; this answers "is anything
 * wrong anywhere" and is deliberately NOT paginated — the Overview's alarm
 * band counts every customer in trouble, and a band that counted the first
 * fifty would go quiet exactly as the platform grew. Both read the same
 * sweep and the same ladder (`adminOrgState`), so they cannot disagree.
 */
import { gateAdmin } from "@/lib/admin/access";
import { listAdminOrgHealth } from "@/lib/admin/orgs";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  return Response.json(await listAdminOrgHealth());
});

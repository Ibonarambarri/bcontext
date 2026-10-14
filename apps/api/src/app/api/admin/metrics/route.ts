/**
 * GET /api/admin/metrics?months=3
 *
 * Instance-wide usage (model calls, their cost, meeting time) for the most
 * recent N month buckets. Gated by ADMIN_EMAILS (`gateAdmin`). Read-only.
 */
import { withRoute } from "@/lib/route";
import { gateAdmin } from "@/lib/admin/access";
import { computeDashboard, recentPeriods } from "@/lib/admin/metrics";

export const GET = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;

  const monthsParam = Number(new URL(req.url).searchParams.get("months") ?? "3");
  const months = Math.min(12, Math.max(1, Number.isFinite(monthsParam) ? monthsParam : 3));
  const metrics = await computeDashboard(recentPeriods(months));
  return Response.json(metrics);
});

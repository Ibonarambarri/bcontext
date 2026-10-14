/**
 * GET /api/admin/users/[id] — one person, everything the platform knows about
 * them: where they can work, what they connected, and whether any of it has
 * been used. The list answers "who is here"; this answers what follows.
 *
 * Platform admins only.
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import { AdminOrgError, getAdminUserDetail } from "@/lib/admin/orgs";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    return Response.json(await getAdminUserDetail(id));
  } catch (err) {
    if (err instanceof AdminOrgError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

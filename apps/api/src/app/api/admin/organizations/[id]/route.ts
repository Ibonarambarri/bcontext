/**
 * GET   /api/admin/organizations/[id] — one organization with its roster, its
 *       workspaces and every invitation ever issued for it, taken or not.
 * PATCH /api/admin/organizations/[id] — rename it.
 *
 * Platform admins only.
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import { AdminOrgError, getAdminOrgDetail, updateAdminOrg } from "@/lib/admin/orgs";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const PatchSchema = z.object({
  name: z.string().trim().min(1, "The organization needs a name."),
});

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
    return Response.json(await getAdminOrgDetail(id));
  } catch (err) {
    if (err instanceof AdminOrgError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = PatchSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  try {
    return Response.json(await updateAdminOrg(id, parsed.data, admin.userId));
  } catch (err) {
    if (err instanceof AdminOrgError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

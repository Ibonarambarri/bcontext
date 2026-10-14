/**
 * POST /api/admin/organizations/[id]/invites — another way into an existing
 * organization. Returns the link; sending it is a separate act.
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import { AdminOrgError, createAdminInvite } from "@/lib/admin/orgs";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(["owner", "admin", "editor", "viewer"]).default("admin"),
  /** Workspace ids the person joins. Meaningless for owners and admins,
      whose organization role already reaches every workspace. */
  workspaces: z.array(z.string().uuid()).max(100).optional(),
});

export const POST = withRoute(async (
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
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  try {
    const invite = await createAdminInvite({
      organizationId: id,
      email: parsed.data.email,
      role: parsed.data.role,
      adminUserId: admin.userId,
      workspaceIds: parsed.data.workspaces,
    });
    return Response.json({ invite }, { status: 201 });
  } catch (err) {
    if (err instanceof AdminOrgError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

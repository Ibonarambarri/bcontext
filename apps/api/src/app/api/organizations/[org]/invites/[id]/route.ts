/**
 * DELETE /api/organizations/[org]/invites/[id] — withdraw an invitation that
 * has not been accepted. The link dies with the row.
 */
import { z } from "zod";
import { gateOrgAdmin, revokeOrgInvite } from "@/lib/organizations/admin";
import { withRoute } from "@/lib/route";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; id: string }> },
) => {
  const { org, id } = await params;
  const gated = await gateOrgAdmin(req, org);
  if (gated instanceof Response) return gated;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  // Scoped to the organization the caller administers, so an id belonging to
  // another company's invitation revokes nothing.
  await revokeOrgInvite(gated.org.id, id);
  return Response.json({ ok: true });
});

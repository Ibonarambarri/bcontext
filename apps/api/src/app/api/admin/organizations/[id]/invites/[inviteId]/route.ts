/**
 * DELETE /api/admin/organizations/[id]/invites/[inviteId] — revoke a pending
 * invitation. The link dies with the row.
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import { revokeAdminInvite } from "@/lib/admin/orgs";
import { withRoute } from "@/lib/route";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string; inviteId: string }> },
) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  const { id, inviteId } = await params;
  const uuid = z.string().uuid();
  if (!uuid.safeParse(id).success || !uuid.safeParse(inviteId).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  await revokeAdminInvite(id, inviteId);
  return Response.json({ ok: true });
});

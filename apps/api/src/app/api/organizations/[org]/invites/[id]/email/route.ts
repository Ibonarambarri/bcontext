/**
 * POST /api/organizations/[org]/invites/[id]/email — send the branded email
 * for an invitation that already exists.
 *
 * Its own route, and a POST asked for by name, because this is the only step
 * in the flow that cannot be undone: the link can be revoked, the role
 * changed, the organization renamed — an email that left cannot be recalled.
 * The outcome is written back on the invitation so a failed send is visible
 * rather than assumed, and the link is still there to fall back on.
 */
import { z } from "zod";
import { OrgAdminError, gateOrgAdmin, sendOrgInviteEmail } from "@/lib/organizations/admin";
import { withRoute } from "@/lib/route";

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; id: string }> },
) => {
  const { org, id } = await params;
  const gated = await gateOrgAdmin(req, org);
  if (gated instanceof Response) return gated;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const invite = await sendOrgInviteEmail(gated.org.id, id);
    return Response.json({
      status: invite.email_status ?? "error",
      error: invite.email_error,
      invite,
    });
  } catch (err) {
    if (err instanceof OrgAdminError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

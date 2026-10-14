/**
 * POST /api/admin/invites/[id]/email — send the branded invitation email for
 * an invitation that already exists.
 *
 * Its own route, and a POST the admin has to ask for by name, because this
 * is the only step in the flow that cannot be undone: the link can be
 * revoked, the org renamed, the role changed — an email that left cannot be
 * recalled. The outcome is written back on the invitation so a failed send
 * is visible in the panel instead of assumed.
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import { AdminOrgError, sendInviteEmail } from "@/lib/admin/orgs";
import { withRoute } from "@/lib/route";

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
  try {
    const invite = await sendInviteEmail(id);
    return Response.json({
      status: invite.email_status ?? "error",
      error: invite.email_error,
      invite,
    });
  } catch (err) {
    if (err instanceof AdminOrgError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

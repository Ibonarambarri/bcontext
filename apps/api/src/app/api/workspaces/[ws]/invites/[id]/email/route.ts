/**
 * POST /api/workspaces/:ws/invites/:id/email — email a pending invitation.
 *
 * Creating the invitation only makes a link; this is where one leaves the
 * building, and it is a separate call for the reason `@/lib/auth/invitations`
 * spells out: every other action here is reversible inside the database, a
 * sent email is not. Scoped to the workspace's organisation, so an id from
 * another tenant sends nothing.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { AdminOrgError, sendInviteEmail } from "@/lib/admin/orgs";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) => {
  const { ws, id } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  if (ctx.actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (ctx.storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Invitations need Supabase." },
      { status: 400 },
    );
  }

  // The invitation must belong to this organisation — `sendInviteEmail`
  // reads by id alone, so the tenancy check happens here.
  const { data: row } = await getSupabaseAdmin()
    .from("workspace_invites")
    .select("id")
    .eq("id", id)
    .eq("organization_id", ctx.storage.workspace.organization_id)
    .maybeSingle();
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

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

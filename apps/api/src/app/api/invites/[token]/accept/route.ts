/**
 * POST /api/invites/:token/accept — join, as the signed-in person.
 *
 * `acceptInvitation` takes both kinds of invitation — the role-keyed ones the
 * members screen writes and the verb-and-reach ones written over MCP — and
 * re-checks the promise against what the inviter holds now. A refusal is a
 * 400 with the reason in `message`, which is what the page shows.
 */
import { gate } from "@/lib/auth/require";
import { acceptInvitation } from "@/lib/auth/invitations";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { findInviteByToken } from "@/lib/workspaces/orgs";
import type { InviteAccepted } from "@bcontext-dev/contract/workspaces";

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to accept an invitation." },
      { status: 401 },
    );
  }
  const { token } = await params;
  // The org is read before acceptance consumes the token; it is what names
  // the workspace the page lands in afterwards.
  const invite = await findInviteByToken(token);
  if (!invite) {
    return Response.json(
      { error: "not_found", message: "Invitation is invalid or expired." },
      { status: 404 },
    );
  }

  const { data } = await getSupabaseForRequest(req).auth.getUser();
  const result = await acceptInvitation(token, {
    id: gated.userId,
    email: data.user?.email ?? null,
  });
  if ("error" in result) {
    return Response.json({ error: "invite_rejected", message: result.error }, { status: 400 });
  }

  // Where the person lands: the first workspace the invitation named. An
  // owner or admin was invited to the organization rather than to a list of
  // projects, so they get null and land on the hub, which now shows them
  // everything their organization holds.
  const wanted = invite.workspace_ids ?? [];
  const { data: ws } = wanted.length
    ? await getSupabaseAdmin()
        .from("workspaces")
        .select("slug")
        .eq("organization_id", invite.organization_id)
        .in("id", wanted)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const accepted: InviteAccepted = {
    orgSlug: result.orgSlug,
    workspaceSlug: (ws?.slug as string | undefined) ?? null,
  };
  return Response.json(accepted);
});

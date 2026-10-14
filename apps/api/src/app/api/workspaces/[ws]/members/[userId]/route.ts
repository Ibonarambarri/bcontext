/**
 * PATCH  /api/workspaces/:ws/members/:userId — change a member's role.
 * DELETE /api/workspaces/:ws/members/:userId — remove them.
 *
 * The roster's row controls. Both need the admin verb on the workspace, held
 * by a person; a token that wants to hand out access has `grant_access` over
 * MCP, which speaks verbs and reach rather than roles.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { syncGrantFromMembership } from "@/lib/auth/grant-sync";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { removeMember, updateMemberRole } from "@/lib/workspaces/orgs";
import type { WorkspaceContext } from "@/lib/auth/workspace";

const Body = z.object({
  role: z.enum(["owner", "admin", "editor", "viewer"]),
});

async function openForManagement(
  req: Request,
  ws: string,
): Promise<(WorkspaceContext & { actor: { kind: "user"; userId: string } }) | Response> {
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  if (ctx.actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (ctx.storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Members need Supabase." },
      { status: 400 },
    );
  }
  return ctx as WorkspaceContext & { actor: { kind: "user"; userId: string } };
}

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; userId: string }> },
) => {
  const { ws, userId } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", message: "role must be owner, admin, editor or viewer" }, { status: 400 });
  }
  const { role } = parsed.data;
  const workspaceId = ctx.storage.workspace.id;

  const admin = getSupabaseAdmin();
  await admin
    .from("memberships")
    .update({ role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  // Mirrored into the grant table in the same breath: the grant is
  // authoritative, so a role change that did not reach it would leave the
  // old verbs live.
  //
  // Without `reinstate`, deliberately: `revokeAccess` does not touch
  // `memberships`, so a revoked person is still on this screen. Re-picking a
  // role for them must not quietly restore access an admin took away.
  await syncGrantFromMembership(workspaceId, userId, role);
  await updateMemberRole(ctx.storage.workspace.organization_id, userId, role);
  return Response.json({ ok: true, role });
});

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; userId: string }> },
) => {
  const { ws, userId } = await params;
  const ctx = await openForManagement(req, ws);
  if (ctx instanceof Response) return ctx;
  if (userId === ctx.actor.userId) {
    return Response.json(
      { error: "self_removal", message: "You can't remove yourself. Transfer ownership first." },
      { status: 400 },
    );
  }
  const workspaceId = ctx.storage.workspace.id;

  const admin = getSupabaseAdmin();
  await admin
    .from("memberships")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  // Removing the membership revokes the grant: revocation happens at write
  // time, not on every read.
  await syncGrantFromMembership(workspaceId, userId, null);
  // The workspace IS the org, so org-level access goes with it.
  await removeMember(ctx.storage.workspace.organization_id, userId);
  return Response.json({ ok: true });
});

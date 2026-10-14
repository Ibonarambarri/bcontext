/**
 * POST /api/workspaces/:ws/invites — invite an address with a role.
 *
 * The roster's invite form. The list of pending invitations rides on
 * `GET /api/workspaces/:ws/members`, which already returns it beside the
 * roster; a second listing here would be the same rows twice.
 *
 * Role-keyed on purpose: this is the members screen, and the members screen
 * speaks roles. Invitations that carry verbs and reach come from
 * `@/lib/auth/invitations` over MCP; both are accepted by the same route.
 *
 * Creating an invitation sends nothing. The reply carries the link, which
 * the roster shows for copying; emailing it is a second, deliberate call
 * (`POST /api/workspaces/:ws/invites/:id/email`) because a send is the one
 * step here that cannot be undone.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { createInvite } from "@/lib/workspaces/orgs";
import { inviteUrl } from "@/lib/app-url";
import type { WorkspaceInvite } from "@bcontext-dev/contract/workspaces";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(["owner", "admin", "editor", "viewer"]).default("editor"),
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  if (actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Invitations need Supabase." },
      { status: 400 },
    );
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
  const { email, role } = parsed.data;

  let created;
  try {
    created = await createInvite({
      organizationId: storage.workspace.organization_id,
      email,
      role,
      invitedBy: actor.userId,
      // From the roster, the invitation is to *this* workspace: the person
      // asking is looking at one project's team, not at the whole company.
      // An owner or admin needs no such row — their organization role
      // reaches every workspace — so the list is left empty for them.
      workspaceIds:
        role === "owner" || role === "admin" ? [] : [storage.workspace.id],
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error("invite failed");
  }

  const invite: WorkspaceInvite = {
    id: created.id,
    email: created.email,
    role: created.role,
    token: created.token,
    url: inviteUrl(created.token),
    expiresAt: created.expires_at,
    createdAt: created.created_at,
  };
  return Response.json({ invite }, { status: 201 });
});

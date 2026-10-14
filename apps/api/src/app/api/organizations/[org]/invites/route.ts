/**
 * POST /api/organizations/[org]/invites — the only way a person is added to a
 * company. Answers with the link and sends nothing: the email is its own
 * route, asked for by name, because it is the one act here that cannot be
 * undone.
 */
import { z } from "zod";
import { OrgAdminError, createOrgInvite, gateOrgAdmin } from "@/lib/organizations/admin";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  /** The least an invitation can be worth, so widening it is a deliberate act. */
  role: z.enum(["owner", "admin", "editor", "viewer"]).default("editor"),
  /** Ignored for owners and admins, whose org role reaches every workspace. */
  workspaces: z.array(z.string().uuid()).max(100).optional(),
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string }> },
) => {
  const { org } = await params;
  const gated = await gateOrgAdmin(req, org);
  if (gated instanceof Response) return gated;
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
    const invite = await createOrgInvite(
      gated.org.id,
      {
        email: parsed.data.email,
        role: parsed.data.role,
        workspaces: parsed.data.workspaces,
      },
      gated.actor.userId,
    );
    return Response.json({ invite }, { status: 201 });
  } catch (err) {
    if (err instanceof OrgAdminError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

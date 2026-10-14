/**
 * GET   /api/organizations/[org] — the company as its own administrators see
 *       it: the roster with each person's reach, the workspaces, and the
 *       invitations still outstanding with the link to hand over.
 * PATCH /api/organizations/[org] — rename it. The slug is an address people
 *       have bookmarked and agents have written down, so it never moves.
 */
import { z } from "zod";
import {
  OrgAdminError,
  gateOrgAdmin,
  getOrgAdminDetail,
  updateOrg,
} from "@/lib/organizations/admin";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const Body = z.object({
  name: z.string().trim().min(1, "The organization needs a name.").max(80),
});

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string }> },
) => {
  const { org } = await params;
  const gated = await gateOrgAdmin(req, org);
  if (gated instanceof Response) return gated;
  try {
    return Response.json(await getOrgAdminDetail(gated.org.id, gated.actor.userId));
  } catch (err) {
    return failure(err);
  }
});

export const PATCH = withRoute(async (
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
    await updateOrg(gated.org.id, { name: parsed.data.name });
    return Response.json(await getOrgAdminDetail(gated.org.id, gated.actor.userId));
  } catch (err) {
    return failure(err);
  }
});

function failure(err: unknown): Response {
  if (err instanceof OrgAdminError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
  }
  throw err;
}

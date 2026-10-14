/**
 * GET    /api/organizations/[org]/members/[userId] — one person in full: their
 *        role, the workspaces they reach, the agents they connected, and what
 *        all of that has spent this month.
 * PATCH  /api/organizations/[org]/members/[userId] — what somebody already in
 *        the company is, and which workspaces they reach. `workspaces` is the
 *        complete list, not an addition: it is reconciled, so unticking a box
 *        takes the access away.
 * DELETE /api/organizations/[org]/members/[userId] — out of the organization
 *        and out of every workspace it holds, membership and grant together.
 */
import { z } from "zod";
import {
  OrgAdminError,
  gateOrgAdmin,
  removeOrgMember,
  updateOrgMember,
} from "@/lib/organizations/admin";
import { getOrgMemberDetail } from "@/lib/organizations/member";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const Body = z
  .object({
    /** `agent` is missing on purpose: it is not a role a person holds. */
    role: z.enum(["owner", "admin", "editor", "viewer"]).optional(),
    workspaces: z.array(z.string().uuid()).max(100).optional(),
  })
  .refine((b) => b.role !== undefined || b.workspaces !== undefined, {
    message: "Nothing to change.",
  });

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; userId: string }> },
) => {
  const { org, userId } = await params;
  const gated = await gateOrgAdmin(req, org, { platformAdmin: "read" });
  if (gated instanceof Response) return gated;
  try {
    return Response.json(
      await getOrgMemberDetail(gated.org.id, userId, gated.actor.userId),
    );
  } catch (err) {
    return failure(err);
  }
});

export const PATCH = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; userId: string }> },
) => {
  const { org, userId } = await params;
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
    await updateOrgMember(
      gated.org.id,
      userId,
      { role: parsed.data.role, workspaces: parsed.data.workspaces },
      gated.actor.userId,
    );
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
});

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; userId: string }> },
) => {
  const { org, userId } = await params;
  const gated = await gateOrgAdmin(req, org);
  if (gated instanceof Response) return gated;
  try {
    await removeOrgMember(gated.org.id, userId, gated.actor.userId);
    return Response.json({ ok: true });
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

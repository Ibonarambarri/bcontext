/**
 * GET  /api/admin/organizations — a page of organizations, worst first, with
 *      the health figures the panel's ladder is derived from, their people
 *      count, their pending invitations and who owns them. Search (`q`, over
 *      name, slug and the owners' addresses) and `state` are applied
 *      to the whole set before it is cut, so a filter never answers about
 *      the page you happen to be on. Platform admins only.
 * POST /api/admin/organizations — create one and issue the invitation link
 *      that hands it to its first owner. Nothing is emailed here: the
 *      response carries the link, and sending it is a separate, explicit act
 *      (`POST /api/admin/invites/:id/email`).
 */
import { z } from "zod";
import { gateAdmin } from "@/lib/admin/access";
import { readListParams } from "@/lib/admin/list-params";
import { AdminOrgError, createAdminOrg, listAdminOrgs } from "@/lib/admin/orgs";
import {
  ADMIN_ORG_STATE_FILTERS,
  type AdminOrgStateFilter,
} from "@bcontext-dev/contract/admin-orgs";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";

const Body = z.object({
  name: z.string().trim().min(1, "The organization needs a name."),
  slug: z.string().trim().optional(),
  owner_email: z.string().trim().toLowerCase().email("Enter a valid owner email."),
  role: z.enum(["owner", "admin", "editor", "viewer"]).default("owner"),
});

export const GET = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  // A state nobody defined is a typo in a URL, and answering it with the
  // unfiltered list would look like "no such problem exists".
  if (state && !ADMIN_ORG_STATE_FILTERS.includes(state as AdminOrgStateFilter)) {
    return Response.json({ error: "invalid_state" }, { status: 400 });
  }
  return Response.json(
    await listAdminOrgs({
      ...readListParams(url),
      state: (state as AdminOrgStateFilter | null) ?? undefined,
    }),
  );
});

export const POST = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;
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
    const result = await createAdminOrg({
      name: parsed.data.name,
      slug: parsed.data.slug,
      ownerEmail: parsed.data.owner_email,
      role: parsed.data.role,
      adminUserId: admin.userId,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AdminOrgError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});

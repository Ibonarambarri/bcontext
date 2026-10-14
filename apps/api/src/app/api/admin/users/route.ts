/**
 * GET /api/admin/users — a page of everyone with an account and where they
 * belong. `q` (address), `organization`, `role` and `state` are applied
 * before the page is cut. Platform admins only. Personal zones are left out
 * of the org list: they are private space, not a place anyone is onboarded
 * into.
 *
 * The payload also says how far the answer reached. Accounts live in the
 * auth server, which pages and cannot be searched, so this list walks it and
 * stops at a cap — `capped` tells the panel that `total` counts matches
 * among the accounts scanned rather than among all of them. See
 * `listAdminUsers` for why the walk is the honest shape here.
 */
import { gateAdmin } from "@/lib/admin/access";
import { readListParams } from "@/lib/admin/list-params";
import { listAdminUsers } from "@/lib/admin/orgs";
import { withRoute } from "@/lib/route";
import {
  ADMIN_USER_STATES,
  type AdminUserState,
} from "@bcontext-dev/contract/admin-orgs";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";

const ROLES: readonly InviteRole[] = ["owner", "admin", "editor", "viewer"];

export const GET = withRoute(async (req: Request) => {
  const admin = await gateAdmin(req);
  if (admin instanceof Response) return admin;

  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (state && !ADMIN_USER_STATES.includes(state as AdminUserState)) {
    return Response.json({ error: "invalid_state" }, { status: 400 });
  }
  const role = url.searchParams.get("role");
  if (role && !ROLES.includes(role as InviteRole)) {
    return Response.json({ error: "invalid_role" }, { status: 400 });
  }

  return Response.json(
    await listAdminUsers({
      ...readListParams(url),
      organization: url.searchParams.get("organization") ?? undefined,
      role: (role as InviteRole | null) ?? undefined,
      state: (state as AdminUserState | null) ?? undefined,
    }),
  );
});

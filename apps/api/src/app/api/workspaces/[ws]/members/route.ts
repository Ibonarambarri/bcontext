/**
 * GET /api/workspaces/:ws/members — the Team tab: roster, pending invites and
 * the viewer's own role. Read verb via `openWorkspace`, session-cookie
 * callers only (see the handler's JSDoc). Invites are the organization's,
 * shown only to someone who administers it.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getOrgRoleForUser, listInvites } from "@/lib/workspaces/orgs";
import { inviteUrl } from "@/lib/app-url";
import { joinName } from "@bcontext-dev/contract/me";
import { namesFromUser } from "@/lib/auth/profile";

interface MemberRow {
  userId: string;
  email: string | null;
  /** Their profile name, joined; null while they have not given one. */
  name: string | null;
  role: "owner" | "admin" | "editor" | "viewer" | "agent";
  joined: string;
  isYou: boolean;
}

interface InviteRow {
  id: string;
  email: string;
  role: "owner" | "admin" | "editor" | "viewer";
  token: string;
  /** The link itself, so the roster can offer it for copying. */
  url: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Returns the member roster + pending invites + the viewer's role for a
 * workspace. Used by the in-workspace Settings dialog's Team tab so it can
 * surface the same invite controls /workspaces already shows server-side.
 *
 * Returns `{ members: [], invites: [], demo: true }` when the workspace
 * lives in demo storage — there's no auth-backed roster to expose.
 */
export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read", { scope: null });
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  // The roster is a user-session view; a bearer token has no business
  // enumerating the people in a workspace.
  if (gated.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (storage.backend !== "supabase") {
    return Response.json({
      members: [],
      invites: [],
      demo: true,
      role: null,
    });
  }

  const admin = getSupabaseAdmin();
  const { data: rows } = await admin
    .from("memberships")
    .select("user_id, role, created_at")
    .eq("workspace_id", storage.workspace.id)
    .order("created_at", { ascending: true });

  const meUserId = gated.userId;
  const orgId = storage.workspace.organization_id;
  const role = orgId ? await getOrgRoleForUser(meUserId, orgId) : null;
  const isAdmin = role === "owner" || role === "admin";

  const members: MemberRow[] = [];
  for (const m of (rows ?? []) as Record<string, unknown>[]) {
    const uid = m.user_id as string;
    const { data: u } = await admin.auth.admin.getUserById(uid);
    members.push({
      userId: uid,
      email: u?.user?.email ?? null,
      name: joinName(namesFromUser(u?.user)),
      role: m.role as MemberRow["role"],
      joined: m.created_at as string,
      isYou: meUserId === uid,
    });
  }

  let invites: InviteRow[] = [];
  if (isAdmin && orgId) {
    const raw = await listInvites(orgId);
    invites = raw
      .filter((i) => !i.accepted_at)
      .map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        token: i.token,
        url: inviteUrl(i.token),
        expiresAt: i.expires_at,
        createdAt: i.created_at,
      }));
  }

  return Response.json({
    members,
    invites,
    role,
    canManage: isAdmin,
  });
});

/**
 * GET /api/me/workspaces
 *
 * Lists the workspaces the caller can access. Used primarily by
 * multi-workspace bearer tokens to discover which slug to pass in the
 * `X-Bcontext-Workspace` header on subsequent requests.
 *
 * Accepts either a Supabase user session OR a bearer token:
 *   - `agent` (workspace-scoped token) → returns one element.
 *   - `agent_user` (multi-workspace token) → returns explicit agent access;
 *     legacy tokens fall back to user memberships.
 *   - `user` (cookie session) → returns current memberships.
 */
import { gate } from "@/lib/auth/require";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRoute } from "@/lib/route";

interface AccessibleWorkspace {
  id: string;
  slug: string;
  name: string;
  role: string | null;
}

export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;

  const admin = getSupabaseAdmin();

  if (gated.kind === "agent") {
    const { data, error } = await admin
      .from("workspaces")
      .select("id, slug, name")
      .eq("id", gated.workspaceId)
      .maybeSingle();
    if (error || !data) {
      return Response.json({ workspaces: [] satisfies AccessibleWorkspace[] });
    }
    const ws: AccessibleWorkspace = {
      id: data.id as string,
      slug: data.slug as string,
      name: data.name as string,
      role: null,
    };
    return Response.json({ workspaces: [ws] });
  }

  const userId =
    gated.kind === "agent_user" || gated.kind === "user"
      ? gated.userId
      : null;
  if (!userId) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="bcontext"' } },
    );
  }

  if (gated.kind === "agent_user" && gated.agentId) {
    const { data, error } = await admin
      .from("agent_workspace_access")
      .select("role, workspaces:workspace_id (id, slug, name)")
      .eq("agent_id", gated.agentId)
      .is("revoked_at", null);
    if (error) {
      return Response.json(
        { error: "internal", message: error.message },
        { status: 500 },
      );
    }
    const rows = ((data ?? []) as Array<{
      role: string | null;
      workspaces: { id: string; slug: string; name: string } | null;
    }>).flatMap((row) => row.workspaces ? [{
      id: row.workspaces.id,
      slug: row.workspaces.slug,
      name: row.workspaces.name,
      role: row.role,
    }] : []);
    rows.sort((a, b) => a.slug.localeCompare(b.slug));
    return Response.json({ workspaces: rows });
  }

  const { data, error } = await admin
    .from("memberships")
    .select("role, workspaces:workspace_id (id, slug, name)")
    .eq("user_id", userId);
  if (error) {
    return Response.json(
      { error: "internal", message: error.message },
      { status: 500 },
    );
  }
  const rows: AccessibleWorkspace[] = [];
  for (const row of (data ?? []) as Array<{
    role: string | null;
    workspaces: { id: string; slug: string; name: string } | null;
  }>) {
    if (!row.workspaces) continue;
    rows.push({
      id: row.workspaces.id,
      slug: row.workspaces.slug,
      name: row.workspaces.name,
      role: row.role ?? null,
    });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return Response.json({ workspaces: rows });
});

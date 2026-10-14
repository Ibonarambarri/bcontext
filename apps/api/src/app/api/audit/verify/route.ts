/**
 * GET /api/audit/verify?workspace=<slug>
 *
 * Walks the per-workspace Merkle chain in audit_log and returns
 * { rows, broken_at, broken_reason? }. broken_at is the id of the
 * first row whose recomputed row_hash disagrees with what's stored.
 * Null means the chain is intact.
 *
 * Restricted to workspace owners/admins via the storage resolver +
 * a membership check.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { verifyChain } from "@/lib/audit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json({ rows: 0, broken_at: null, backend: "demo" });
  }
  if (gated.kind === "user") {
    const sb = getSupabaseAdmin();
    const { data } = await sb
      .from("memberships")
      .select("role")
      .eq("user_id", gated.userId)
      .eq("workspace_id", storage.workspace.id)
      .maybeSingle();
    const role = (data?.role as string | undefined) ?? null;
    if (role !== "owner" && role !== "admin") {
      return Response.json(
        { error: "admin_required" },
        { status: 403 },
      );
    }
  }

  const result = await verifyChain(storage.workspace.id);
  return Response.json(result);
});

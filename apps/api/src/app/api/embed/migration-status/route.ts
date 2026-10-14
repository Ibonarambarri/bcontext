/**
 * GET /api/embed/migration-status — embedding-version migration progress.
 *
 * Returns `{ migrating_from, migrating_to, total, done, stale }` for the
 * caller's workspace. Used by operators to track a one-off
 * `scripts/reembed-stale.ts` run after `EMBEDDING_MODEL` changes.
 *
 * Query params:
 *   - `workspace=<slug>` (required when caller is a user; agents are scoped
 *     by token)
 */
import { gate, requireWorkspaceMember } from "@/lib/auth/require";
import { findWorkspaceByRef } from "@/lib/workspaces/resolve";
import { withRoute } from "@/lib/route";
import { isSupabaseConfigured } from "@/lib/demo-store";
import {
  currentEmbeddingVersion,
  summarizeMigration,
} from "@/lib/rag/embedding-version";

export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req, "nodes:read");
  if (gated instanceof Response) return gated;

  if (!isSupabaseConfigured()) {
    return Response.json({
      migrating_from: null,
      migrating_to: currentEmbeddingVersion(),
      total: 0,
      done: 0,
      stale: 0,
      skipped: "supabase not configured",
    });
  }

  const url = new URL(req.url);
  const workspaceSlug = url.searchParams.get("workspace");

  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const supa = getSupabaseAdmin();

  // Resolve workspace_id. Agents already carry one; users pass `?workspace=`.
  let workspaceId: string | null = null;
  if (gated.kind === "agent") {
    workspaceId = gated.workspaceId;
  } else if (workspaceSlug) {
    const ws = await findWorkspaceByRef(workspaceSlug, "id");
    workspaceId = (ws?.id as string | undefined) ?? null;
  }

  if (!workspaceId) {
    return Response.json(
      { error: "workspace not found or not specified" },
      { status: 400 },
    );
  }
  const denied = await requireWorkspaceMember(gated, {
    backend: "supabase",
    workspace: { id: workspaceId },
  });
  if (denied) return denied;

  // Fetch (version, count) pairs. We aggregate client-side because PostgREST
  // doesn't expose a `group_by` natively — the row count is small (one per
  // distinct model id, typically ≤ 2 during a migration).
  const { data, error } = await supa
    .from("embeddings")
    .select("embedding_version")
    .eq("workspace_id", workspaceId);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{
    embedding_version: string | null;
  }>) {
    const v = row.embedding_version ?? "legacy";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const rows = Array.from(counts.entries()).map(([embedding_version, count]) => ({
    embedding_version,
    count,
  }));

  return Response.json(summarizeMigration(rows));
});

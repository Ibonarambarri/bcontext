/**
 * POST /api/skills/push
 *
 * Manually trigger an AGENTS.md / CLAUDE.md / cursor-rules / clinerules
 * push to the workspace's GitHub-connected repos.
 *
 * Body: { workspace: <slug> }
 *
 * Returns the per-repo / per-file outcomes so the settings UI can show a
 * row-by-row pass/fail list.
 *
 * Push is also wired into the node-update path on `skill` nodes via the
 * outbound webhook system — this endpoint is for manual re-sync.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { pushSkillExports } from "@/lib/skills/push-to-github";

const Schema = z.object({ workspace: z.string().min(1) });

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // `write`, though the only thing it does to storage is read: this publishes
  // the workspace's skills to an outside GitHub repo, and the route already
  // demanded `nodes:write`. Asking for `read` here would let a read-only
  // principal export the graph, which is a lower bar than the one that stood.
  const ctx = await openWorkspace(req, parsed.data.workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json(
      { error: "supabase_required" },
      { status: 400 },
    );
  }
  const result = await pushSkillExports({
    workspaceId: storage.workspace.id,
    workspaceName: storage.workspace.name,
    storage,
  });
  return Response.json(result);
});

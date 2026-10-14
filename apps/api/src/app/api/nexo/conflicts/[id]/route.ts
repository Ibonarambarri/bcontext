/**
 * GET /api/nexo/conflicts/:id?workspace_id=<uuid>
 *
 * One conflict with the nodes it involves (id, title, kind) so the detail
 * view can link to them.
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getConflict, relatedNodes } from "@/lib/nexo/conflicts";

const QuerySchema = z.object({ workspace_id: z.string().uuid() });

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ workspace_id: url.searchParams.get("workspace_id") });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const ctx = await openWorkspaceById(req, parsed.data.workspace_id, "read");
  if (ctx instanceof Response) return ctx;
  if (ctx.storage.backend !== "supabase") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { id } = await params;
  const conflict = await getConflict(id, parsed.data.workspace_id);
  if (!conflict) return Response.json({ error: "not_found" }, { status: 404 });
  const related = await relatedNodes(ctx.storage, conflict);
  return Response.json({ conflict, related_nodes: related });
});

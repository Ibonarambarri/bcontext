/**
 * POST /api/tags/:id/merge — fold tag `:id` into `target_id`: every node and
 * relation that pointed at the absorbed tag now points at the target, and the
 * absorbed tag is gone. The tag manager's "merge duplicates" action; MCP has
 * it as `tags_write(op=merge)`. Verb `tags:delete` plus workspace admin.
 */
import { z } from "zod";
import { requireWorkspaceAdmin } from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import { TagConflictError, TagNotFoundError } from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

const MergeSchema = z.object({
  workspace: z.string().min(1),
  target_id: z.string().min(1),
});
export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = MergeSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  // `tags:delete`, not `tags:update`: a merge dissolves the absorbed tag and
  // rewrites the classification of everything that hung off it.
  const ctx = await openWorkspace(req, parsed.data.workspace, "tags:delete");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  const adminDenied = await requireWorkspaceAdmin(actor, storage);
  if (adminDenied) return adminDenied;
  const { id } = await params;
  try {
    const tag = await storage.mergeTags(id, parsed.data.target_id);
    if (storage.backend === "supabase") void wsBroadcast.graphChanged(storage.workspace.id, "taxonomy", "merged", id);
    return Response.json({ tag, merged_id: id });
  } catch (error) {
    if (error instanceof TagNotFoundError) return Response.json({ error: "not_found" }, { status: 404 });
    if (error instanceof TagConflictError) return Response.json({ error: error.code, message: error.message }, { status: 409 });
    throw error;
  }
});

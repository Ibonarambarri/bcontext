/**
 * POST /api/nexo/conflicts/:id/resolve
 *
 * The human's answer. Body: { workspace_id, decision }. NEXO turns the
 * decision into node operations (accept/edit/dismiss the candidate, update
 * or supersede a node, create a decision) through the caller's storage and
 * records what it did in `resolution`.
 */
import { z } from "zod";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { NexoConflictError, resolveConflict } from "@/lib/nexo/conflicts";

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  decision: z.string().trim().min(1).max(4000),
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = BodySchema.safeParse(parsed.data);
  if (!body.success) {
    return Response.json({ error: body.error.flatten() }, { status: 400 });
  }
  const ctx = await openWorkspaceById(req, body.data.workspace_id, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json({ error: "conflicts require a persisted (Supabase) workspace" }, { status: 400 });
  }
  const { id } = await params;
  try {
    const conflict = await resolveConflict(storage, id, body.data.decision, actingUserId(actor));
    return Response.json({ conflict });
  } catch (err) {
    if (err instanceof NexoConflictError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    throw err;
  }
});

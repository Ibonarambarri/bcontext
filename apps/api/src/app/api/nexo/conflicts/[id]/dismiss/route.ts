/**
 * POST /api/nexo/conflicts/:id/dismiss — "no conflict here". Body: { workspace_id }.
 * A dismissed doubt dismisses its candidate; a dismissed contradiction
 * leaves the candidate pending (the fact may still be right).
 */
import { z } from "zod";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { dismissConflict, NexoConflictError } from "@/lib/nexo/conflicts";

const BodySchema = z.object({ workspace_id: z.string().uuid() });

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
  if (ctx.storage.backend !== "supabase") {
    return Response.json({ error: "conflicts require a persisted (Supabase) workspace" }, { status: 400 });
  }
  const { id } = await params;
  try {
    const conflict = await dismissConflict(body.data.workspace_id, id, actingUserId(ctx.actor));
    return Response.json({ conflict });
  } catch (err) {
    if (err instanceof NexoConflictError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    throw err;
  }
});

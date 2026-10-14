/**
 * POST /api/ingest/candidates/:id/accept
 *
 * Accept a pending ingest candidate: creates the proposed node (stamped
 * with ingest provenance) and its declared links, marks the candidate
 * accepted. Body: { workspace_id: <uuid> }.
 */
import { z } from "zod";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { readJsonBody } from "@/lib/parse-json";
import { acceptCandidate, IngestCandidateError } from "@/lib/ingest/candidates";

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
  const { storage, actor: gated } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json(
      { error: "ingest candidates require a persisted (Supabase) workspace" },
      { status: 400 },
    );
  }

  const { id } = await params;
  try {
    const candidate = await acceptCandidate(storage, id, actingUserId(gated));
    return Response.json({ candidate });
  } catch (err) {
    if (err instanceof IngestCandidateError) {
      const status = err.code === "not_found" ? 404 : 409;
      return Response.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});

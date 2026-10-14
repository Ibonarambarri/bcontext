/**
 * PATCH /api/ingest/candidates/:id
 *
 * Generic status transition for the Procesamiento drag-and-drop board —
 * covers moves in all 4 directions (pending/reprocess/accepted/dismissed)
 * through one entry point, instead of the one-way accept/dismiss POSTs.
 * Body: { workspace_id: <uuid>, status: <IngestCandidateStatus>, feedback?: string }.
 */
import { z } from "zod";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { readJsonBody } from "@/lib/parse-json";
import { setCandidateStatus, IngestCandidateError } from "@/lib/ingest/candidates";
import { setDemoCandidateStatus } from "@/lib/ingest/demo-candidates";

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  status: z.enum(["pending", "accepted", "dismissed", "reprocess"]),
  feedback: z.string().max(4000).optional(),
});

export const PATCH = withRoute(async (
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
  const { id } = await params;
  try {
    // Demo-store fallback mirrors setCandidateStatus so the Review board
    // works end-to-end (stage → confirm → persist) without Supabase.
    const candidate =
      storage.backend !== "supabase"
        ? setDemoCandidateStatus(
            id,
            body.data.workspace_id,
            body.data.status,
            body.data.feedback ?? null,
          )
        : await setCandidateStatus(
            storage,
            id,
            body.data.status,
            actingUserId(gated),
            body.data.feedback ?? null,
          );
    return Response.json({ candidate });
  } catch (err) {
    if (err instanceof IngestCandidateError) {
      const status = err.code === "not_found" ? 404 : 409;
      return Response.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});

/**
 * GET /api/ingest/candidates?workspace_id=<uuid>&status=<pending|accepted|dismissed>
 *
 * List the workspace's ingest inbox — node candidates proposed by connector
 * signals, awaiting accept/dismiss. `status` is optional; omit for all.
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { listCandidates } from "@/lib/ingest/candidates";
import { listDemoCandidates } from "@/lib/ingest/demo-candidates";

const QuerySchema = z.object({
  workspace_id: z.string().uuid(),
  status: z.enum(["pending", "accepted", "dismissed", "reprocess"]).optional(),
});

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    workspace_id: url.searchParams.get("workspace_id"),
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ctx = await openWorkspaceById(req, parsed.data.workspace_id, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  if (storage.backend !== "supabase") {
    // Demo-store fallback: the Review board stays explorable without
    // Supabase (seeded candidates for the reference workspace).
    return Response.json({
      candidates: listDemoCandidates(parsed.data.workspace_id, {
        status: parsed.data.status,
      }),
    });
  }

  const candidates = await listCandidates(parsed.data.workspace_id, {
    status: parsed.data.status,
  });
  return Response.json({ candidates });
});

/**
 * GET /api/nexo/conflicts?workspace_id=<uuid>&status=<open|resolved|dismissed>
 *
 * The Conflicts list — what NEXO is not sure about. `status` defaults to
 * `open`; pass `all` for everything. Rows carry the full context so the
 * detail view needs no second round-trip for the common case.
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { listConflicts } from "@/lib/nexo/conflicts";

const QuerySchema = z.object({
  workspace_id: z.string().uuid(),
  status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
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
  if (ctx.storage.backend !== "supabase") {
    return Response.json({ conflicts: [] });
  }
  const conflicts = await listConflicts(parsed.data.workspace_id, {
    status: parsed.data.status === "all" ? undefined : parsed.data.status,
  });
  return Response.json({ conflicts });
});

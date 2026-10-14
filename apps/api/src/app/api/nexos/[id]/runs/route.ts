/**
 * GET /api/nexos/:id/runs?workspace=&limit= — the Nexo's activity: one row
 * per chat turn, heartbeat, event, batch or manual run, newest first.
 * Starting a manual run is `POST /api/nexos/:id/run` (the runtime's route).
 */
import { withRoute } from "@/lib/route";
import { loadNexo, openNexos, workspaceParam } from "@/lib/nexos/http";
import { listRuns } from "@/lib/nexos/store";

type Params = { params: Promise<{ id: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  const runs = await listRuns(ctx.target, { nexoId: nexo.id, limit: Number.isFinite(limit) ? limit : 50 });
  return Response.json({ runs });
});

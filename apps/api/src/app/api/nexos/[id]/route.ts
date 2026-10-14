/**
 * One Nexo.
 *
 *   GET    /api/nexos/:id?workspace=   detail: bindings, tools (brain + capability
 *                                      grants), recent runs, open inbox count
 *   PATCH  /api/nexos/:id?workspace=   settings (`UpdateNexoBodySchema`); a rename
 *                                      or brain-tools change resyncs its identity
 *   DELETE /api/nexos/:id?workspace=   specialists only — the general Nexo is 409
 */
import { withRoute } from "@/lib/route";
import { UpdateNexoBodySchema } from "@bcontext-dev/contract/nexos";
import { record as recordActivity } from "@/lib/activity";
import { auditNexo, loadNexo, nexoErrorResponse, openNexos, parseBody, workspaceParam } from "@/lib/nexos/http";
import { deleteNexo, updateNexo } from "@/lib/nexos/lifecycle";
import { countOpenInbox, listBindings, listRuns } from "@/lib/nexos/store";
import { getNexoTools } from "@/lib/nexos/tools";

type Params = { params: Promise<{ id: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  const [bindings, tools, recentRuns, open] = await Promise.all([
    listBindings(ctx.target, nexo.id),
    getNexoTools(ctx.target, nexo),
    listRuns(ctx.target, { nexoId: nexo.id, limit: 10 }),
    countOpenInbox(ctx.target),
  ]);
  return Response.json({
    nexo,
    bindings,
    tools,
    recent_runs: recentRuns,
    open_inbox_count: open.get(nexo.id) ?? 0,
  });
});

export const PATCH = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(req, UpdateNexoBodySchema);
  if (body instanceof Response) return body;
  const ctx = await openNexos(req, workspaceParam(req), "manage");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  try {
    const updated = await updateNexo(ctx.target, nexo, body);
    auditNexo(ctx, "nexo.update", { type: "nexo", id: nexo.id }, { fields: Object.keys(body) });
    return Response.json({ nexo: updated });
  } catch (err) {
    return nexoErrorResponse(err);
  }
});

export const DELETE = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "manage");
  if (ctx instanceof Response) return ctx;
  try {
    const nexo = await deleteNexo(ctx.target, id);
    auditNexo(ctx, "nexo.delete", { type: "nexo", id: nexo.id }, { name: nexo.name });
    recordActivity(ctx.storage.workspace.slug, "workspace", null, nexo.name, "Nexo eliminado", {
      actorId: ctx.userId,
      payload: { nexo_id: nexo.id, op: "nexo.delete" },
    });
    return Response.json({ ok: true });
  } catch (err) {
    return nexoErrorResponse(err);
  }
});

/**
 * DELETE /api/nexos/:id/bindings/:bindingId?workspace= — stop a Nexo
 * listening to an install or channel. What it covered falls back to the
 * general Nexo from the next event on.
 */
import { withRoute } from "@/lib/route";
import { auditNexo, loadNexo, openNexos, workspaceParam } from "@/lib/nexos/http";
import { deleteBinding } from "@/lib/nexos/store";

type Params = { params: Promise<{ id: string; bindingId: string }> };

export const DELETE = withRoute(async (req: Request, { params }: Params) => {
  const { id, bindingId } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "manage");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  const removed = await deleteBinding(ctx.target, nexo.id, bindingId);
  if (!removed) return Response.json({ error: "binding_not_found" }, { status: 404 });
  auditNexo(ctx, "nexo.binding.delete", { type: "nexo_binding", id: bindingId }, { nexo_id: nexo.id });
  return Response.json({ ok: true });
});

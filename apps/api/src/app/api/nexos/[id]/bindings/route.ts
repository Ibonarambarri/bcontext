/**
 * A Nexo's integrations: which connector installs (and which of their
 * channels) it listens to.
 *
 *   GET  /api/nexos/:id/bindings?workspace=
 *   POST /api/nexos/:id/bindings?workspace=   {install_id, channels?, scope?, mode}
 *
 * One binding per channel (`channel:<id>`), or one for the whole install
 * (`*`) when no channels are given. A key another Nexo already owns is 409
 * `scope_owned`: one owner per channel, and unbound sources fall back to the
 * general Nexo. The install must belong to this workspace and be live; the
 * database enforces the workspace match too (0096).
 */
import { withRoute } from "@/lib/route";
import { CreateNexoBindingBodySchema } from "@bcontext-dev/contract/nexos";
import { auditNexo, loadNexo, nexoErrorResponse, openNexos, parseBody, workspaceParam } from "@/lib/nexos/http";
import { createBindings, getBindableInstall, listBindings } from "@/lib/nexos/store";

type Params = { params: Promise<{ id: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  return Response.json({ bindings: await listBindings(ctx.target, nexo.id) });
});

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(req, CreateNexoBindingBodySchema);
  if (body instanceof Response) return body;
  const ctx = await openNexos(req, workspaceParam(req), "manage");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;

  // The demo backend has no connector installs; the id is taken as given so
  // the binding flow can be exercised without Supabase.
  let connectorId = typeof body.scope.connector_id === "string" ? body.scope.connector_id : "demo";
  if (ctx.storage.backend === "supabase") {
    const install = await getBindableInstall(ctx.target, body.install_id);
    if (!install) {
      return Response.json({ error: "install_not_found" }, { status: 404 });
    }
    connectorId = install.connector_id;
  }

  try {
    const bindings = await createBindings(ctx.target, {
      nexoId: nexo.id,
      installId: body.install_id,
      connectorId,
      channels: body.channels,
      scope: body.scope,
      mode: body.mode,
      createdBy: ctx.userId,
    });
    auditNexo(ctx, "nexo.binding.create", { type: "nexo", id: nexo.id }, {
      install_id: body.install_id,
      scope_keys: bindings.map((b) => b.scope_key),
      mode: body.mode,
    });
    return Response.json({ bindings }, { status: 201 });
  } catch (err) {
    return nexoErrorResponse(err);
  }
});

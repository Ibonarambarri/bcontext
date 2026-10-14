/**
 * What a Nexo may use.
 *
 *   GET /api/nexos/:id/tools?workspace=   brain tools + live capability grants
 *   PUT /api/nexos/:id/tools?workspace=   {brain_tools?, capability_ids, bundle_ids}
 *
 * PUT is the full desired set of external capabilities (omitted grants are
 * revoked) and needs the `admin` verb: granting a capability to a Nexo is
 * granting it to a principal, which is what workspace admins decide for every
 * other principal too. A brain-tools change resyncs the Nexo's grant verbs.
 * The demo backend has no capability gateway, so PUT answers 400 there for
 * anything but brain tools.
 */
import { withRoute } from "@/lib/route";
import { PutNexoToolsBodySchema } from "@bcontext-dev/contract/nexos";
import { auditNexo, loadNexo, nexoErrorResponse, openNexos, parseBody, workspaceParam } from "@/lib/nexos/http";
import { updateNexo } from "@/lib/nexos/lifecycle";
import { getNexoTools, InvalidToolGrantError, setNexoCapabilityGrants } from "@/lib/nexos/tools";

type Params = { params: Promise<{ id: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  return Response.json({ tools: await getNexoTools(ctx.target, nexo) });
});

export const PUT = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(req, PutNexoToolsBodySchema);
  if (body instanceof Response) return body;
  const ctx = await openNexos(req, workspaceParam(req), "admin");
  if (ctx instanceof Response) return ctx;
  let nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;

  const wantsCapabilities = body.capability_ids.length > 0 || body.bundle_ids.length > 0;
  if (ctx.storage.backend !== "supabase" && wantsCapabilities) {
    return Response.json(
      { error: "unsupported", message: "External capabilities need the capability gateway (Supabase)." },
      { status: 400 },
    );
  }

  try {
    if (body.brain_tools) nexo = await updateNexo(ctx.target, nexo, { brain_tools: body.brain_tools });
    const tools = ctx.storage.backend === "supabase"
      ? await setNexoCapabilityGrants(ctx.target, nexo, {
          capabilityIds: body.capability_ids,
          bundleIds: body.bundle_ids,
          userId: ctx.userId,
        })
      : await getNexoTools(ctx.target, nexo);
    auditNexo(ctx, "nexo.tools.update", { type: "nexo", id: nexo.id }, {
      brain_tools: body.brain_tools ?? null,
      capability_ids: body.capability_ids,
      bundle_ids: body.bundle_ids,
    });
    return Response.json({ tools });
  } catch (err) {
    if (err instanceof InvalidToolGrantError) {
      return Response.json(
        { error: "invalid_capability_grant", message: "Only approved capabilities and bundles of this workspace can be granted." },
        { status: 400 },
      );
    }
    return nexoErrorResponse(err);
  }
});

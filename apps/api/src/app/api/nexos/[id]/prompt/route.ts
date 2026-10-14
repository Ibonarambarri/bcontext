/**
 * POST /api/nexos/:id/prompt?workspace= — regenerate the Nexo's prompt from
 * its questionnaire (or from a questionnaire sent in the body, which is then
 * stored too) and save it. Answers `{ nexo, source }`; `source` says whether
 * the model wrote it or the deterministic template stood in.
 */
import { z } from "zod";
import { withRoute } from "@/lib/route";
import { NexoQuestionnaireSchema } from "@bcontext-dev/contract/nexos";
import { auditNexo, loadNexo, nexoErrorResponse, openNexos, workspaceParam } from "@/lib/nexos/http";
import { updateNexo } from "@/lib/nexos/lifecycle";
import { generateNexoPrompt } from "@/lib/nexos/prompt";

const Body = z.object({ questionnaire: NexoQuestionnaireSchema.optional() }).strict();

type Params = { params: Promise<{ id: string }> };

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  // The body is optional here: an empty POST regenerates from what is stored.
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return Response.json({ error: "invalid_request", message: "body must be JSON" }, { status: 400 });
    }
  }
  const body = Body.safeParse(raw);
  if (!body.success) {
    return Response.json({ error: "invalid_request", issues: body.error.flatten() }, { status: 400 });
  }

  const ctx = await openNexos(req, workspaceParam(req), "manage");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;

  const stored = NexoQuestionnaireSchema.safeParse({ ...nexo.questionnaire, name: nexo.questionnaire.name ?? nexo.name });
  const questionnaire = body.data.questionnaire ?? (stored.success ? stored.data : null);
  if (!questionnaire) {
    return Response.json(
      { error: "questionnaire_required", message: "This Nexo has no usable questionnaire; send one in the body." },
      { status: 400 },
    );
  }

  const generated = await generateNexoPrompt({
    questionnaire,
    template: nexo.template,
    workspaceName: ctx.storage.workspace.name,
    workspaceId: ctx.storage.backend === "supabase" ? ctx.storage.workspace.id : undefined,
    subjectUserId: ctx.userId,
  });
  try {
    const updated = await updateNexo(ctx.target, nexo, {
      prompt_md: generated.prompt_md,
      ...(body.data.questionnaire ? { questionnaire: body.data.questionnaire } : {}),
    });
    auditNexo(ctx, "nexo.prompt.regenerate", { type: "nexo", id: nexo.id }, { source: generated.source });
    return Response.json({ nexo: updated, source: generated.source });
  } catch (err) {
    return nexoErrorResponse(err);
  }
});

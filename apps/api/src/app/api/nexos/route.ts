/**
 * The workspace's Nexos.
 *
 *   GET  /api/nexos?workspace=<slug>   every Nexo, the general one first
 *                                      (created on first read if missing),
 *                                      with its integrations, its bindings
 *                                      (install + scope) and open inbox count
 *   POST /api/nexos?workspace=<slug>   create from {template, questionnaire,
 *                                      heartbeat?}; `preview: true` returns
 *                                      the prompt only. A routine turns the
 *                                      heartbeat on; escalations notify the
 *                                      creator when a person is behind it
 *
 * Read needs `agents:read`; create needs the `write` verb and `agents:write`
 * (see `@/lib/nexos/http`). Creating writes the Nexo row, its agent identity
 * and its grant together (`@/lib/nexos/lifecycle`).
 */
import { withRoute } from "@/lib/route";
import type { Actor } from "@/lib/auth/require";
import { CreateNexoBodySchema, type NexoBindingRef, type NexoListItem } from "@bcontext-dev/contract/nexos";
import { record as recordActivity } from "@/lib/activity";
import { auditNexo, nexoErrorResponse, openNexos, parseBody, workspaceParam } from "@/lib/nexos/http";
import { ensureGeneralNexo } from "@/lib/nexos/general";
import { createNexo } from "@/lib/nexos/lifecycle";
import { generateNexoPrompt } from "@/lib/nexos/prompt";
import { countOpenInbox, listBindings, listNexos } from "@/lib/nexos/store";

export const GET = withRoute(async (req: Request) => {
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;
  await ensureGeneralNexo(ctx.target, { createdBy: ctx.userId });
  const [nexos, bindings, open] = await Promise.all([
    listNexos(ctx.target),
    listBindings(ctx.target),
    countOpenInbox(ctx.target),
  ]);
  const byNexo = new Map<string, NexoBindingRef[]>();
  for (const b of bindings) {
    const refs = byNexo.get(b.nexo_id) ?? [];
    refs.push({ install_id: b.install_id, connector_id: b.connector_id, scope_key: b.scope_key });
    byNexo.set(b.nexo_id, refs);
  }
  const items: NexoListItem[] = nexos.map((n) => ({
    ...n,
    integrations: [...new Set((byNexo.get(n.id) ?? []).map((b) => b.connector_id))].sort(),
    bindings: byNexo.get(n.id) ?? [],
    open_inbox_count: open.get(n.id) ?? 0,
  }));
  return Response.json({ nexos: items });
});

/** The person behind the request: a session or an agent acting as a user, never a bare agent token. */
function humanUserId(actor: Actor): string | null {
  return actor.kind === "user" || actor.kind === "agent_user" ? actor.userId : null;
}

export const POST = withRoute(async (req: Request) => {
  const body = await parseBody(req, CreateNexoBodySchema);
  if (body instanceof Response) return body;
  const ctx = await openNexos(req, workspaceParam(req, body.workspace), "manage");
  if (ctx instanceof Response) return ctx;

  const generated = body.prompt_md
    ? { prompt_md: body.prompt_md, source: "template" as const }
    : await generateNexoPrompt({
        questionnaire: body.questionnaire,
        template: body.template,
        workspaceName: ctx.storage.workspace.name,
        workspaceId: ctx.storage.backend === "supabase" ? ctx.storage.workspace.id : undefined,
        subjectUserId: ctx.userId,
      });
  if (body.preview) {
    return Response.json({ prompt_md: generated.prompt_md, source: generated.source });
  }

  try {
    const nexo = await createNexo(ctx.target, {
      name: body.questionnaire.name,
      description: body.description ?? body.questionnaire.mission.slice(0, 200),
      template: body.template,
      questionnaire: body.questionnaire,
      prompt_md: generated.prompt_md,
      autonomy: body.autonomy,
      creation: { heartbeat: body.heartbeat, notifyUserId: humanUserId(ctx.actor) },
      createdBy: ctx.userId,
    });
    auditNexo(ctx, "nexo.create", { type: "nexo", id: nexo.id }, { template: body.template, name: nexo.name });
    // A workspace-level event done by the person, not by the Nexo: no
    // principal, so the feed does not credit the new Nexo with its own birth.
    recordActivity(ctx.storage.workspace.slug, "workspace", null, nexo.name, "Nexo creado", {
      actorId: ctx.userId,
      payload: { nexo_id: nexo.id, op: "nexo.create" },
    });
    return Response.json({ nexo }, { status: 201 });
  } catch (err) {
    return nexoErrorResponse(err);
  }
});

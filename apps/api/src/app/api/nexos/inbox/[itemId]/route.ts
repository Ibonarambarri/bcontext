/**
 * POST /api/nexos/inbox/:itemId?workspace= — a person's decision on an inbox
 * item: `{ action: "approve" | "edit" | "reject" | "done", text? }`.
 * Approving (or editing, with `text`) a `draft_reply` sends it through the
 * Nexo's binding first; a failed send is 502 and the item stays open.
 * Answers `{ item }`; 404 unknown item, 409 already resolved, 400 an action
 * that does not fit the item (editing an escalation, a draft with no
 * destination).
 *
 * Access: verb `write`, scope `agents:write` (it can speak for the Nexo).
 */
import { NexoInboxActionBodySchema } from "@bcontext-dev/contract/nexos";
import { withRoute } from "@/lib/route";
import { auditNexo, openNexos, parseBody, workspaceParam } from "@/lib/nexos/http";
import { getInboxItem, getNexo } from "@/lib/nexos/store";
import { resolveNexoInboxAction } from "@/lib/nexos/runtime/inbox";

type Params = { params: Promise<{ itemId: string }> };

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { itemId } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "manage");
  if (ctx instanceof Response) return ctx;
  const body = await parseBody(req, NexoInboxActionBodySchema);
  if (body instanceof Response) return body;

  const item = await getInboxItem(ctx.target, itemId);
  const nexo = item ? await getNexo(ctx.target, item.nexo_id) : null;
  if (!item || !nexo) return Response.json({ error: "inbox_item_not_found" }, { status: 404 });

  const out = await resolveNexoInboxAction({
    target: ctx.target,
    nexo,
    itemId: item.id,
    action: body.action,
    text: body.text,
    userId: ctx.userId,
  });
  if (!out.ok) {
    return Response.json({ error: out.error, ...(out.message ? { message: out.message } : {}) }, { status: out.status });
  }
  auditNexo(ctx, `nexo.inbox.${body.action}`, { type: "nexo_inbox", id: item.id }, { nexo_id: nexo.id, kind: item.kind, status: out.item.status });
  return Response.json({ item: out.item });
});

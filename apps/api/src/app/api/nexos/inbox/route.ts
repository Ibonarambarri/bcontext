/**
 * GET /api/nexos/inbox?workspace=&nexo_id=&status= — the workspace's Nexo
 * inbox: escalations, draft replies waiting for approval, approvals. Newest
 * first; filter by Nexo and/or status. Resolving an item is
 * `POST /api/nexos/inbox/:itemId` (the runtime's route: approving a draft
 * sends it through the binding).
 */
import { withRoute } from "@/lib/route";
import { NEXO_INBOX_STATUSES, type NexoInboxStatus } from "@bcontext-dev/contract/nexos";
import { openNexos, workspaceParam } from "@/lib/nexos/http";
import { listInbox } from "@/lib/nexos/store";

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status && !(NEXO_INBOX_STATUSES as readonly string[]).includes(status)) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;
  const items = await listInbox(ctx.target, {
    nexoId: url.searchParams.get("nexo_id") || undefined,
    status: (status as NexoInboxStatus | null) ?? undefined,
  });
  return Response.json({ items });
});

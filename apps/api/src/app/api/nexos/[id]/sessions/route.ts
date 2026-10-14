/**
 * GET /api/nexos/:id/sessions?workspace= — the caller's chat history with
 * this Nexo, most recently active first. The general Nexo's history is the
 * pre-existing one (`chat_sessions.nexo_id is null`). Needs `chat:run`, like
 * `/api/nexo/conversations`; a caller with no user behind it (demo,
 * workspace token without a creator) gets an empty list.
 */
import { withRoute } from "@/lib/route";
import { loadNexo, openNexos, workspaceParam } from "@/lib/nexos/http";
import { listNexoSessions } from "@/lib/nexos/store";

type Params = { params: Promise<{ id: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const ctx = await openNexos(req, workspaceParam(req), "chat");
  if (ctx instanceof Response) return ctx;
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  if (!ctx.userId) return Response.json({ sessions: [] });
  const sessions = await listNexoSessions(ctx.target, nexo, { userId: ctx.userId });
  return Response.json({ sessions });
});

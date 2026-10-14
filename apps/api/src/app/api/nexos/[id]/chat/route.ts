/**
 * POST /api/nexos/:id/chat?workspace= — one streamed turn of a conversation
 * with a Nexo. Same body and the same NDJSON wire as `POST /api/nexo`
 * (`{ workspace?, messages, pageContext?, conversationId?, scope? }`; the
 * conversation id comes back in `x-conversation-id`). For the general Nexo it
 * IS `/api/nexo`; for a specialist the turn carries its prompt, its tool
 * switches, its own history and its budget (402 `nexo_budget_exhausted`).
 *
 * Access: verb `read`, scope `chat:run` — the person chatting is the
 * principal, so any write a tool attempts is checked against their grant.
 */
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { nexoChatTurn, type NexoTurnBody } from "@/lib/nexo/assistant/turn";
import { openNexos, workspaceParam } from "@/lib/nexos/http";
import { getNexo, nexoTarget } from "@/lib/nexos/store";

type Params = { params: Promise<{ id: string }> };

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const parsed = await readJsonBody<Partial<NexoTurnBody>>(req);
  if (!parsed.ok) return parsed.response;
  const workspace = workspaceParam(req, parsed.data.workspace);
  const body: NexoTurnBody = {
    ...parsed.data,
    workspace: workspace ?? "",
    messages: Array.isArray(parsed.data.messages) ? parsed.data.messages : [],
  };
  return nexoChatTurn(req, body, {
    open: () => openNexos(req, workspace, "chat"),
    loadNexo: async (ctx) =>
      (await getNexo(nexoTarget(ctx.storage), id)) ?? Response.json({ error: "nexo_not_found" }, { status: 404 }),
  });
});

/**
 * POST /api/nexo — one turn of a conversation with Nexo, the general one.
 *
 * Nexo is the assistant that lives inside the app: a launcher in the corner of
 * every page and a full section of its own. Both surfaces post here, and both
 * send the same thing — the conversation so far plus `pageContext`, which is
 * what makes "what is this?" and "rewrite this" answerable.
 *
 * The turn itself lives in `@/lib/nexo/assistant/turn`, shared with
 * `POST /api/nexos/:id/chat`, which is the same conversation with any Nexo of
 * the team (and, for the general one, exactly this route).
 */
import { readJsonBody } from "@/lib/parse-json";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { nexoChatTurn, type NexoTurnBody } from "@/lib/nexo/assistant/turn";

export const POST = withRoute(async (req: Request) => {
  const parsed = await readJsonBody<NexoTurnBody>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  return nexoChatTurn(req, body, {
    // `read` is what the turn itself needs. A tool that writes is checked
    // again by scoped storage when it runs, so a viewer gets a tool error
    // rather than a silent edit.
    open: () => openWorkspace(req, body.workspace, "read", { scope: "chat:run" }),
  });
});

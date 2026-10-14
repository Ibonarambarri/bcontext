/**
 * One Nexo conversation — messages, rename, delete (scoped to the owner).
 *
 *   GET    /api/nexo/conversations/[id]  → ordered messages
 *   PATCH  /api/nexo/conversations/[id]  { title }  → rename
 *   DELETE /api/nexo/conversations/[id]  → delete (cascades messages)
 *
 * `user_id` ownership is the authorization boundary — a conversation id that
 * isn't yours resolves to 404.
 */
import { gate, actingUserId } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { readJsonBody } from "@/lib/parse-json";
import {
  getConversationById,
  getMessages,
  renameConversation,
  deleteConversation,
} from "@/lib/chat/conversations";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withRoute(async (req: Request, ctx: Ctx) => {
  const gated = await gate(req, "chat:run");
  if (gated instanceof Response) return gated;
  const userId = actingUserId(gated);
  const { id } = await ctx.params;
  if (!userId) return Response.json({ messages: [] });

  const conversation = await getConversationById(id, userId);
  if (!conversation) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const messages = await getMessages(id);
  return Response.json({ conversation, messages });
});

interface PatchBody {
  title: string;
}

export const PATCH = withRoute(async (req: Request, ctx: Ctx) => {
  const gated = await gate(req, "chat:run");
  if (gated instanceof Response) return gated;
  const userId = actingUserId(gated);
  const { id } = await ctx.params;
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await readJsonBody<PatchBody>(req);
  if (!parsed.ok) return parsed.response;
  const title = parsed.data.title?.trim();
  if (!title) {
    return Response.json({ error: "title required" }, { status: 400 });
  }
  const updated = await renameConversation(id, userId, title);
  if (!updated) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ conversation: updated });
});

export const DELETE = withRoute(async (req: Request, ctx: Ctx) => {
  const gated = await gate(req, "chat:run");
  if (gated instanceof Response) return gated;
  const userId = actingUserId(gated);
  const { id } = await ctx.params;
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const conversation = await getConversationById(id, userId);
  if (!conversation) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  await deleteConversation(id, userId);
  return Response.json({ ok: true });
});

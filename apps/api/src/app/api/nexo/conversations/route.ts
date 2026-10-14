/**
 * Nexo conversations — list + create.
 *
 *   GET  /api/nexo/conversations?workspace=<slug>  → list mine in that workspace
 *   POST /api/nexo/conversations  { workspace, title? }  → create, returns { id }
 *
 * This is what the Nexo section's left rail reads. A turn started from the
 * launcher opens its own conversation server-side (see ../route.ts), so most
 * conversations arrive here without ever having been POSTed.
 *
 * Cookie-auth user surface. `actingUserId` is the owner; demo / unattributed
 * callers (no user id) get an empty list and a 501-style no-op create, so the
 * UI degrades to an ephemeral conversation instead of erroring.
 */
import { gate, actingUserId } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { readJsonBody } from "@/lib/parse-json";
import {
  listConversations,
  createConversation,
  resolveMemberWorkspaceId,
} from "@/lib/chat/conversations";

export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req, "chat:run");
  if (gated instanceof Response) return gated;
  const userId = actingUserId(gated);
  if (!userId) return Response.json({ conversations: [] });

  const slug = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!slug) {
    return Response.json({ error: "workspace required" }, { status: 400 });
  }
  const workspaceId = await resolveMemberWorkspaceId(slug, userId);
  if (!workspaceId) {
    return Response.json({ conversations: [] });
  }
  const conversations = await listConversations(workspaceId, userId);
  return Response.json({ conversations });
});

interface CreateBody {
  workspace: string;
  title?: string;
}

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req, "chat:run");
  if (gated instanceof Response) return gated;
  const userId = actingUserId(gated);
  if (!userId) {
    return Response.json(
      { error: "persistence unavailable in this mode" },
      { status: 501 },
    );
  }

  const parsed = await readJsonBody<CreateBody>(req);
  if (!parsed.ok) return parsed.response;
  const slug = parsed.data.workspace?.trim();
  if (!slug) {
    return Response.json({ error: "workspace required" }, { status: 400 });
  }
  const workspaceId = await resolveMemberWorkspaceId(slug, userId);
  if (!workspaceId) {
    return Response.json(
      { error: "workspace not found or not a member" },
      { status: 404 },
    );
  }
  const conversation = await createConversation(
    workspaceId,
    userId,
    parsed.data.title ?? null,
  );
  return Response.json({ conversation }, { status: 201 });
});

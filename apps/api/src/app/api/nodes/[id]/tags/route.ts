/**
 * PUT /api/nodes/:id/tags — replace the full tag set of one node (the tag
 * picker in the web; MCP does the same through `nodes_write`).
 *
 * Write verb via `openWorkspace`. The whole list is sent every time rather
 * than add/remove deltas, so two pickers racing end with one of the two
 * intended states instead of a merge neither asked for. Records the change
 * in the activity feed and broadcasts the node update to open clients.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import {
  NodeWriteError,
  TagNotFoundError,
} from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { record as recordActivity } from "@/lib/activity";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { changePayload } from "@bcontext-dev/contract/changes";

const AssignSchema = z.object({
  workspace: z.string().min(1),
  tag_ids: z.array(z.string().min(1)).max(100),
});
export const PUT = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = AssignSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const ctx = await openWorkspace(req, parsed.data.workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  const { id } = await params;
  try {
    const before = await storage.getNode(id);
    const node = await storage.setNodeTags(id, parsed.data.tag_ids);
    recordActivity(parsed.data.workspace, "update", node.id, node.title, "tags", {
      actorKind: actor.kind === "agent" || actor.kind === "agent_user" ? "agent" : "human",
      actorId: actor.kind === "user" || actor.kind === "agent_user" ? actor.userId : null,
      principalId: actor.kind === "agent" || actor.kind === "agent_user" ? actor.agentId : null,
      payload: changePayload({ before, after: node, via: actor.kind === "user" ? "web" : "rest" }),
    });
    if (storage.backend === "supabase") {
      await wsBroadcast.nodeUpdated(storage.workspace.id, node.id);
    }
    return Response.json({ node, tags: node.tags });
  } catch (error) {
    if (error instanceof TagNotFoundError) {
      return Response.json({ error: "unknown_or_inactive_tag", tag_id: error.tagId }, { status: 400 });
    }
    if (error instanceof NodeWriteError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message.startsWith("node not found")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    throw error;
  }
});

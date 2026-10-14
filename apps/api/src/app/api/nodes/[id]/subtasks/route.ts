/**
 * Subtasks of one task node, over REST — the same ops the MCP
 * `subtasks`/`subtasks_write` tools expose, for the web and for callers
 * that cannot speak MCP.
 *
 *   GET  /api/nodes/:id/subtasks?workspace=…   cards + progress
 *   POST /api/nodes/:id/subtasks               { workspace, if_updated_at?, ...SubtaskOp }
 *
 * The op vocabulary is the contract's `SubtaskOpSchema`; the guarded
 * read-modify-write is `writeSubtaskOp`, shared with MCP, so both surfaces
 * agree on what every op does and on how a lost race is handled.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { ConflictError } from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { record as recordActivity } from "@/lib/activity";
import { appendAudit, type ActorType } from "@/lib/audit";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { changePayload } from "@bcontext-dev/contract/changes";
import {
  SubtaskOpSchema,
  readSubtasks,
  subtaskCard,
  subtaskProgress,
} from "@bcontext-dev/contract/subtasks";
import { SubtaskError, writeSubtaskOp } from "@/lib/subtasks";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const workspace = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, workspace, "read");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const node = await ctx.storage.getNode(id);
  if (!node) return Response.json({ error: "not_found" }, { status: 404 });
  const subtasks = readSubtasks(node.data);
  return Response.json({
    node_id: node.id,
    updated_at: node.updated_at,
    progress: subtaskProgress(subtasks),
    subtasks: subtasks.map(subtaskCard),
  });
});

const WriteBase = z.object({
  workspace: z.string().min(1),
  if_updated_at: z.string().min(1).optional(),
});
const WriteSchema = z.discriminatedUnion("op", [
  SubtaskOpSchema.options[0].merge(WriteBase),
  SubtaskOpSchema.options[1].merge(WriteBase),
  SubtaskOpSchema.options[2].merge(WriteBase),
  SubtaskOpSchema.options[3].merge(WriteBase),
  SubtaskOpSchema.options[4].merge(WriteBase),
]);

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = WriteSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { workspace, if_updated_at, ...op } = parsed.data;
  const ctx = await openWorkspace(req, workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  const { id } = await params;

  let res;
  try {
    res = await writeSubtaskOp(storage, id, op, { ifUpdatedAt: if_updated_at });
  } catch (err) {
    if (err instanceof SubtaskError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.code === "not_found" ? 404 : 400 },
      );
    }
    if (err instanceof ConflictError) {
      return Response.json(
        { error: "conflict", message: err.message, current_updated_at: err.currentUpdatedAt },
        { status: 409 },
      );
    }
    throw err;
  }

  if (res.changed) {
    const isAgent = gated.kind === "agent" || gated.kind === "agent_user";
    recordActivity(workspace, "update", res.node.id, res.node.title, res.summary, {
      actorKind: isAgent ? "agent" : "human",
      actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
      principalId: isAgent ? gated.agentId : null,
      payload: changePayload({
        before: res.before,
        after: res.node,
        via: gated.kind === "user" ? "web" : "rest",
        extra: { subtask_id: res.subtask?.id ?? ("id" in op ? op.id : null), subtask_op: op.op },
      }),
    });
    if (storage.backend === "supabase") {
      const actorType: ActorType = isAgent ? "agent" : gated.kind === "user" ? "user" : "demo";
      void appendAudit({
        workspaceId: storage.workspace.id,
        actorType,
        actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
        agentTokenId: isAgent ? gated.tokenId : null,
        action: `node.subtask.${op.op}`,
        targetType: "node",
        targetId: res.node.id,
        input: op,
        output: { subtask_id: res.subtask?.id ?? null, progress: subtaskProgress(res.subtasks) },
      });
      // `from` lets the originating browser ignore its own echo; the summary
      // carries `data` so peers' boards patch the progress without a refetch.
      void wsBroadcast.nodeUpdated(
        storage.workspace.id,
        res.node.id,
        gated.kind === "user" ? gated.userId : undefined,
        { data: res.node.data, updated_at: res.node.updated_at },
      );
    }
  }

  return Response.json({
    node: res.node,
    changed: res.changed,
    subtask: res.subtask,
    subtasks: res.subtasks,
    progress: subtaskProgress(res.subtasks),
  });
});

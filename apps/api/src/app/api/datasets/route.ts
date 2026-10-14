/**
 * Create a dataset over REST — the same op as MCP `data_write(op=create)`,
 * for the web and for callers that cannot speak MCP.
 *
 *   POST /api/datasets   { workspace, title, description?, rows | csv, … }
 *
 * It is a top-level route rather than one under `/api/nodes/:id` because the
 * node does not exist yet: creating a dataset creates the `data` node AND its
 * rows, and splitting that into two calls would leave a node with no table
 * every time the second one failed.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { record as recordActivity } from "@/lib/activity";
import { appendAudit, type ActorType } from "@/lib/audit";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { changePayload } from "@bcontext-dev/contract/changes";
import { DatasetError, attachSourceFile, createDataset, datasetErrorStatus } from "@/lib/datasets";
import { DatasetRowsFields } from "@/lib/datasets/schemas";

const CreateSchema = z.object({
  workspace: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  content_md: z.string().optional(),
  parent_id: z.string().min(1).nullable().optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  /** Keep the uploaded file alongside the rows; only meaningful with `csv`. */
  filename: z.string().min(1).max(200).optional(),
  ...DatasetRowsFields,
}).strict();

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const { workspace, filename, ...input } = parsed.data;
  const ctx = await openWorkspace(req, workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;

  try {
    const created = await createDataset(storage, {
      ...input,
      description: input.description ?? null,
      parent_id: input.parent_id ?? null,
    });
    // The file is optional and comes after the rows: the rows ARE the dataset,
    // and a rejected upload must not cost the caller the data it just wrote.
    let dataset = created.dataset;
    if (filename && input.csv) {
      dataset = await attachSourceFile(storage, created.node.id, { filename, content: input.csv });
    }

    const isAgent = gated.kind === "agent" || gated.kind === "agent_user";
    recordActivity(workspace, "create", created.node.id, created.node.title, created.node.kind, {
      actorKind: isAgent ? "agent" : "human",
      actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
      principalId: isAgent ? gated.agentId : null,
      payload: changePayload({ after: created.node, via: gated.kind === "user" ? "web" : "rest" }),
    });
    if (storage.backend === "supabase") {
      const actorType: ActorType = isAgent ? "agent" : gated.kind === "user" ? "user" : "demo";
      void appendAudit({
        workspaceId: storage.workspace.id,
        actorType,
        actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
        agentTokenId: isAgent ? gated.tokenId : null,
        action: "node.create",
        targetType: "node",
        targetId: created.node.id,
        input: { title: input.title, kind: "data" },
        output: { rows: created.rows_written, columns: dataset.columns.length },
      });
      void wsBroadcast.nodeCreated(storage.workspace.id, created.node.id);
    }
    return Response.json(
      { node: created.node, dataset, rows_written: created.rows_written },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof DatasetError) {
      return Response.json({ error: err.code, message: err.message }, { status: datasetErrorStatus(err.code) });
    }
    throw err;
  }
});

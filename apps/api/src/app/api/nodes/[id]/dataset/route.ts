/**
 * One dataset's schema and its rows, over REST — the same ops as the MCP
 * `data`/`data_write` tools.
 *
 *   GET  /api/nodes/:id/dataset?workspace=…[&sample=N][&signed_url=1]
 *   POST /api/nodes/:id/dataset   { workspace, op: append_rows|replace_rows, … }
 *
 * The GET returns the SCHEMA, and rows only when `sample` asks for them. That
 * is the same rule `nodes(op=get)` follows and the reason the rows left
 * `content_md`: a dataset's shape is small and its table is not.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { ConflictError } from "@/lib/storage";
import { record as recordActivity } from "@/lib/activity";
import { appendAudit, type ActorType } from "@/lib/audit";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { changePayload } from "@bcontext-dev/contract/changes";
import {
  DATASET_SAMPLE_DEFAULT,
  DATASET_SAMPLE_MAX,
  DatasetError,
  appendRowsToDataset,
  datasetErrorStatus,
  readDatasetSchema,
  replaceDatasetRows,
  sampleDataset,
  signedSourceFileUrl,
} from "@/lib/datasets";
import { DatasetRowsFields } from "@/lib/datasets/schemas";

function datasetFailure(err: unknown): Response | null {
  if (err instanceof DatasetError) {
    return Response.json({ error: err.code, message: err.message }, { status: datasetErrorStatus(err.code) });
  }
  if (err instanceof ConflictError) {
    return Response.json(
      { error: "conflict", message: err.message, current_updated_at: err.currentUpdatedAt },
      { status: 409 },
    );
  }
  return null;
}

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const url = new URL(req.url);
  const ctx = await openWorkspace(req, url.searchParams.get("workspace"), "read");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;

  const sampleParam = url.searchParams.get("sample");
  const wantsSample = sampleParam !== null;
  const sampleSize = Math.min(
    Math.max(1, Number.parseInt(sampleParam ?? "", 10) || DATASET_SAMPLE_DEFAULT),
    DATASET_SAMPLE_MAX,
  );
  try {
    const description = wantsSample
      ? null
      : await readDatasetSchema(ctx.storage, id);
    const sampled = wantsSample ? await sampleDataset(ctx.storage, id, sampleSize) : null;
    const dataset = description ?? sampled!.description;
    // The original file is private: a link to it is signed here, after the
    // grant was checked, and expires. A permanent public URL to a customer's
    // whole data file is a leak that never closes.
    const sourceUrl =
      url.searchParams.get("signed_url") === "1" && dataset.source_file
        ? await signedSourceFileUrl(dataset.source_file.path)
        : null;
    return Response.json({
      ...dataset,
      ...(sampled ? { rows: sampled.rows } : {}),
      ...(sourceUrl ? { source_file_url: sourceUrl } : {}),
    });
  } catch (err) {
    const failure = datasetFailure(err);
    if (failure) return failure;
    throw err;
  }
});

const WriteSchema = z.object({
  workspace: z.string().min(1),
  op: z.enum(["append_rows", "replace_rows"]),
  if_updated_at: z.string().min(1).optional(),
  ...DatasetRowsFields,
}).strict();

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = WriteSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const { workspace, op, if_updated_at, ...input } = parsed.data;
  const ctx = await openWorkspace(req, workspace, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;
  const { id } = await params;

  try {
    const res =
      op === "append_rows"
        ? await appendRowsToDataset(storage, id, input, { ifUpdatedAt: if_updated_at })
        : await replaceDatasetRows(storage, id, input, { ifUpdatedAt: if_updated_at });

    const isAgent = gated.kind === "agent" || gated.kind === "agent_user";
    recordActivity(workspace, "update", res.node.id, res.node.title, res.summary, {
      actorKind: isAgent ? "agent" : "human",
      actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
      principalId: isAgent ? gated.agentId : null,
      payload: changePayload({
        before: res.before,
        after: res.node,
        via: gated.kind === "user" ? "web" : "rest",
        // The rows are not on the node, so the feed records what moved rather
        // than a diff of `data` that would say nothing.
        extra: { dataset_op: op, rows_written: res.rows_written },
      }),
    });
    if (storage.backend === "supabase") {
      const actorType: ActorType = isAgent ? "agent" : gated.kind === "user" ? "user" : "demo";
      void appendAudit({
        workspaceId: storage.workspace.id,
        actorType,
        actorId: gated.kind === "user" || gated.kind === "agent_user" ? gated.userId : null,
        agentTokenId: isAgent ? gated.tokenId : null,
        action: `node.dataset.${op}`,
        targetType: "node",
        targetId: res.node.id,
        input: { op },
        output: { rows_written: res.rows_written, row_count: res.dataset.row_count },
      });
      void wsBroadcast.nodeUpdated(
        storage.workspace.id,
        res.node.id,
        gated.kind === "user" ? gated.userId : undefined,
        { data: res.node.data, updated_at: res.node.updated_at },
      );
    }
    return Response.json({
      node: res.node,
      dataset: res.dataset,
      rows_written: res.rows_written,
    });
  } catch (err) {
    const failure = datasetFailure(err);
    if (failure) return failure;
    throw err;
  }
});

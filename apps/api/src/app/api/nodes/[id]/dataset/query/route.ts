/**
 * Ask a dataset a question — the REST twin of MCP `data(op=query)`.
 *
 *   POST /api/nodes/:id/dataset/query   { workspace, query }
 *
 * A POST for a read, because the query is a document: putting a filter tree
 * through a query string means encoding, length limits and a URL nobody can
 * read in a log. Nothing is written; the permission asked for is `read`.
 *
 * The `query` is the contract's `DatasetQuery` and it becomes parameterised
 * SQL in `src/lib/datasets/query.ts` — never SQL from the caller, and never a
 * column name the stored schema does not have.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { DatasetError, datasetErrorStatus, queryDataset } from "@/lib/datasets";
import { DatasetQuerySchema } from "@/lib/datasets/schemas";
import type { DatasetQuery } from "@bcontext-dev/contract/datasets";

const QuerySchema = z.object({
  workspace: z.string().min(1),
  query: DatasetQuerySchema.optional(),
}).strict();

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = QuerySchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const ctx = await openWorkspace(req, parsed.data.workspace, "read");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;

  try {
    // `schema_version` is the contract's, not the caller's question.
    const query = { ...(parsed.data.query ?? {}), schema_version: 1 } as DatasetQuery;
    return Response.json(await queryDataset(ctx.storage, id, query));
  } catch (err) {
    if (err instanceof DatasetError) {
      return Response.json({ error: err.code, message: err.message }, { status: datasetErrorStatus(err.code) });
    }
    throw err;
  }
});

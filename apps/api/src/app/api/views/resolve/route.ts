/**
 * POST /api/views/resolve — run an ad-hoc view query without saving it: the
 * web's view editor previews with it while the person edits filters. Same
 * scoped read and cost budget as resolving a saved view.
 */
import { z } from "zod";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { ViewQuerySchema } from "@bcontext-dev/contract/views/schema";
import { resolveViewQuery, ViewQueryCostError } from "@/lib/views/resolver";
import { resolveViewRequest } from "@/lib/views/http";

const Schema = z.object({ workspace: z.string().min(1), query: ViewQuerySchema }).strict();

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req); if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const resolved = await resolveViewRequest(req, parsed.data.workspace, "nodes:read");
  if ("response" in resolved) return resolved.response;
  try {
    return Response.json({ result: await resolveViewQuery(resolved.storage, parsed.data.query) });
  } catch (error) {
    if (error instanceof ViewQueryCostError) return Response.json({ error: "query_cost_exceeded", message: error.message }, { status: 422 });
    throw error;
  }
});

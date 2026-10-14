/**
 * Agent context endpoint.
 *
 * Returns a structured JSON snapshot of the workspace tuned for LLM
 * consumption. Agents POST a question/intent and get back the most relevant
 * nodes (via RAG), the workspace semantic hierarchy, and recent activity.
 *
 *   POST /api/agents/context
 *   {
 *     "workspace": "acme/bcontext",
 *     "query": "what's blocking the embedding pipeline?",
 *     "k": 6
 *   }
 *
 * `retrieval: "keyword"` answers from the keyword scorer even where
 * embeddings are configured — the evaluation (`scripts/rag-eval.mjs`) uses
 * it to score both paths on the same questions; `scope.keyword_fallback` in
 * the response says which one answered.
 */
import { z } from "zod";
import { retrieveScoped } from "@/lib/rag";
import { RetrievalScopeSchema } from "@/lib/rag/scope";
import { readJsonBody } from "@/lib/parse-json";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { viewPrincipal } from "@/lib/views/access";

const TREE_FIELDS = [
  "id",
  "parent_id",
  "kind",
  "tags",
  "slug",
  "title",
  "status",
  "updated_at",
] as const;
type TreeField = (typeof TREE_FIELDS)[number];

const Schema = z.object({
  workspace: z.string(),
  query: z.string().default(""),
  k: z.number().int().min(1).max(20).default(6),
  /** Project the semantic `tree` array to a subset of fields. */
  fields: z.array(z.enum(TREE_FIELDS)).optional(),
  include_counts: z.boolean().default(true),
  scope: RetrievalScopeSchema.optional(),
  /** `keyword` skips the vector path; `auto` (default) is the product's behaviour. */
  retrieval: z.enum(["auto", "keyword"]).default("auto"),
});

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { workspace, query, k, fields, include_counts, scope, retrieval: retrievalMode } = parsed.data;

  const ctx = await openWorkspace(req, workspace, "read", { scope: "agents:read" });
  if (ctx instanceof Response) return ctx;
  const { storage, actor: gated } = ctx;

  const retrieval = await retrieveScoped(workspace, query, {
    k,
    scope,
    storage,
    viewPrincipal: await viewPrincipal(gated, storage),
    forceKeyword: retrievalMode === "keyword",
  });
  const nodes = await storage.listNodes();

  const projection: TreeField[] =
    fields && fields.length > 0
      ? fields
      : ["id", "parent_id", "kind", "tags", "slug", "title", "status"];

  const tree = nodes.map((n) => {
    const out: Record<string, unknown> = {};
    for (const f of projection) out[f] = n[f];
    return out;
  });

  const response: Record<string, unknown> = {
    workspace,
    query,
    scope: retrieval.scope,
    retrieved: retrieval.hits,
    tree,
  };
  if (include_counts) {
    response.counts = {
      docs: nodes.filter((n) => n.kind === "doc").length,
      tasks: nodes.filter((n) => n.kind === "task").length,
      decisions: nodes.filter((n) => n.kind === "decision").length,
      bugs: nodes.filter((n) => n.kind === "bug").length,
    };
  }
  return Response.json(response);
});

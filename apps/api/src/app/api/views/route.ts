/**
 * Saved views of a workspace — a query plus a presentation (list, board,
 * graph…) — as the web's sidebar lists and creates them. REST twin of MCP
 * `views` / `views_write(op=create)`.
 *
 *   GET  /api/views?workspace=…
 *   POST /api/views   { workspace, name, description?, visibility?, query, presentation }
 *
 * Every views route goes through `resolveViewRequest`, which opens the
 * workspace (token scope `nodes:read` / `nodes:write`) and derives the view
 * principal; private-vs-workspace visibility and ownership are enforced in
 * `@/lib/views/store`, not here.
 */
import { z } from "zod";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { ViewPresentationSchema, ViewQuerySchema } from "@bcontext-dev/contract/views/schema";
import { createView, listViews } from "@/lib/views/store";
import { resolveViewRequest, viewErrorResponse } from "@/lib/views/http";

const CreateSchema = z.object({
  workspace: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  visibility: z.enum(["private", "workspace"]).optional(),
  query: ViewQuerySchema,
  presentation: ViewPresentationSchema,
}).strict();

export const GET = withRoute(async (req: Request) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!workspace) return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  const resolved = await resolveViewRequest(req, workspace, "nodes:read");
  if ("response" in resolved) return resolved.response;
  return Response.json({ views: await listViews(resolved.storage, resolved.principal) });
});

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const { workspace, ...input } = parsed.data;
  const resolved = await resolveViewRequest(req, workspace, "nodes:write", "write");
  if ("response" in resolved) return resolved.response;
  try {
    return Response.json({ view: await createView(resolved.storage, resolved.principal, input) }, { status: 201 });
  } catch (error) {
    const response = viewErrorResponse(error);
    if (response) return response;
    throw error;
  }
});

/**
 * One saved view. REST twin of MCP `views(op=get)` /
 * `views_write(op=update|delete)`.
 *
 *   GET    /api/views/:id?workspace=…
 *   PATCH  /api/views/:id                { workspace, expected_version, ...fields }
 *   DELETE /api/views/:id?workspace=…[&expected_version=]
 *
 * `expected_version` is the optimistic lock (409 with both versions when it
 * is stale). Access rules live in `@/lib/views/store`; see `views/route.ts`.
 */
import { z } from "zod";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { ViewPresentationSchema, ViewQuerySchema } from "@bcontext-dev/contract/views/schema";
import { deleteView, getView, updateView } from "@/lib/views/store";
import { resolveViewRequest, viewErrorResponse } from "@/lib/views/http";

type Context = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  workspace: z.string().min(1),
  expected_version: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  visibility: z.enum(["private", "workspace"]).optional(),
  query: ViewQuerySchema.optional(),
  presentation: ViewPresentationSchema.optional(),
}).strict();

export const GET = withRoute(async (req: Request, { params }: Context) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!workspace) return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  const resolved = await resolveViewRequest(req, workspace, "nodes:read");
  if ("response" in resolved) return resolved.response;
  try {
    return Response.json({ view: await getView(resolved.storage, resolved.principal, (await params).id) });
  } catch (error) {
    const response = viewErrorResponse(error); if (response) return response; throw error;
  }
});

export const PATCH = withRoute(async (req: Request, { params }: Context) => {
  const body = await readJsonBody(req); if (!body.ok) return body.response;
  const parsed = PatchSchema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const { workspace, ...input } = parsed.data;
  const resolved = await resolveViewRequest(req, workspace, "nodes:write", "write");
  if ("response" in resolved) return resolved.response;
  try {
    return Response.json({ view: await updateView(resolved.storage, resolved.principal, (await params).id, input) });
  } catch (error) {
    const response = viewErrorResponse(error); if (response) return response; throw error;
  }
});

export const DELETE = withRoute(async (req: Request, { params }: Context) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  const expectedRaw = new URL(req.url).searchParams.get("expected_version");
  const expectedVersion = expectedRaw ? Number(expectedRaw) : undefined;
  if (!workspace) return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  if (expectedRaw && (!Number.isInteger(expectedVersion) || expectedVersion! < 1)) return Response.json({ error: "invalid expected_version" }, { status: 400 });
  const resolved = await resolveViewRequest(req, workspace, "nodes:write", "write");
  if ("response" in resolved) return resolved.response;
  try {
    await deleteView(resolved.storage, resolved.principal, (await params).id, expectedVersion);
    return Response.json({ ok: true });
  } catch (error) {
    const response = viewErrorResponse(error); if (response) return response; throw error;
  }
});

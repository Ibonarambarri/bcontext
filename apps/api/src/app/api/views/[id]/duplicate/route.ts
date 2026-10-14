/**
 * POST /api/views/:id/duplicate — copy a view (a shared workspace view into a
 * private one the person can then tweak, typically). Optional `name`;
 * otherwise the store derives one. Access rules in `@/lib/views/store`.
 */
import { z } from "zod";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { duplicateView } from "@/lib/views/store";
import { resolveViewRequest, viewErrorResponse } from "@/lib/views/http";

const Schema = z.object({ workspace: z.string().min(1), name: z.string().trim().min(1).max(120).optional() }).strict();

export const POST = withRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const body = await readJsonBody(req); if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const resolved = await resolveViewRequest(req, parsed.data.workspace, "nodes:write", "write");
  if ("response" in resolved) return resolved.response;
  try {
    const view = await duplicateView(resolved.storage, resolved.principal, (await params).id, parsed.data.name);
    return Response.json({ view }, { status: 201 });
  } catch (error) {
    const response = viewErrorResponse(error); if (response) return response; throw error;
  }
});

/**
 * POST /api/workspaces/[ws]/apply-template
 *   { "template": "indie-hacker" | "ai-agency" | "startup-founder" }
 *
 * Idempotent: nodes already in the workspace are detected by (parent, title)
 * and skipped.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { applyTemplateById } from "@/lib/templates/apply";
import { listTemplates } from "@bcontext-dev/contract/templates/workspaces";
import { withRoute } from "@/lib/route";

const Body = z.object({
  template: z.string().min(1).max(64),
});

export const GET = withRoute(async (_req: Request) => {
  return Response.json({
    templates: listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      node_count: t.nodes.length,
    })),
  });
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ctx = await openWorkspace(req, ws, "write");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  try {
    const result = await applyTemplateById(storage, parsed.data.template);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
});

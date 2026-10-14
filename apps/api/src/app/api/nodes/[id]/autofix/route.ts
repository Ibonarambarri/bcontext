/**
 * POST /api/nodes/:id/autofix — the editor's "tidy this up" button: an LLM
 * rewrite of the body, returned for review, never written here.
 *
 * Read verb via `openWorkspace` (scope `chat:run` for tokens); metered
 * against the organization's AI-query budget like chat. See the handler's
 * JSDoc for the contract.
 */
import { z } from "zod";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import { recordUsage } from "@/lib/organizations/meters";
import { autofixBody, AutofixError } from "@/lib/autofix";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { recordAiUsageEvent } from "@/lib/telemetry/ai-usage";

const BodySchema = z.object({
  workspace: z.string().min(1),
});

/**
 * POST /api/nodes/:id/autofix — rewrite the node body with the LLM,
 * preserving all information, and return it for the CLIENT to review as
 * a diff. Nothing is written to the node here; applying the rewrite goes
 * through the normal PATCH /api/nodes/:id save path after the user
 * accepts. Counted on the organization's `ai_queries` meter.
 */
export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = BodySchema.safeParse(parsed.data);
  if (!body.success) {
    return Response.json(
      { error: body.error.flatten() },
      { status: 400 },
    );
  }

  // Autofix only reads the node; the rewrite it returns is applied by the
  // client through PATCH /api/nodes/:id, which does its own write check.
  const opened = await openWorkspace(req, body.data.workspace, "read", {
    scope: "chat:run",
  });
  if (opened instanceof Response) return opened;
  const { storage, actor: gated } = opened;

  const { id } = await params;
  const node = await storage.getNode(id);
  if (!node) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (storage.backend === "supabase") {
    void recordUsage(storage.workspace.organization_id, actingUserId(gated), "ai_queries");
  }

  try {
    const result = await autofixBody({
      bodyMd: node.content_md ?? "",
      title: node.title,
    });
    if (storage.backend === "supabase") {
      void recordAiUsageEvent({
        workspaceId: storage.workspace.id,
        subjectUserId: actingUserId(gated),
        surface: "autofix",
        model: result.model,
        tokens: result.tokens,
        metadata: { node_id: id },
      });
    }
    return Response.json({
      rewritten_md: result.rewrittenMd,
      model: result.model,
      segments: result.segments,
      updated_at: node.updated_at ?? null,
    });
  } catch (err) {
    if (err instanceof AutofixError) {
      const status =
        err.code === "input_too_short"
          ? 422
          : err.code === "no_gateway_key"
            ? 503
            : 502;
      return Response.json(
        { error: err.code, message: err.message },
        { status },
      );
    }
    throw err;
  }
});

/**
 * POST /api/skills/[id]/run
 *
 * Execute a skill node. Mirrors the MCP `skills_run` tool over REST so
 * non-MCP clients (n8n, custom workflows, manual triggers) can invoke
 * skills.
 *
 * Body: { workspace: <slug>, input: Record<string, unknown>, model?: string }
 * Returns: RunSkillOutput | 400 on SkillError | 404 on missing skill.
 */
import { z } from "zod";
import { actingUserId } from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { runSkill, SkillError } from "@/lib/skills/run";

const BodySchema = z.object({
  workspace: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  model: z.string().optional(),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const POST = withRoute(async (req: Request, ctx: RouteCtx) => {
  const { id } = await ctx.params;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = BodySchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // A skill run reads the skill node and the context it pulls in; it writes
  // nothing back. `chat:run` stays the scope, as on the other LLM surfaces.
  const opened = await openWorkspace(req, parsed.data.workspace, "read", {
    scope: "chat:run",
  });
  if (opened instanceof Response) return opened;
  const { storage, actor: gated } = opened;

  // Optional per-request AI Gateway key from the dev settings dialog —
  // same fall-back ladder the chat route uses.
  const headerKey = req.headers.get("x-ai-gateway-key");
  const apiKey = headerKey && headerKey.length <= 200 ? headerKey : undefined;

  try {
    const out = await runSkill(
      storage,
      { skill_id: id, input: parsed.data.input, model: parsed.data.model },
      apiKey,
      actingUserId(gated),
    );
    return Response.json(out);
  } catch (err) {
    if (err instanceof SkillError) {
      return Response.json(
        { error: err.message },
        { status: err.status },
      );
    }
    throw err;
  }
});

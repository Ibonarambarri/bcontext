/**
 * POST /api/integrations/meeting-records/proposal
 *
 * Turn the user's free-text objective into a reviewable extraction
 * proposal ("given your goal, we'll aim to extract this for you").
 * Uses the AI Gateway when configured (metered on the `integration_setup`
 * surface); otherwise a deterministic keyword heuristic — the setup flow
 * never dead-ends on missing AI infra.
 *
 * Body: { workspace, objective, feedback?, previous_items? }
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { generateExtractionProposal } from "@/lib/integrations/extraction-proposal";

const Schema = z.object({
  workspace: z.string().min(1),
  objective: z.string().min(12).max(2000),
  feedback: z.string().max(1000).optional(),
  previous_items: z
    .array(z.object({ label: z.string().min(1).max(80), detail: z.string().max(240) }))
    .max(12)
    .optional(),
});

export const POST = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Drafts an extraction proposal and returns it; nothing is stored until the
  // PUT on ../config, which asks for `write`.
  const ctx = await openWorkspace(req, parsed.data.workspace, "read", {
    scope: null,
  });
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  const proposal = await generateExtractionProposal({
    workspaceId: storage.workspace.id,
    objective: parsed.data.objective.trim(),
    feedback: parsed.data.feedback?.trim() || undefined,
    previousItems: parsed.data.previous_items,
  });

  return Response.json(proposal);
});

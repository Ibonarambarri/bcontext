/**
 * POST /api/connectors/[id]/sync
 *
 * Re-runs `fullSync` for the install. Enqueues a job + executes inline so
 * the response carries the outcome.
 *
 * Body: { workspace_id }
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { runFullSyncSync } from "@/lib/connectors/runtime";
import type { ConnectorId } from "@bcontext-dev/contract/connectors/types";
import "@/lib/connectors/bootstrap";

const Schema = z.object({ workspace_id: z.string().uuid() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const POST = withRoute(async (req: Request, ctx: RouteCtx) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required" },
      { status: 403 },
    );
  }
  const { id: connectorId } = await ctx.params;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await runFullSyncSync(
    parsed.data.workspace_id,
    connectorId as ConnectorId,
  );
  if (!result.ok) {
    return Response.json(
      { error: result.error ?? "sync_failed" },
      { status: 400 },
    );
  }
  return Response.json({ ok: true, job_id: result.jobId });
});

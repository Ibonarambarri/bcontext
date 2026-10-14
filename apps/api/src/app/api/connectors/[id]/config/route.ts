/**
 * PATCH /api/connectors/[id]/config
 *
 * Update a connector install's ingest configuration (free-text goal and/or
 * cadence) — the Ingesta page's ⚙ Configurar modal. Merges into the
 * existing `connector_installs.config` bag; doesn't touch OAuth secrets.
 *
 * Body: { workspace_id, ingest_guidance?, cadence? }
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getInstall, updateInstall } from "@/lib/connectors/installs";
import { CadenceSchema, computeNextRun } from "@bcontext-dev/contract/connectors/cadence";
import type { ConnectorId } from "@bcontext-dev/contract/connectors/types";
import "@/lib/connectors/bootstrap";

const Schema = z.object({
  workspace_id: z.string().uuid(),
  ingest_guidance: z.string().max(4000).optional(),
  cadence: CadenceSchema.optional(),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const PATCH = withRoute(async (req: Request, ctx: RouteCtx) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Addressed by UUID (the id is in the body), no scope today, and it edits
  // the install's ingest configuration — a write.
  const opened = await openWorkspaceById(req, parsed.data.workspace_id, "write", {
    scope: null,
  });
  if (opened instanceof Response) return opened;

  const { id: connectorId } = await ctx.params;
  const install = await getInstall(parsed.data.workspace_id, connectorId as ConnectorId);
  if (!install) {
    return Response.json({ error: "install not found" }, { status: 404 });
  }

  const config = { ...install.config };
  if (parsed.data.ingest_guidance !== undefined) config.ingest_guidance = parsed.data.ingest_guidance;
  if (parsed.data.cadence !== undefined) {
    config.cadence = parsed.data.cadence;
    // The scheduler (src/lib/connectors/scheduler.ts) fires on next_run_at;
    // a new cadence starts counting from now.
    config.next_run_at = computeNextRun(parsed.data.cadence, new Date()).toISOString();
  }

  await updateInstall(install.id, { config });
  return Response.json({ install: { ...install, config } });
});

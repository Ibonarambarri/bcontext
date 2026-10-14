/**
 * GET  /api/integrations/meeting-records/config?workspace=<slug>
 * PUT  /api/integrations/meeting-records/config
 *
 * Read / save the mandatory Meeting records setup (cadence is forced to
 * "instant" server-side; the client only sends objective + accepted
 * extraction items). Until the config exists the integration renders
 * semi-locked in the Integrations surface.
 *
 * Persistence: connector_installs.config (connector_id 'meeting-bot') for
 * Supabase workspaces — requires migration 0053; returns 503
 * `migration_pending` until it is applied. Demo workspaces persist
 * in-memory so the flow works without Supabase.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import {
  ExtractionItemSchema,
  getMeetingRecordsConfig,
  MeetingRecordsMigrationPendingError,
  saveMeetingRecordsConfig,
} from "@/lib/integrations/meeting-records";

const PutSchema = z.object({
  workspace: z.string().min(1),
  objective: z.string().min(12).max(2000),
  extraction_items: z.array(ExtractionItemSchema).min(1).max(12),
});

export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read", { scope: null });
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  const config = await getMeetingRecordsConfig(storage.backend, storage.workspace.id);
  return Response.json({ config, configured: config !== null });
});

export const PUT = withRoute(async (req: Request) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = PutSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ctx = await openWorkspace(req, parsed.data.workspace, "write", {
    scope: null,
  });
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  const config = {
    cadence: "instant" as const,
    objective: parsed.data.objective.trim(),
    extraction_items: parsed.data.extraction_items,
    configured_at: new Date().toISOString(),
  };

  try {
    await saveMeetingRecordsConfig(storage.backend, storage.workspace.id, config);
  } catch (cause) {
    if (cause instanceof MeetingRecordsMigrationPendingError) {
      return Response.json(
        { error: "migration_pending", message: cause.message },
        { status: 503 },
      );
    }
    throw cause;
  }
  return Response.json({ config, configured: true });
});

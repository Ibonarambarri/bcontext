/**
 * GET /api/integrations/activity?workspace_id=<uuid>
 *
 * Live state per connected integration — what the hub polls every few
 * seconds to light up the "fetching / NEXO is processing" aura.
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { loadActivity } from "@/lib/connectors/activity";

const QuerySchema = z.object({ workspace_id: z.string().uuid() });

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ workspace_id: url.searchParams.get("workspace_id") });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const ctx = await openWorkspaceById(req, parsed.data.workspace_id, "read");
  if (ctx instanceof Response) return ctx;
  if (ctx.storage.backend !== "supabase") {
    return Response.json({ activity: [] });
  }
  const activity = await loadActivity(getSupabaseAdmin(), parsed.data.workspace_id);
  return Response.json({ activity }, { headers: { "Cache-Control": "no-store" } });
});

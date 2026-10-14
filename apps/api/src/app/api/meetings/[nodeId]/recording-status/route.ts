/**
 * GET /api/meetings/[nodeId]/recording-status
 *
 * Lightweight polling endpoint for the MeetingRecordingView.
 * Returns:
 *   - The latest `meeting_bots.status` for the bot attached to this node,
 *     so the UI can render the live timeline (scheduled → joining →
 *     in_call → call_ended → transcribing → done) without depending on
 *     the realtime broadcast (a socket can drop mid-call).
 *   - `locked: true` while the meeting node still carries
 *     `data.recording_status === "recording"`. When that flag is cleared
 *     by the webhook handler, the UI knows to call `router.refresh()`
 *     and swap the locked view for the editor.
 *
 * The endpoint is intentionally bare and same-origin only — no token
 * required when called from the workspace UI; the gate's anonymous
 * fallback in dev keeps it usable in demo mode too.
 */
import { withRoute } from "@/lib/route";
import { gate, requireWorkspaceMember } from "@/lib/auth/require";
import { getStorageById } from "@/lib/storage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const GET = withRoute(
  async (req: Request, { params }: { params: Promise<{ nodeId: string }> }) => {
    const gated = await gate(req, "nodes:read", { allowAnonymous: true });
    if (gated instanceof Response) return gated;
    const { nodeId } = await params;

    const sb = getSupabaseAdmin();
    const { data: node } = await sb
      .from("nodes")
      .select("workspace_id, kind, data")
      .eq("id", nodeId)
      .maybeSingle();
    if (!node) {
      return Response.json({ error: "node_not_found" }, { status: 404 });
    }
    // The node id is caller-supplied and unscoped. Checking only agent tokens
    // left user and demo actors able to read any tenant's meeting state by id.
    // `requireWorkspaceMember` covers every actor kind and no-ops on the demo
    // backend, so local dev keeps working.
    const storage = await getStorageById(node.workspace_id);
    if (!storage) {
      return Response.json({ error: "node_not_found" }, { status: 404 });
    }
    const denied = await requireWorkspaceMember(gated, storage);
    if (denied) {
      return Response.json({ error: "node_not_found" }, { status: 404 });
    }

    if (node.kind !== "meeting") {
      return Response.json({ error: "wrong_kind" }, { status: 400 });
    }
    const data = (node.data ?? {}) as {
      recording_status?: string | null;
      refine_status?: string | null;
    };
    const locked = data.recording_status === "recording";

    const { data: bot } = await sb
      .from("meeting_bots")
      .select("id, status, external_id")
      .eq("transcript_node_id", nodeId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return Response.json(
      {
        nodeId,
        locked,
        botId: bot?.id ?? null,
        externalId: bot?.external_id ?? null,
        status: bot?.status ?? null,
        refineStatus: data.refine_status ?? null,
      },
      {
        // Don't let any layer cache this — it's a live status probe.
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  },
);

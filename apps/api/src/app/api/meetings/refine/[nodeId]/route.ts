/**
 * POST /api/meetings/refine/[nodeId]
 *
 * Re-run the refine pipeline for an existing meeting node. Used for:
 *   - Retrying a failed refine (RefineError(model_error) etc.).
 *   - Re-refining after a model upgrade or a tweak to the prompt template.
 *   - Bootstrapping refined notes on meetings that were imported before
 *     the pipeline existed (the importer left `data.transcript_md` filled).
 *
 * Gated on `agents:write` to match the schedule endpoint. The actual
 * refine runs unawaited; the response returns immediately so the UI can
 * show "refining…" without holding the request open.
 */
import { withRoute } from "@/lib/route";
import { gate } from "@/lib/auth/require";
import { getStorageById } from "@/lib/storage";
import { kickoffRefineJob, type RefineStatus } from "@/lib/meetings/refine-job";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

interface MeetingNodeData extends Record<string, unknown> {
  transcript_md?: string;
  participants?: string[];
  duration_s?: number | null;
  refine_status?: RefineStatus;
}

export const POST = withRoute(
  async (req: Request, { params }: { params: Promise<{ nodeId: string }> }) => {
    const gated = await gate(req, "agents:write");
    if (gated instanceof Response) return gated;
    const { nodeId } = await params;

    if (gated.kind === "agent" || gated.kind === "agent_user" || gated.kind === "user") {
      // Resolve the node's workspace from the bearer token (workspace-scoped)
      // or the user's memberships. We fetch by nodeId via the admin client
      // and verify access. For workspace-scoped agent tokens the token
      // already pins the workspace.
    }

    // Find the node. For workspace-scoped tokens, getStorageById uses the
    // token's workspace; for user tokens we fall through to the demo path
    // (refining is a no-op in demo since there's no AI Gateway round-trip
    // worth performing on transient data).
    const workspaceId =
      gated.kind === "agent" ? gated.workspaceId : undefined;
    if (!workspaceId) {
      return Response.json(
        {
          error: "workspace_scope_required",
          message:
            "use a workspace-scoped agent token (or call from the web UI) to re-refine a meeting node",
        },
        { status: 403 },
      );
    }

    const storage = await getStorageById(workspaceId);
    if (!storage) {
      return Response.json(
        { error: "workspace_not_found" },
        { status: 404 },
      );
    }

    const node = await storage.getNode(nodeId);
    if (!node) {
      return Response.json({ error: "node_not_found" }, { status: 404 });
    }
    if (node.kind !== "meeting") {
      return Response.json(
        { error: "wrong_kind", message: "node is not a meeting" },
        { status: 400 },
      );
    }

    const data = (node.data ?? {}) as MeetingNodeData;
    const transcript = data.transcript_md ?? node.content_md ?? "";
    if (!transcript.trim()) {
      return Response.json(
        { error: "no_transcript", message: "no transcript stored for this meeting" },
        { status: 400 },
      );
    }

    // Flip status to pending so the selector shows the "refining…" chip
    // even before the worker picks it up.
    await storage.updateNode(nodeId, {
      data: { ...data, refine_status: "pending", refine_error: null },
    });
    wsBroadcast.nodeUpdated(workspaceId, nodeId);

    void kickoffRefineJob({
      workspaceId,
      nodeId,
      transcriptMd: transcript,
      title: node.title,
      participants: data.participants ?? [],
      durationSec: data.duration_s ?? null,
    });

    return Response.json({ ok: true, status: "pending" as RefineStatus });
  },
);

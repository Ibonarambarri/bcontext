/**
 * POST /api/meetings/attach-transcript/[nodeId]
 *
 * Attach a manually-supplied transcript to an existing meeting node.
 * Used when the user already has a transcript (from a recording
 * service that's not Recall, from a vendor export, from an Otter session,
 * etc.) and wants Bcontext to ingest + refine it without dropping a bot
 * into a live call.
 *
 * Flow:
 *   1. Validate ownership + scope (`agents:write`).
 *   2. Trim + sanity-check the pasted content.
 *   3. Write `content_md` (= pasted) + `data.transcript_md` (= pasted) +
 *      `data.refine_status = pending` on the node.
 *   4. Fire `kickoffRefineJob` unawaited.
 *   5. Return 200 with status `pending` so the UI flips the selector to
 *      "refining…" state.
 */
import { z } from "zod";
import { withRoute } from "@/lib/route";
import { gate } from "@/lib/auth/require";
import { getStorageById } from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { kickoffRefineJob, type RefineStatus } from "@/lib/meetings/refine-job";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

const Schema = z.object({
  transcript: z.string().min(50, "transcript too short — paste at least 50 characters"),
  participants: z.array(z.string()).max(50).optional(),
  durationSec: z.number().int().positive().max(60 * 60 * 12).optional(),
});

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

    const parsedBody = await readJsonBody(req);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = Schema.safeParse(parsedBody.data);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data;

    // Resolve workspace from the bearer or session. For workspace-scoped
    // tokens we use the token's workspaceId; for user sessions we have to
    // look up the node and verify membership. Simpler v1: require an
    // agent or user actor with workspace scope.
    const workspaceId =
      gated.kind === "agent" ? gated.workspaceId : undefined;
    if (!workspaceId) {
      return Response.json(
        {
          error: "workspace_scope_required",
          message:
            "use a workspace-scoped agent token or the web UI's same-origin session to attach a transcript",
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

    const transcript = input.transcript.trim();
    const existingData = (node.data ?? {}) as MeetingNodeData;
    const participants =
      input.participants ?? existingData.participants ?? [];
    const durationSec = input.durationSec ?? existingData.duration_s ?? null;

    await storage.updateNode(nodeId, {
      content_md: transcript,
      data: {
        ...existingData,
        source: existingData.source ?? "manual-attach",
        transcript_md: transcript,
        participants,
        duration_s: durationSec,
        refine_status: "pending",
        refine_error: null,
      },
    });
    wsBroadcast.nodeUpdated(workspaceId, nodeId);

    void kickoffRefineJob({
      workspaceId,
      nodeId,
      transcriptMd: transcript,
      title: node.title,
      participants,
      durationSec,
    });

    return Response.json({
      ok: true,
      status: "pending" as RefineStatus,
      length: transcript.length,
    });
  },
);

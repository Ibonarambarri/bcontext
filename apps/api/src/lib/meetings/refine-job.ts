/**
 * Background refine job.
 *
 * Runs after a meeting node is created from a transcript_ready webhook,
 * unawaited. The webhook responds 200 immediately; this job runs to
 * completion in the same API process (a few seconds typically, up to ~30s
 * for long transcripts) — it is not a queued job, so a restart mid-refine
 * leaves the node in `refine_status='pending'`.
 *
 * Failure mode: log + set `data.refine_status='failed'` + write the error
 * message. The Refined / Transcript selector falls back to Transcript-only
 * in that state.
 */
import { refineTranscript, RefineError } from "./refine";
import { proposeMeetingCandidates } from "./candidates";
import { getStorageById } from "@/lib/storage";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { log } from "@bcontext-dev/contract/log";
import { recordAiUsageEvent } from "@/lib/telemetry/ai-usage";

export type { RefineStatus } from "@bcontext-dev/contract/meetings";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";

export interface MeetingRefineData extends Record<string, unknown> {
  transcript_md?: string;
  refine_status?: RefineStatus;
  refine_error?: string | null;
  refined_at?: string | null;
  refined_model?: string | null;
}

export interface KickoffInput {
  workspaceId: string;
  nodeId: string;
  transcriptMd: string;
  title: string;
  participants: string[];
  durationSec: number | null;
}

/**
 * Kick off a refine job. Returns immediately; the actual work is the
 * unawaited promise returned by {@link runRefineJob}. Callers `void` it.
 */
export function kickoffRefineJob(input: KickoffInput): Promise<void> {
  return runRefineJob(input).catch((err) => {
    log.error("meeting.refine.unhandled", {
      workspace_id: input.workspaceId,
      node_id: input.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function runRefineJob(input: KickoffInput): Promise<void> {
  const storage = await getStorageById(input.workspaceId);
  if (!storage) {
    log.warn("meeting.refine.storage_missing", {
      workspace_id: input.workspaceId,
      node_id: input.nodeId,
    });
    return;
  }

  let result;
  try {
    result = await refineTranscript({
      transcriptMd: input.transcriptMd,
      title: input.title,
      participants: input.participants,
      durationSec: input.durationSec,
    });
  } catch (err) {
    const code =
      err instanceof RefineError ? err.code : "model_error";
    const message = err instanceof Error ? err.message : String(err);
    log.warn("meeting.refine.failed", {
      workspace_id: input.workspaceId,
      node_id: input.nodeId,
      code,
      error: message,
    });
    const current = await storage.getNode(input.nodeId);
    if (!current) return;
    const data = (current.data ?? {}) as MeetingRefineData;
    await storage.updateNode(input.nodeId, {
      data: {
        ...data,
        refine_status: code === "input_too_short" ? "skipped" : "failed",
        refine_error: message,
      },
    });
    wsBroadcast.nodeUpdated(input.workspaceId, input.nodeId);
    return;
  }

  if (storage.backend === "supabase") {
    void recordAiUsageEvent({
      workspaceId: storage.workspace.id,
      surface: "meeting_refine",
      model: result.model,
      tokens: result.tokens,
      metadata: { node_id: input.nodeId },
    });
  }

  const current = await storage.getNode(input.nodeId);
  if (!current) {
    log.warn("meeting.refine.node_missing", {
      workspace_id: input.workspaceId,
      node_id: input.nodeId,
    });
    return;
  }
  const data = (current.data ?? {}) as MeetingRefineData;
  await storage.updateNode(input.nodeId, {
    content_md: result.refinedMd,
    data: {
      ...data,
      refine_status: "done" as RefineStatus,
      refine_error: null,
      refined_at: new Date().toISOString(),
      refined_model: result.model,
    },
  });
  wsBroadcast.nodeUpdated(input.workspaceId, input.nodeId);
  log.info("meeting.refine.done", {
    workspace_id: input.workspaceId,
    node_id: input.nodeId,
    model: result.model,
    bytes: result.refinedMd.length,
  });

  if (storage.backend === "supabase") {
    try {
      const candidates = await proposeMeetingCandidates({
        workspaceId: storage.workspace.id,
        workspaceSlug: storage.workspace.slug,
        meetingNodeId: input.nodeId,
        refinedMd: result.refinedMd,
        participants: input.participants,
      });
      log.info("meeting.candidates.proposed", {
        workspace_id: input.workspaceId,
        node_id: input.nodeId,
        ...candidates,
      });
    } catch (err) {
      // Candidate proposal is additive — a failure here must never
      // roll back or block the refine that already succeeded.
      log.warn("meeting.candidates.propose_failed", {
        workspace_id: input.workspaceId,
        node_id: input.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

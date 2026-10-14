/**
 * POST /api/connectors/meeting-bot/webhook
 *
 * Receives bot lifecycle + transcript events from the meeting-bot provider
 * (Recall.ai in v1). All requests are HMAC-verified before any side effect.
 *
 * Dispatch:
 *   - status_change   → update `meeting_bots.status` (idempotent by
 *                       (provider, external_id)).
 *   - transcript_ready → fetch the transcript + recording URL, materialize
 *                       a `meeting` node (deduped against
 *                       `transcript_node_id`), broadcast `done`.
 *
 * Idempotency: re-deliveries of the same event are safe — `status_change`
 * only writes when the status differs, and `transcript_ready` checks
 * `transcript_node_id` before creating the meeting node.
 */
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getStorageById } from "@/lib/storage";
import { log } from "@bcontext-dev/contract/log";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { getMeetingBotProvider } from "@/lib/connectors/meeting-bot";
import { transcriptToMarkdown } from "@/lib/connectors/meeting-bot/transcript-to-markdown";
import { broadcastMeetingBotStatus } from "@/lib/connectors/meeting-bot/realtime";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import {
  defaultMeetingTitle,
  participantsLine,
} from "@/lib/connectors/meeting-bot/format";
import { kickoffRefineJob } from "@/lib/meetings/refine-job";
import { addMeetingMinutes, recordUsage } from "@/lib/organizations/meters";
import type { MeetingBotStatus } from "@bcontext-dev/contract/connectors/meeting-bot/provider";

interface MeetingBotRow {
  id: string;
  workspace_id: string;
  status: MeetingBotStatus;
  meeting_url: string;
  recording_url: string | null;
  transcript_node_id: string | null;
  /** Who scheduled the bot; null for bots that predate the column. */
  created_by: string | null;
}

export const POST = withRoute(async (req: Request) => {
  const provider = getMeetingBotProvider();
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  let event;
  try {
    event = await provider.verifyWebhook({ rawBody, headers });
  } catch (err) {
    if (err instanceof ConnectorSignatureError) {
      // Diagnostic: report which header families were present so we can
      // distinguish "wrong secret" from "wrong scheme". Header VALUES are
      // not logged — only presence + the event type (if the body parses).
      let eventType: string | null = null;
      try {
        const sniff = JSON.parse(rawBody) as { type?: string; event?: string };
        eventType = sniff.type ?? sniff.event ?? null;
      } catch {
        // body not JSON
      }
      // Whitelist of header names we care about for diagnostics. We log
      // the full key set too (no values) so we can spot a brand-new naming
      // scheme without exposing tokens. Anything like "authorization" or
      // "cookie" gets filtered out of the dump regardless.
      const SENSITIVE = new Set(["authorization", "cookie", "x-api-key"]);
      const headerKeys = Object.keys(headers).filter((k) => !SENSITIVE.has(k));
      log.warn("meeting_bot.webhook.bad_signature", {
        provider: provider.id,
        has_svix_id: Boolean(headers["svix-id"]),
        has_svix_timestamp: Boolean(headers["svix-timestamp"]),
        has_svix_signature: Boolean(headers["svix-signature"]),
        has_webhook_id: Boolean(headers["webhook-id"]),
        has_webhook_timestamp: Boolean(headers["webhook-timestamp"]),
        has_webhook_signature: Boolean(headers["webhook-signature"]),
        has_recall_signature: Boolean(headers["recall-signature"]),
        event_type: eventType,
        header_keys: headerKeys,
      });
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    }
    throw err;
  }

  if (event.kind === "ignored" || !event.externalId) {
    return Response.json({ ok: true, ignored: true });
  }

  const sb = getSupabaseAdmin();
  const { data: row } = await sb
    .from("meeting_bots")
    .select(
      "id, workspace_id, status, meeting_url, recording_url, transcript_node_id, created_by",
    )
    .eq("provider", provider.id)
    .eq("external_id", event.externalId)
    .maybeSingle();

  if (!row) {
    // Webhook for an unknown bot — probably from a different environment
    // sharing the same Recall project. Acknowledge so the provider stops
    // retrying.
    log.warn("meeting_bot.webhook.unknown_bot", {
      provider: provider.id,
      external_id: event.externalId,
    });
    return Response.json({ ok: true, ignored: true });
  }
  const botRow = row as MeetingBotRow;

  if (event.kind === "status_change") {
    if (!event.status || event.status === botRow.status) {
      log.info("meeting_bot.webhook.status_change.noop", {
        bot_id: botRow.id,
        external_id: event.externalId,
        status: botRow.status,
      });
      return Response.json({ ok: true, status: botRow.status });
    }
    log.info("meeting_bot.webhook.status_change", {
      bot_id: botRow.id,
      external_id: event.externalId,
      from: botRow.status,
      to: event.status,
    });
    await sb
      .from("meeting_bots")
      .update({ status: event.status })
      .eq("id", botRow.id);
    void broadcastMeetingBotStatus(botRow.workspace_id, {
      botId: botRow.id,
      externalId: event.externalId,
      status: event.status,
      nodeId: botRow.transcript_node_id ?? undefined,
    });
    return Response.json({ ok: true, status: event.status });
  }

  if (event.kind === "transcript_ready") {
    const storage = await getStorageById(botRow.workspace_id);
    if (!storage) {
      log.error("meeting_bot.webhook.storage_missing", {
        workspace_id: botRow.workspace_id,
        bot_id: botRow.id,
      });
      return Response.json({ error: "storage_unavailable" }, { status: 500 });
    }

    const state = await provider.getMeeting(event.externalId);
    const segments = state.transcript ?? [];
    const fallbackTitle =
      state.topic ?? defaultMeetingTitle(state.botJoinedAt ?? state.callEndedAt);
    const subtitle = participantsLine(state.participants);
    const content = transcriptToMarkdown(segments, {
      title: fallbackTitle,
      subtitle,
      timestamps: true,
    });

    // Two paths, decided by whether the schedule call pre-attached this
    // bot to an existing node (manual flow: user creates an empty meeting
    // node, hits "Record with Recall" → transcript_node_id is set already)
    // or not (legacy flow: standalone modal → create a new node).
    let targetNodeId: string;
    let attached = false;
    if (botRow.transcript_node_id) {
      const existing = await storage.getNode(botRow.transcript_node_id);
      if (existing) {
        const existingData = (existing.data ?? {}) as Record<string, unknown>;
        const alreadyDone =
          typeof existingData.refine_status === "string" &&
          existingData.refine_status === "done" &&
          typeof existingData.transcript_md === "string" &&
          (existingData.transcript_md as string).length > 0;
        if (alreadyDone) {
          // Idempotent re-delivery on the attached node.
          return Response.json({ ok: true, status: "done", replay: true, nodeId: existing.id });
        }
        await storage.updateNode(existing.id, {
          content_md: content,
          data: {
            ...existingData,
            source: existingData.source ?? "meeting-bot",
            provider: provider.id,
            external_id: event.externalId,
            recording_url: state.recordingUrl,
            meeting_url: state.meetingUrl || botRow.meeting_url,
            started_at: state.botJoinedAt,
            ended_at: state.callEndedAt,
            duration_s: state.durationSec,
            participants: state.participants,
            transcript_md: content,
            refine_status: "pending",
            refine_error: null,
            // Clear the lock — transcript is here, the UI should switch
            // from the "Recording in progress" placeholder to the editor.
            recording_status: null,
            recording_ended_at: new Date().toISOString(),
          },
        });
        targetNodeId = existing.id;
        attached = true;
      } else {
        // The attach target was deleted between scheduling and transcript
        // arrival — fall back to creating a fresh node so we don't drop
        // the transcript on the floor.
        log.warn("meeting_bot.webhook.attach_target_missing", {
          workspace_id: botRow.workspace_id,
          attach_node_id: botRow.transcript_node_id,
        });
        const node = await storage.createNode({
          title: fallbackTitle,
          kind: "meeting",
          parent_id: null,
          content_md: content,
          data: {
            source: "meeting-bot",
            provider: provider.id,
            external_id: event.externalId,
            recording_url: state.recordingUrl,
            meeting_url: state.meetingUrl || botRow.meeting_url,
            started_at: state.botJoinedAt,
            ended_at: state.callEndedAt,
            duration_s: state.durationSec,
            participants: state.participants,
            transcript_md: content,
            refine_status: "pending",
          },
        });
        targetNodeId = node.id;
      }
    } else {
      // Default path: materialize a new meeting node.
      const node = await storage.createNode({
        title: fallbackTitle,
        kind: "meeting",
        parent_id: null,
        content_md: content,
        data: {
          source: "meeting-bot",
          provider: provider.id,
          external_id: event.externalId,
          recording_url: state.recordingUrl,
          meeting_url: state.meetingUrl || botRow.meeting_url,
          started_at: state.botJoinedAt,
          ended_at: state.callEndedAt,
          duration_s: state.durationSec,
          participants: state.participants,
          transcript_md: content,
          refine_status: "pending",
        },
      });
      targetNodeId = node.id;
    }

    // Meter recorded minutes twice: the workspace counter is the per-project
    // breakdown, the organization counter says who recorded them. Both are
    // best-effort and neither blocks the transcript write — the recording
    // already happened.
    if (typeof state.durationSec === "number" && state.durationSec > 0) {
      const minutes = Math.ceil(state.durationSec / 60);
      void addMeetingMinutes(botRow.workspace_id, minutes).catch(() => {});
      void recordUsage(
        storage.workspace.organization_id,
        botRow.created_by,
        "meeting_minutes",
        minutes,
      );
    }

    // Pull the title from the target (the manually-attached node keeps
    // its existing title) so the refine prompt header matches what the
    // user sees.
    const refineTitle =
      (await storage.getNode(targetNodeId))?.title ?? fallbackTitle;

    // Realtime fan-out so the meeting node lands in collaborators' trees the
    // moment the transcript arrives — a new node when we materialized one, or
    // an update when we filled in a pre-attached placeholder.
    if (attached) {
      void wsBroadcast.nodeUpdated(botRow.workspace_id, targetNodeId);
    } else {
      void wsBroadcast.nodeCreated(botRow.workspace_id, targetNodeId);
    }

    void kickoffRefineJob({
      workspaceId: botRow.workspace_id,
      nodeId: targetNodeId,
      transcriptMd: content,
      title: refineTitle,
      participants: state.participants,
      durationSec: state.durationSec,
    });

    await sb
      .from("meeting_bots")
      .update({
        status: "done" as MeetingBotStatus,
        transcript_node_id: targetNodeId,
        recording_url: state.recordingUrl,
        bot_joined_at: state.botJoinedAt,
        call_ended_at: state.callEndedAt,
      })
      .eq("id", botRow.id);

    void broadcastMeetingBotStatus(botRow.workspace_id, {
      botId: botRow.id,
      externalId: event.externalId,
      status: "done",
      nodeId: targetNodeId,
    });

    return Response.json({
      ok: true,
      status: "done",
      nodeId: targetNodeId,
      attached,
    });
  }

  return Response.json({ ok: true });
});

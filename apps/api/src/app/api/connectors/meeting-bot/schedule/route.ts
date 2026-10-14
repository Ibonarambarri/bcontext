/**
 * POST /api/connectors/meeting-bot/schedule
 *
 * Drop a meeting bot into a Zoom / Meet / Teams / Webex call.
 *
 * Body:
 *   {
 *     "workspace": "<slug>",          // required
 *     "meetingUrl": "https://...",    // required, validated as URL
 *     "joinAt": "2026-06-12T10:00Z",  // optional; default = join now
 *     "botName": "Bcontext recorder", // optional
 *     "parentId": "<node-uuid>",      // optional — where the meeting node lands
 *     "consent": true                 // required: caller acknowledges recording
 *   }
 *
 * Returns the `meeting_bots` row id and the provider's initial status so
 * the UI can subscribe to the realtime channel for live updates.
 */
import { z } from "zod";
import { actingUserId, gate, requireWorkspaceMember } from "@/lib/auth/require";
import { getStorage } from "@/lib/storage";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";
import { getMeetingBotProvider } from "@/lib/connectors/meeting-bot";
import { broadcastMeetingBotStatus } from "@/lib/connectors/meeting-bot/realtime";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

const Schema = z.object({
  workspace: z.string().min(1),
  meetingUrl: z.string().url(),
  joinAt: z.string().datetime().optional(),
  botName: z.string().min(1).max(80).optional(),
  parentId: z.string().uuid().nullable().optional(),
  /**
   * Optional: attach the resulting transcript to an existing meeting node
   * (created manually) instead of materializing a new one. When set, the
   * webhook handler updates this node on transcript_ready.
   */
  attachToNodeId: z.string().uuid().optional(),
  consent: z.literal(true, {
    errorMap: () => ({
      message:
        "consent acknowledgement required — caller must confirm recording disclosure",
    }),
  }),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req, "agents:write");
  if (gated instanceof Response) return gated;

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

  // `<org>/<workspace>`: a bare slug names as many workspaces as there are
  // organizations that chose it, so it is refused rather than guessed.
  const storage = await getStorage(input.workspace);
  if (!storage) {
    return Response.json(
      {
        error: `workspace "${input.workspace}" not found`,
        message: 'Name the workspace as "<organization>/<workspace>".',
      },
      { status: 404 },
    );
  }
  const denied = await requireWorkspaceMember(gated, storage);
  if (denied) return denied;

  // Meeting bots only run against real Supabase — the demo backend doesn't
  // persist the bot row. Surface this explicitly so demo-mode UI can show
  // an informative state instead of silently dropping the request.
  if (storage.backend !== "supabase") {
    return Response.json(
      {
        error: "demo_storage_unsupported",
        message:
          "meeting bot requires Supabase storage (configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)",
      },
      { status: 503 },
    );
  }

  const provider = getMeetingBotProvider();

  let scheduled;
  try {
    scheduled = await provider.scheduleBot({
      meetingUrl: input.meetingUrl,
      joinAt: input.joinAt ?? null,
      botName: input.botName,
      workspaceId: storage.workspace.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("meeting_bot.schedule.failed", {
      workspace_id: storage.workspace.id,
      error: message,
    });
    return Response.json(
      { error: "provider_error", message },
      { status: 502 },
    );
  }

  const sb = getSupabaseAdmin();
  // If the caller wants to attach the transcript to an existing meeting
  // node, verify the node exists + belongs to this workspace, then pin
  // it as `transcript_node_id` so the webhook handler updates that node
  // instead of creating a new one.
  let attachToNodeId: string | null = null;
  if (input.attachToNodeId) {
    const { data: target } = await sb
      .from("nodes")
      .select("id, workspace_id, kind")
      .eq("id", input.attachToNodeId)
      .maybeSingle();
    if (!target || target.workspace_id !== storage.workspace.id) {
      return Response.json(
        { error: "attach_node_not_found", attachToNodeId: input.attachToNodeId },
        { status: 404 },
      );
    }
    if (target.kind !== "meeting") {
      return Response.json(
        {
          error: "attach_node_wrong_kind",
          message: "attachToNodeId must reference a node of kind=meeting",
        },
        { status: 400 },
      );
    }
    attachToNodeId = target.id as string;
  }

  const { data: row, error } = await sb
    .from("meeting_bots")
    .insert({
      workspace_id: storage.workspace.id,
      provider: provider.id,
      external_id: scheduled.externalId,
      status: scheduled.status,
      meeting_url: input.meetingUrl,
      scheduled_join_at: scheduled.scheduledJoinAt ?? input.joinAt ?? null,
      transcript_node_id: attachToNodeId,
      // Whom the minutes belong to. The provider's webhook is where they are
      // finally counted and it has no session, so the decision to spend them
      // is recorded here, where there is still somebody making it.
      created_by: actingUserId(gated),
    })
    .select("id, status")
    .single();

  if (error || !row) {
    // The bot is already scheduled at the provider; surface that so the
    // UI doesn't show a green checkmark on a half-baked state.
    log.error("meeting_bot.insert.failed", {
      workspace_id: storage.workspace.id,
      external_id: scheduled.externalId,
      error: error?.message,
    });
    return Response.json(
      {
        error: "persist_failed",
        message: error?.message ?? "could not store bot row",
        externalId: scheduled.externalId,
      },
      { status: 500 },
    );
  }

  // If we attached to a pre-existing node, mark it locked so the UI
  // renders the "Recording in progress" placeholder. The webhook handler
  // clears `recording_status` when the transcript lands.
  if (attachToNodeId) {
    const { data: nodeRow } = await sb
      .from("nodes")
      .select("data")
      .eq("id", attachToNodeId)
      .maybeSingle();
    const existingData = (nodeRow?.data ?? {}) as Record<string, unknown>;
    await sb
      .from("nodes")
      .update({
        data: {
          ...existingData,
          recording_status: "recording",
          recording_started_at: new Date().toISOString(),
          recording_bot_id: row.id,
        },
      })
      .eq("id", attachToNodeId);
    // Tell every tab that this node changed so the locked "Recording in
    // progress" view replaces the empty editor without a manual reload.
    void wsBroadcast.nodeUpdated(storage.workspace.id, attachToNodeId);
  }

  void broadcastMeetingBotStatus(storage.workspace.id, {
    botId: row.id,
    externalId: scheduled.externalId,
    status: scheduled.status,
  });

  return Response.json(
    {
      botId: row.id,
      externalId: scheduled.externalId,
      status: scheduled.status,
      parentId: input.parentId ?? null,
    },
    { status: 200 },
  );
});

/**
 * Thin wrapper over `broadcastWorkspace` for meeting-bot lifecycle events.
 *
 * Emitted from:
 *   - /api/connectors/meeting-bot/schedule        (initial status)
 *   - /api/connectors/meeting-bot/webhook         (every status change +
 *                                                  transcript_ready → done)
 *
 * UI tabs subscribe to `meeting_bot.status` via `useWorkspaceBroadcast`
 * and update the row in the modal / dashboard tile. Best-effort: a
 * Realtime hiccup must never block the underlying mutation.
 */
import { broadcastWorkspace } from "@/lib/collab/server-broadcast";
import type { MeetingBotStatus } from "@bcontext-dev/contract/connectors/meeting-bot/provider";

export interface MeetingBotStatusEvent {
  botId: string;
  externalId: string;
  status: MeetingBotStatus;
  /** Set when `status === "done"` and the meeting node has been created. */
  nodeId?: string;
  errorMessage?: string | null;
}

export async function broadcastMeetingBotStatus(
  workspaceId: string,
  event: MeetingBotStatusEvent,
): Promise<void> {
  await broadcastWorkspace(workspaceId, {
    kind: "meeting_bot.status",
    payload: event,
  });
}

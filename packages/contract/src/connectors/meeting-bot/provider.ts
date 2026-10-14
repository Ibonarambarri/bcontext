/**
 * MeetingBotProvider — vendor-agnostic interface for the meeting-bot
 * connector (`src/lib/connectors/meeting-bot` in the API).
 *
 * The point of this interface is that swapping providers (Recall → Meeting
 * BaaS → self-hosted Attendee) stays a ~200-line change instead of a
 * refactor. Routes only talk to this surface; vendors live behind it.
 *
 * Provider responsibilities:
 *   • scheduleBot   — drop a bot into a Zoom/Meet/Teams/Webex URL,
 *                     returning a stable external_id.
 *   • getMeeting    — fetch current state of a bot (status, transcript,
 *                     recording URL) by external_id.
 *   • cancelBot     — pull the bot out of the call (best-effort).
 *   • verifyWebhook — verify a webhook envelope and return a normalized
 *                     event for the route to dispatch on. Throws
 *                     ConnectorSignatureError on invalid signatures.
 */
import type { WebhookEnvelope } from "../types.js";

export type MeetingBotStatus =
  | "scheduled"
  | "joining"
  | "in_call"
  | "call_ended"
  | "transcribing"
  | "done"
  | "failed"
  | "cancelled";

export interface ScheduleBotInput {
  /** The Zoom/Meet/Teams/Webex URL the bot should join. */
  meetingUrl: string;
  /** ISO timestamp the bot should join. Omitted = join now. */
  joinAt?: string | null;
  /** Display name the bot shows in-call. Defaults per provider. */
  botName?: string;
  /** Workspace this bot belongs to — passed through to webhook metadata. */
  workspaceId: string;
}

export interface ScheduleBotResult {
  /** Provider-side bot id. Stable for webhook idempotency. */
  externalId: string;
  /** Initial status reported by the provider after the schedule call. */
  status: MeetingBotStatus;
  /** When the bot is scheduled to join, echoed by the provider. */
  scheduledJoinAt: string | null;
}

export interface TranscriptSegment {
  /** Speaker label as reported by the provider (e.g. "Speaker 1", "Alice"). */
  speaker: string;
  /** Plain-text utterance for this segment. */
  text: string;
  /** Seconds from call start. */
  startSec: number;
  endSec: number;
}

export interface MeetingState {
  externalId: string;
  status: MeetingBotStatus;
  meetingUrl: string;
  /** Human-readable title (provider may infer from calendar event). */
  topic: string | null;
  botJoinedAt: string | null;
  callEndedAt: string | null;
  durationSec: number | null;
  participants: string[];
  /** Signed URL of the recording. Short-lived per provider semantics. */
  recordingUrl: string | null;
  transcript: TranscriptSegment[] | null;
  errorMessage: string | null;
}

export type MeetingBotEventKind =
  | "status_change"
  | "transcript_ready"
  | "ignored";

export interface MeetingBotEvent {
  /** Normalized event type the route dispatches on. */
  kind: MeetingBotEventKind;
  /** Bot the event refers to. */
  externalId: string;
  /** New status if this event implies one. */
  status?: MeetingBotStatus;
  /** Provider-specific raw payload for the audit log. */
  raw: Record<string, unknown>;
}

export interface MeetingBotProvider {
  id: "recall" | "meeting-baas" | "attendee";

  scheduleBot(input: ScheduleBotInput): Promise<ScheduleBotResult>;

  getMeeting(externalId: string): Promise<MeetingState>;

  cancelBot(externalId: string): Promise<void>;

  /**
   * Verify the webhook signature and parse the body into a normalized event.
   * Implementations MUST throw ConnectorSignatureError on bad signatures
   * before returning anything.
   */
  verifyWebhook(envelope: WebhookEnvelope): Promise<MeetingBotEvent>;
}

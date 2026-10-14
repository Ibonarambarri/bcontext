/**
 * Meeting-bot connector entry point (Recall.ai bots that join calls and
 * hand back a diarized transcript).
 *
 * Unlike github/slack/linear/notion, the meeting-bot is event-driven only
 * — there's no "full sync" of all past meetings and no install row to
 * upsert per workspace (the same Recall API key can serve every workspace
 * on a self-hosted Bcontext, and per-workspace Vault keys are a follow-up).
 *
 * For that reason this connector exposes the `MeetingBotProvider`
 * interface directly rather than registering against the `Connector`
 * registry. Routes call `getMeetingBotProvider()` to dispatch.
 */
import { recallProvider } from "./recall";
import type { MeetingBotProvider } from "@bcontext-dev/contract/connectors/meeting-bot/provider";

export type MeetingBotProviderId = MeetingBotProvider["id"];

const providers = new Map<MeetingBotProviderId, MeetingBotProvider>([
  ["recall", recallProvider],
]);

/**
 * Resolve the active provider. Defaults to Recall.ai (v1 choice). Override
 * via MEETING_BOT_PROVIDER env so future swaps (Meeting BaaS, Attendee)
 * don't require a deploy.
 */
export function getMeetingBotProvider(
  id?: MeetingBotProviderId,
): MeetingBotProvider {
  const selected = (id ?? (process.env.MEETING_BOT_PROVIDER as MeetingBotProviderId | undefined) ?? "recall") as MeetingBotProviderId;
  const p = providers.get(selected);
  if (!p) throw new Error(`unknown meeting-bot provider: ${selected}`);
  return p;
}

export { recallProvider, verifyRecallSignature } from "./recall";
export { transcriptToMarkdown, formatTimestamp } from "./transcript-to-markdown";
export type {
  MeetingBotEvent,
  MeetingBotEventKind,
  MeetingBotProvider,
  MeetingBotStatus,
  MeetingState,
  ScheduleBotInput,
  ScheduleBotResult,
  TranscriptSegment,
} from "@bcontext-dev/contract/connectors/meeting-bot/provider";

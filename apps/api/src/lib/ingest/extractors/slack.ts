/**
 * Slack thread decision capture -> ingest candidate.
 *
 * Triggered only by an explicit high-precision marker (a dedicated
 * reaction, distinct from the `:bcontext:` pointer pin — see
 * `DECISION_REACTION` in `../../connectors/slack`), never by ordinary
 * messages: this is intentionally narrow, not a firehose. The connector
 * fetches the reacted-to thread's messages and hands this module the raw
 * text; `extractCandidate` classifies it and this proposes a candidate via
 * the generic ingest pipeline (`proposeCandidate`) — nothing here touches
 * the graph directly.
 *
 * Kind is forced to `decision` rather than trusting the classifier's
 * output: the marker itself is the decision-capture signal, so a thread
 * that the model scores as e.g. "task" should still land in the decision
 * inbox for a human to recharacterize on review, not silently route
 * elsewhere.
 */
import { extractCandidate } from "@/lib/ingest/extract";
import { proposeCandidate } from "@/lib/ingest/candidates";
import { log } from "@bcontext-dev/contract/log";

export interface SlackThreadMessage {
  user?: string;
  text?: string;
  ts: string;
}

/**
 * Speaker-attributed by user id (no per-message `users.info` lookup — that
 * would be one API call per participant for a feature this narrow).
 */
export function buildThreadRawText(messages: SlackThreadMessage[]): string {
  return messages
    .map((m) => `<@${m.user ?? "unknown"}>: ${m.text ?? ""}`)
    .join("\n");
}

/** Unique Slack user ids in the thread, in first-appearance order (stored as provenance). */
export function distinctParticipants(messages: SlackThreadMessage[]): string[] {
  return Array.from(
    new Set(messages.map((m) => m.user).filter((u): u is string => !!u)),
  );
}

export interface ProposeSlackDecisionCandidateInput {
  workspaceId: string;
  channel: string;
  threadTs: string;
  messages: SlackThreadMessage[];
  /** Best-effort; null when `chat.getPermalink` failed or was unavailable. */
  permalink: string | null;
}

/** Thread → `decision` candidate; an extraction failure is logged and proposes nothing. */
export async function proposeSlackDecisionCandidate(
  input: ProposeSlackDecisionCandidateInput,
): Promise<void> {
  const { workspaceId, channel, threadTs, messages, permalink } = input;
  const rawText = buildThreadRawText(messages);
  const participants = distinctParticipants(messages);

  let extracted;
  try {
    extracted = await extractCandidate({
      workspaceId,
      rawText,
      sourceHint: "slack:thread",
    });
  } catch (err) {
    log.warn("ingest.slack.extract_failed", {
      workspace_id: workspaceId,
      channel,
      thread_ts: threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  await proposeCandidate({
    workspaceId,
    source: "slack",
    externalId: `thread:${channel}:${threadTs}`,
    kind: "decision",
    title: extracted.title,
    contentMd: extracted.contentMd,
    confidence: extracted.confidence,
    triage: true,
    provenance: { channel, thread_ts: threadTs, permalink, participants },
  });
}

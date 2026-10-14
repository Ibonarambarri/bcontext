/**
 * Where a routed inbound message lands: the owning Nexo's per-thread window
 * (flushed later, as one block, by `./flush`), plus — for a message addressed
 * to the bot on a `listen_reply` binding — a fast `nexos.run` so the Nexo can
 * answer in seconds instead of after the quiet period.
 *
 * Callers: `./slack-inbound` (webhook) and the Nango connector drain, after
 * `routeInbound` said which Nexo owns the message.
 *
 * Must not break:
 *   - One source key per thread (`slack:<team>:<channel>:<thread_ts|ts>`):
 *     replies join their root's window, so a thread is digested as a whole.
 *   - The fast run is debounced: singletonKey per Nexo + thread on a
 *     `stately` queue, ~2 s start delay, so a burst of mentions is one turn.
 *     The run job reads the window when it starts, not the message that
 *     enqueued it, so the turn sees the whole burst.
 */
import { enqueue } from "@/lib/queue/producers";
import { QUEUE_NEXOS_RUN } from "@/lib/queue/queues";
import { appendWindowEvent } from "../store";
import type { NexoTarget, NexoWindow } from "../types";
import { isDirectToBot, type BotIdentity, type InboundMessage, type RouteDecision } from "./routing";

/** Seconds a fast run waits so a burst of mentions collapses into one turn. */
export const FAST_RUN_DELAY_SECONDS = 2;

/** Thread identity for windows. Replies carry their root's `thread_ts`. */
export function slackSourceKey(teamId: string, channel: string, ts: string, threadTs?: string | null): string {
  return `slack:${teamId}:${channel}:${threadTs || ts}`;
}

/** Payload of a fast event run, read back by `./run-job`. */
export interface FastRunPayload {
  nexo_id: string;
  workspace_id: string;
  trigger: "event";
  source_key: string;
  connector_id: string;
  install_id: string;
  channel: string;
  thread_ts: string;
}

export interface AcceptResult {
  window: NexoWindow;
  fastRun: boolean;
}

/**
 * Append the message to its window and, when it calls for it, enqueue the
 * fast turn. `decision` must be a `nexo` decision from `routeInbound`.
 */
export async function acceptInbound(
  t: NexoTarget,
  msg: InboundMessage,
  decision: Extract<RouteDecision, { kind: "nexo" }>,
  opts: { bot: BotIdentity; enqueueRun?: typeof enqueue },
): Promise<AcceptResult> {
  const threadTs = msg.threadTs || msg.ts;
  const sourceKey = slackSourceKey(msg.teamId, msg.channel, msg.ts, msg.threadTs);
  const window = await appendWindowEvent(t, {
    nexoId: decision.nexo.id,
    bindingId: decision.binding?.id ?? null,
    sourceKey,
    event: {
      ts: msg.ts,
      author: msg.user ?? msg.botId ?? "unknown",
      text: msg.text,
      channel: msg.channel,
      thread_ts: threadTs,
      connector_id: msg.connectorId,
      install_id: msg.installId,
    },
  });

  const wantsFastRun = decision.binding?.mode === "listen_reply" && isDirectToBot(msg, opts.bot);
  if (!wantsFastRun) return { window, fastRun: false };

  const payload: FastRunPayload = {
    nexo_id: decision.nexo.id,
    workspace_id: t.workspaceId,
    trigger: "event",
    source_key: sourceKey,
    connector_id: msg.connectorId,
    install_id: msg.installId,
    channel: msg.channel,
    thread_ts: threadTs,
  };
  await (opts.enqueueRun ?? enqueue)(QUEUE_NEXOS_RUN, { ...payload }, {
    singletonKey: `event:${decision.nexo.id}:${sourceKey}`,
    startAfter: FAST_RUN_DELAY_SECONDS,
  });
  return { window, fastRun: true };
}

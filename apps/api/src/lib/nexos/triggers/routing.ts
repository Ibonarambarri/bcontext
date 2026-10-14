/**
 * Inbound message → which Nexo hears it. One pure-ish decision shared by the
 * first-party Slack webhook and the Nango Slack drain, so "who owns this
 * channel" has one answer everywhere.
 *
 * Callers: `./slack-inbound` (Events API webhook) and the Nango connector's
 * `fullSync` (`src/lib/connectors/nango`), both through `routeInbound`.
 *
 * Rules, in order:
 *   1. Our own bot's messages are dropped (loop guard: a Nexo replying in a
 *      channel it listens to must not hear itself and answer again).
 *   2. A binding on the install for `channel:<id>`, then `*`, names the
 *      owner. An active owner takes the message and the channel is "owned":
 *      its window flush becomes the ingestion path, and the legacy
 *      per-message capture for that channel is skipped by the caller.
 *      A paused owner yields: the legacy path keeps ingesting, so pausing a
 *      Nexo never silently stops the brain from learning.
 *   3. Unbound: the general Nexo hears it, but ONLY if the legacy path
 *      already ingests that channel (install allowlist). The general Nexo
 *      never widens what Bcontext reads.
 *
 * Must not break: never throws for a routing miss — a "no" is a decision,
 * and callers fail open (legacy ingestion) on any error.
 */
import type { NexoBinding } from "@bcontext-dev/contract/nexos";
import { channelScopeKey, findBindingForEvent, getGeneralNexo, getNexo } from "../store";
import type { Nexo, NexoTarget } from "../types";

/** One message as the Nexo triggers see it, whichever transport brought it. */
export interface InboundMessage {
  connectorId: string;
  installId: string;
  /** Slack team id (or the install id when the transport does not carry it). */
  teamId: string;
  channel: string;
  /** Slack `channel_type` (`channel`, `group`, `im`…) when known. */
  channelType?: string | null;
  ts: string;
  threadTs?: string | null;
  user?: string | null;
  botId?: string | null;
  subtype?: string | null;
  text: string;
  /** The transport already knows this message addresses the bot (e.g. `app_mention`). */
  mentionsBot?: boolean;
}

/** Who "our bot" is on this install. Either field may be unknown on older installs. */
export interface BotIdentity {
  userId?: string | null;
  botId?: string | null;
}

export type RouteDecision =
  | { kind: "nexo"; nexo: Nexo; binding: NexoBinding | null; ownsChannel: boolean }
  | { kind: "ignore"; reason: string; ownsChannel: boolean };

/** Subtypes that are real human speech; everything else (edits, joins, bots) is noise. */
const SPOKEN_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

/**
 * Our bot authored it. With no identity recorded (installs made before the
 * callback stored `bot_user_id`), any bot message counts as ours: answering
 * another bot is a small loss, an infinite reply loop is not.
 */
export function isOwnBotMessage(msg: Pick<InboundMessage, "user" | "botId" | "subtype">, bot: BotIdentity): boolean {
  if (bot.userId && msg.user === bot.userId) return true;
  if (bot.botId && msg.botId === bot.botId) return true;
  if (!bot.userId && !bot.botId && (msg.botId || msg.subtype === "bot_message")) return true;
  return false;
}

/** Addressed to the bot: a DM, an `app_mention`, or `<@BOT>` in the text. */
export function isDirectToBot(msg: InboundMessage, bot: BotIdentity): boolean {
  if (msg.mentionsBot) return true;
  if (msg.channelType === "im") return true;
  return !!bot.userId && msg.text.includes(`<@${bot.userId}>`);
}

/**
 * Whether the legacy path ingests this channel today: the install's
 * `config.channels` allowlist when there is one, every channel the bot can
 * see otherwise — the same test the Slack connector applies.
 */
export function isLegacyIngested(config: Record<string, unknown>, channel: string): boolean {
  const allow = config.channels;
  if (!Array.isArray(allow)) return true;
  return allow.some((c) => c === channel);
}

export async function routeInbound(
  t: NexoTarget,
  msg: InboundMessage,
  opts: { installConfig: Record<string, unknown>; bot: BotIdentity },
): Promise<RouteDecision> {
  if (isOwnBotMessage(msg, opts.bot)) return { kind: "ignore", reason: "own_bot", ownsChannel: false };
  if (msg.subtype && !SPOKEN_SUBTYPES.has(msg.subtype)) {
    return { kind: "ignore", reason: "subtype", ownsChannel: false };
  }
  if (!msg.text.trim()) return { kind: "ignore", reason: "empty", ownsChannel: false };

  const binding = await findBindingForEvent(t, msg.installId, [channelScopeKey(msg.channel), "*"]);
  if (binding) {
    const nexo = await getNexo(t, binding.nexo_id);
    if (nexo && nexo.status === "active") return { kind: "nexo", nexo, binding, ownsChannel: true };
    return { kind: "ignore", reason: nexo ? "owner_paused" : "owner_missing", ownsChannel: false };
  }

  if (!isLegacyIngested(opts.installConfig, msg.channel)) {
    return { kind: "ignore", reason: "not_ingested", ownsChannel: false };
  }
  const general = await getGeneralNexo(t);
  if (!general || general.status !== "active") return { kind: "ignore", reason: "no_general", ownsChannel: false };
  return { kind: "nexo", nexo: general, binding: null, ownsChannel: false };
}

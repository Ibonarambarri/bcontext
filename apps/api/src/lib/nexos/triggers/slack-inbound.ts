/**
 * First-party Slack Events API → Nexos. The webhook route calls this after
 * the connector verified the signature and produced its legacy outcome; it
 * routes the message to its Nexo (window + optional fast turn) and says
 * whether a Nexo owns the channel, so the route can drop the legacy
 * per-message node for it.
 *
 * Callers: `POST /api/webhooks/slack` only.
 *
 * Must not break:
 *   - Runs strictly after signature verification (the route's order).
 *   - Fail-open: any error is logged and reported as "not owned", so the
 *     legacy capture keeps the message — a duplicate is recoverable, a lost
 *     message is not.
 *   - Only `msg:` nodes of an owned channel are dropped; reaction pins and
 *     📌 decision capture are explicit human actions and always go through.
 */
import { log } from "@bcontext-dev/contract/log";
import type { ContextNodeInput } from "@bcontext-dev/contract/connectors/types";
import type { StorageBackend } from "@/lib/storage";
import type { NexoTarget } from "../types";
import { routeInbound, type BotIdentity, type InboundMessage } from "./routing";
import { acceptInbound } from "./windows";

export interface SlackInstallRef {
  id: string;
  workspace_id: string;
  config: Record<string, unknown>;
}

interface SlackEventPayload {
  type?: string;
  team_id?: string;
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
  event?: {
    type?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
  };
}

export interface SlackNexoOutcome {
  /** Channel whose legacy per-message capture must be skipped, if any. */
  ownedChannel: string | null;
  outcome: string;
}

/** Our bot on this install: recorded by the OAuth callback, else Slack's `authorizations` block. */
export function slackBotIdentity(config: Record<string, unknown>, payload?: SlackEventPayload): BotIdentity {
  const fromAuth = payload?.authorizations?.find((a) => a.is_bot)?.user_id ?? null;
  return {
    userId: typeof config.bot_user_id === "string" ? config.bot_user_id : fromAuth,
    botId: typeof config.bot_id === "string" ? config.bot_id : null,
  };
}

export async function routeSlackEventToNexos(
  install: SlackInstallRef,
  rawBody: string,
  opts: { backend?: StorageBackend } = {},
): Promise<SlackNexoOutcome> {
  try {
    const payload = JSON.parse(rawBody) as SlackEventPayload;
    const event = payload.event;
    if (payload.type !== "event_callback" || !event || event.type !== "message") {
      return { ownedChannel: null, outcome: "not_a_message" };
    }
    if (!event.channel || !event.ts) return { ownedChannel: null, outcome: "incomplete" };

    const msg: InboundMessage = {
      connectorId: "slack",
      installId: install.id,
      teamId: payload.team_id ?? (typeof install.config.team_id === "string" ? install.config.team_id : install.id),
      channel: event.channel,
      channelType: event.channel_type ?? null,
      ts: event.ts,
      threadTs: event.thread_ts ?? null,
      user: event.user ?? null,
      botId: event.bot_id ?? null,
      subtype: event.subtype ?? null,
      text: event.text ?? "",
    };
    const t: NexoTarget = { workspaceId: install.workspace_id, backend: opts.backend ?? "supabase" };
    const bot = slackBotIdentity(install.config, payload);
    const decision = await routeInbound(t, msg, { installConfig: install.config, bot });
    const ownedChannel = decision.ownsChannel ? msg.channel : null;
    if (decision.kind === "ignore") return { ownedChannel, outcome: `ignored:${decision.reason}` };

    const accepted = await acceptInbound(t, msg, decision, { bot });
    return { ownedChannel, outcome: accepted.fastRun ? "windowed+fast_run" : "windowed" };
  } catch (err) {
    log.warn("nexos.slack_inbound.failed", {
      workspace_id: install.workspace_id,
      install_id: install.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ownedChannel: null, outcome: "error" };
  }
}

/**
 * The legacy outcome minus the per-message nodes of a Nexo-owned channel.
 * That channel's messages reach the brain through the Nexo's window flush.
 */
export function dropOwnedMessageNodes(nodes: ContextNodeInput[], ownedChannel: string | null): ContextNodeInput[] {
  if (!ownedChannel) return nodes;
  return nodes.filter((n) => !(n.external_id.startsWith(`msg:${ownedChannel}:`)));
}

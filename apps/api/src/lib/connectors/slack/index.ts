/**
 * Slack connector (first-party Slack app — not through Nango) with
 * reaction-driven decision capture.
 *
 * Install flow: OAuth v2 against `slack.com/oauth/v2/authorize` with
 *   scopes `channels:history,users:read,groups:history,commands,reactions:read,channels:read,chat:write,chat:write.customize`.
 *   No `im:*` / `mpim:*` scopes — DMs are off-limits by default. The
 *   `commands` scope is for `/bcontext search …`. `channels:read` is needed
 *   for the `chat.getPermalink` call of decision capture. `chat:write` lets a
 *   Nexo reply in the channels it owns (`src/lib/nexos/outbound.ts`) and
 *   `chat:write.customize` lets that reply carry the Nexo's name. Installs
 *   made before a scope was added need to re-consent (docs/integrations-nango.md).
 *
 * Webhook flow: Slack Events API + slash commands hit
 *   `/api/webhooks/slack`. Signature verified per Slack's `v0` HMAC
 *   scheme (timestamp + body, signed with the app's signing secret).
 *
 * Mapping rules per spec:
 *   - Thread roots in allowlisted channels → `doc` nodes.
 *   - Replies → child nodes of the root.
 *   - `:bcontext:` reaction → manual pin (becomes a `doc` node).
 *   - `DECISION_REACTION` (e.g. 📌) → high-precision decision
 *     capture: fetch the reacted-to thread via `conversations.replies`,
 *     classify it, and propose a `decision` ingest candidate (never a
 *     direct node write — reviewed via the ingest inbox like any other
 *     candidate). Distinct from `:bcontext:`, which stays the lightweight
 *     manual pointer pin and never touches the ingest pipeline.
 *   - `/bcontext search <q>` → ephemeral response with top-3 RAG hits.
 *
 * No DMs by default. Channel allowlist lives on `connector_installs.config.channels[]`.
 */
import { registerConnector } from "../registry";
import type {
  Connector,
  ConnectorContext,
  ContextNodeInput,
  WebhookEnvelope,
  WebhookOutcome,
} from "@bcontext-dev/contract/connectors/types";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import {
  proposeSlackDecisionCandidate,
  type SlackThreadMessage,
} from "@/lib/ingest/extractors/slack";
import { log } from "@bcontext-dev/contract/log";
import { appUrl as configuredAppUrl } from "@/lib/env";

/**
 * High-precision decision-capture marker (📌 arrives as reaction name
 * "pushpin"). Deliberately distinct from `:bcontext:` — the latter is a
 * generic "remember this" pointer pin, this one specifically triggers the
 * thread → decision-candidate pipeline. Never fires on ordinary
 * messages, only on this explicit reaction: no firehose.
 */
export const DECISION_REACTION = "pushpin";

interface SlackMessageEvent {
  type: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
}

interface SlackReactionEvent {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: { type: string; channel: string; ts: string };
}

const slackConnector: Connector = {
  id: "slack",

  async authorize(ctx, phase) {
    if (phase === "start") {
      const clientId = process.env.SLACK_CLIENT_ID;
      if (!clientId) return {};
      const scopes = [
        "channels:history",
        "groups:history",
        "users:read",
        "commands",
        "reactions:read",
        "channels:read",
        "chat:write",
        "chat:write.customize",
      ].join(",");
      const redirect = `${appUrl()}/api/connectors/slack/callback`;
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", scopes);
      url.searchParams.set("redirect_uri", redirect);
      url.searchParams.set("state", ctx.installId);
      return { redirectUrl: url.toString() };
    }
    return {};
  },

  async fullSync(_ctx) {
    // Slack history backfill is opt-in (channels can be huge). The
    // first version of the connector is event-driven only — webhook
    // events seed nodes going forward. Operators can call /api/connectors/slack/sync
    // explicitly when they want a one-shot backfill of allowlisted
    // channels; not implemented in this commit.
    return { processed: 0, byKind: {}, nodes: [], hasMore: false, cursor: null };
  },

  async handleWebhook(ctx, envelope: WebhookEnvelope): Promise<WebhookOutcome> {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) throw new ConnectorSignatureError("slack signing secret missing");
    const ok = await verifySlackSignature(signingSecret, envelope);
    if (!ok) throw new ConnectorSignatureError();

    // Slash commands arrive form-encoded.
    const contentType = envelope.headers["content-type"] ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Slash command path — emit no nodes; the route returns a JSON
      // body directly to Slack.
      return { nodes: [], audit: "slack.slash_command" };
    }

    const payload = JSON.parse(envelope.rawBody) as Record<string, unknown>;

    // URL verification handshake.
    if (payload.type === "url_verification") {
      return { nodes: [], audit: "slack.url_verification" };
    }

    if (payload.type === "event_callback") {
      const event = payload.event as SlackMessageEvent | SlackReactionEvent;
      const allowlist = (ctx.config.channels as string[] | undefined) ?? null;
      const nodes: ContextNodeInput[] = [];

      if (event.type === "message") {
        const msg = event as SlackMessageEvent;
        if (msg.subtype && msg.subtype !== "thread_broadcast") {
          // ignore bot_message, message_changed, etc.
          return { nodes, audit: "slack.message.subtype_ignored" };
        }
        if (allowlist && !allowlist.includes(msg.channel)) {
          return { nodes, audit: "slack.message.not_allowlisted" };
        }
        nodes.push(messageToNode(msg));
        return { nodes, audit: "slack.message" };
      }

      if (event.type === "reaction_added") {
        const rx = event as SlackReactionEvent;

        if (rx.reaction === DECISION_REACTION) {
          if (allowlist && !allowlist.includes(rx.item.channel)) {
            return { nodes, audit: "slack.reaction.not_allowlisted" };
          }
          const audit = await captureDecisionFromThread(ctx, rx);
          return { nodes, audit };
        }

        if (rx.reaction !== "bcontext") {
          return { nodes, audit: "slack.reaction.ignored" };
        }
        if (allowlist && !allowlist.includes(rx.item.channel)) {
          return { nodes, audit: "slack.reaction.not_allowlisted" };
        }
        // Pin: treat the parent message as a doc node. Without the
        // message text we just record the pointer; a follow-up fetch
        // hits Slack's conversations.history if a workspace bot token
        // is available.
        nodes.push({
          source: "slack",
          external_id: `pin:${rx.item.channel}:${rx.item.ts}`,
          kind: "doc",
          title: `Slack pin · #${rx.item.channel}`,
          content_md: `Pinned by <@${rx.user}> via :bcontext:\n\n(See Slack for full thread.)`,
          data: { channel: rx.item.channel, ts: rx.item.ts, pinned_by: rx.user },
        });
        return { nodes, audit: "slack.reaction.pinned" };
      }
    }

    return { nodes: [], audit: "slack.unhandled" };
  },

  toContextNode(_ctx, entity) {
    return messageToNode(entity as unknown as SlackMessageEvent);
  },
};

registerConnector(slackConnector);

function messageToNode(msg: SlackMessageEvent): ContextNodeInput {
  const isReply = !!msg.thread_ts && msg.thread_ts !== msg.ts;
  return {
    source: "slack",
    external_id: `msg:${msg.channel}:${msg.ts}`,
    kind: "doc",
    title: isReply
      ? `Slack reply · #${msg.channel}`
      : `Slack thread · #${msg.channel}`,
    content_md: msg.text ?? "",
    data: {
      channel: msg.channel,
      ts: msg.ts,
      thread_ts: msg.thread_ts ?? null,
      author: msg.user ?? null,
    },
  };
}

// -- Decision capture (📌 reaction → decision candidate) ---------------------

/**
 * Orchestrates the DECISION_REACTION path: fetch the thread, propose the
 * candidate, return an audit string. Never throws — a missing bot token or
 * a failed thread fetch is logged and skipped, matching the rest of this
 * connector's fail-open webhook handling (a candidate-proposal failure
 * must never break the surrounding `handleWebhook` call).
 */
async function captureDecisionFromThread(
  ctx: ConnectorContext,
  rx: SlackReactionEvent,
): Promise<string> {
  const token = ctx.secret;
  if (!token) {
    log.warn("slack.reaction.decision.no_bot_token", { channel: rx.item.channel });
    return "slack.reaction.decision_skipped_no_token";
  }

  const messages = await fetchThreadMessages(token, rx.item.channel, rx.item.ts);
  if (!messages || messages.length === 0) {
    log.warn("slack.reaction.decision.thread_fetch_failed", {
      channel: rx.item.channel,
      thread_ts: rx.item.ts,
    });
    return "slack.reaction.decision_skipped_no_thread";
  }

  // Permalink is supplementary provenance, not blocking: a failure here
  // still lets the candidate get proposed with `permalink: null`.
  const permalink = await fetchPermalink(token, rx.item.channel, rx.item.ts);

  await proposeSlackDecisionCandidate({
    workspaceId: ctx.workspaceId,
    channel: rx.item.channel,
    threadTs: rx.item.ts,
    messages,
    permalink,
  });
  return "slack.reaction.decision_captured";
}

/**
 * `conversations.replies` — https://api.slack.com/methods/conversations.replies
 * `ts` doubles as `thread_ts`: the reacted-to item's own timestamp, per
 * Slack's convention for both thread roots and replies.
 */
async function fetchThreadMessages(
  token: string,
  channel: string,
  threadTs: string,
): Promise<SlackThreadMessage[] | null> {
  try {
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channel);
    url.searchParams.set("ts", threadTs);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as {
      ok: boolean;
      messages?: SlackThreadMessage[];
      error?: string;
    };
    if (!json.ok || !json.messages || json.messages.length === 0) return null;
    return json.messages;
  } catch {
    return null;
  }
}

/**
 * `chat.getPermalink` — https://api.slack.com/methods/chat.getPermalink
 * Chosen over hand-constructing the `https://<team>.slack.com/archives/…`
 * form because the connector never stores the workspace's slack.com
 * subdomain (only `team_id`/`team_name` — see the OAuth callback), so an
 * API call is the only reliable way to get a working link. Best-effort:
 * failures return null rather than blocking candidate proposal.
 */
async function fetchPermalink(
  token: string,
  channel: string,
  ts: string,
): Promise<string | null> {
  try {
    const url = new URL("https://slack.com/api/chat.getPermalink");
    url.searchParams.set("channel", channel);
    url.searchParams.set("message_ts", ts);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as { ok: boolean; permalink?: string };
    return json.ok && json.permalink ? json.permalink : null;
  } catch {
    return null;
  }
}

// -- Signature verification (Slack v0 scheme) -------------------------------

export async function verifySlackSignature(
  signingSecret: string,
  envelope: WebhookEnvelope,
): Promise<boolean> {
  const ts = envelope.headers["x-slack-request-timestamp"];
  const sig = envelope.headers["x-slack-signature"];
  if (!ts || !sig) return false;
  // Reject events older than 5 minutes to mitigate replay.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const base = `v0:${ts}:${envelope.rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const out = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const hex = Array.from(new Uint8Array(out))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `v0=${hex}`;
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function appUrl(): string {
  return (
    configuredAppUrl() ?? "http://localhost:3000"
  );
}

export { slackConnector };

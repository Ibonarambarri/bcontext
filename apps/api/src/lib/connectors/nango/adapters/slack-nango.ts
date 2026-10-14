/**
 * Slack (via Nango) — `slack-nango` → Nango `slack` (OAuth2 v2 user/bot
 * token; proxy base https://slack.com/api).
 *
 * The Nango-backed twin of the native `slack` connector. Native keeps the
 * Events API webhooks (📌 decision capture, /bcontext search); this adapter
 * gives the cadence-driven daily batch: everything said in the channels the
 * token can read since the cursor.
 *
 *   GET /auth.test                    → workspace URL for permalinks
 *   GET /users.list?limit=200         → id → display name (≤2 pages)
 *   GET /conversations.list?types=public_channel,private_channel
 *       &exclude_archived=true&limit=200         (≤3 pages, `config.channels`)
 *   GET /conversations.history?channel&oldest=<epoch>&limit=200 (≤3 pages)
 *   GET /conversations.replies?channel&ts       for threads with replies
 *
 * Signals: one per thread (`thread:<channel>:<ts>`), and the loose messages
 * of a channel grouped per UTC day (`channel:<channel>:<day>`). Bot and
 * join/leave messages are skipped. Scopes requested at the placeholder
 * stage: channels:read, channels:history, groups:read, groups:history,
 * users:read, plus chat:write for Nexo replies (src/lib/nexos/outbound.ts).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, epochSeconds, type NangoAdapter } from "./shared";

interface SlackChannel {
  id: string;
  name?: string;
  is_archived?: boolean;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  reactions?: Array<{ name?: string; count?: number }>;
}

interface SlackEnvelope<T> {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  channels?: T[];
  members?: Array<{ id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string }; is_bot?: boolean; deleted?: boolean }>;
  messages?: SlackMessage[];
  url?: string;
}

const CHANNEL_PAGES = 3;
const HISTORY_PAGES = 3;
const CHANNELS_MAX = 25;
const THREAD_READS = 30;
const SKIPPED_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "bot_message", "channel_archive", "channel_unarchive", "group_join", "group_leave"]);

/** "1725000000.123456" → ISO. */
export function slackTsToIso(ts: string): string {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(Math.floor(n * 1000)).toISOString() : new Date(0).toISOString();
}

/** Permalink shape Slack uses: /archives/<channel>/p<ts without the dot>. */
export function slackPermalink(workspaceUrl: string, channel: string, ts: string): string | undefined {
  if (!workspaceUrl) return undefined;
  return `${workspaceUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
}

/** Replace <@U…> mentions and <url|label> links with readable text. */
export function slackText(raw: string, names: Map<string, string>): string {
  return raw
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_m, _id: string, name: string) => `#${name}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, (_m, _url: string, label: string) => label)
    .replace(/<([^>]+)>/g, (_m, url: string) => url)
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .trim();
}

export const slackNangoAdapter: NangoAdapter = {
  id: "slack-nango",
  provider: "slack",
  sourceHint: "slack:channels",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const call = async <T>(path: string, query: Record<string, string | number | boolean | undefined>) => {
      const res = await client.proxy<SlackEnvelope<T>>({ method: "GET", providerConfigKey: "slack-nango", connectionId, path, query });
      if (!res.ok || res.data?.ok === false) throw new Error(`slack ${path} failed (${res.status}${res.data?.error ? ` ${res.data.error}` : ""})`);
      return res.data ?? {};
    };
    const stats: Record<string, number> & { channels: number; messages: number; threads: number } = { channels: 0, messages: 0, threads: 0 };

    let workspaceUrl = "";
    try {
      workspaceUrl = (await call<never>("/auth.test", {})).url ?? "";
    } catch {
      stats.auth_test_failed = 1;
    }

    const names = new Map<string, string>();
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 2; page += 1) {
        const users = await call<never>("/users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
        for (const u of users.members ?? []) {
          const name = u.profile?.display_name || u.real_name || u.profile?.real_name || u.name;
          if (name) names.set(u.id, name);
        }
        cursor = users.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    } catch {
      stats.users_list_failed = 1;
    }

    const wanted = allowList(config, "channels");
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < CHANNEL_PAGES; page += 1) {
      const res = await call<SlackChannel>("/conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      channels.push(...(res.channels ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    const selected = channels
      .filter((c) => !wanted || wanted.includes(c.id) || (c.name ? wanted.includes(c.name) || wanted.includes(`#${c.name}`) : false))
      .slice(0, CHANNELS_MAX);
    stats.channels = selected.length;

    const signals: IngestSignal[] = [];
    const oldest = String(epochSeconds(since));
    const render = (m: SlackMessage) => {
      const who = m.user ? (names.get(m.user) ?? m.user) : (m.bot_id ?? "someone");
      const hhmm = slackTsToIso(m.ts).slice(11, 16);
      const reactions = m.reactions?.length ? ` (${m.reactions.map((r) => `:${r.name}: ${r.count ?? 1}`).join(" ")})` : "";
      return `[${hhmm}] ${who}: ${slackText(m.text ?? "", names)}${reactions}`;
    };

    for (const channel of selected) {
      if (signals.length >= limit) break;
      const label = channel.name ? `#${channel.name}` : channel.id;
      const messages: SlackMessage[] = [];
      let next: string | undefined;
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        const res = await call<never>("/conversations.history", { channel: channel.id, oldest, limit: 200, ...(next ? { cursor: next } : {}) });
        messages.push(...(res.messages ?? []));
        next = res.response_metadata?.next_cursor || undefined;
        if (!next) break;
      }
      const keep = messages.filter((m) => !m.bot_id && !(m.subtype && SKIPPED_SUBTYPES.has(m.subtype)) && (m.text ?? "").trim());
      stats.messages += keep.length;

      // Threads first: parent + replies as one signal.
      const loose: SlackMessage[] = [];
      for (const m of keep) {
        const isParent = (m.reply_count ?? 0) > 0 && (!m.thread_ts || m.thread_ts === m.ts);
        if (!isParent) {
          if (!m.thread_ts || m.thread_ts === m.ts) loose.push(m);
          continue;
        }
        let replies: SlackMessage[] = [];
        if (stats.threads < THREAD_READS) {
          try {
            const res = await call<never>("/conversations.replies", { channel: channel.id, ts: m.ts, limit: 100 });
            replies = (res.messages ?? []).filter((r) => r.ts !== m.ts && !r.bot_id && (r.text ?? "").trim());
          } catch {
            stats.replies_failed = (stats.replies_failed ?? 0) + 1;
          }
        }
        stats.threads += 1;
        const last = replies.length ? replies[replies.length - 1]!.ts : m.ts;
        signals.push({
          external_id: `thread:${channel.id}:${m.ts}`,
          title: `${label} · ${clip(slackText(m.text ?? "", names), 80).replace(/\n/g, " ")}`,
          text: clip([render(m), ...replies.map(render)].join("\n"), 20_000),
          url: slackPermalink(workspaceUrl, channel.id, m.ts),
          author: m.user ? (names.get(m.user) ?? m.user) : undefined,
          at: slackTsToIso(last),
          kind_hint: "thread",
        });
        if (signals.length >= limit) break;
      }

      // Loose messages grouped per UTC day.
      const byDay = new Map<string, SlackMessage[]>();
      for (const m of loose) {
        const day = slackTsToIso(m.ts).slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), m]);
      }
      for (const [day, list] of byDay) {
        if (signals.length >= limit) break;
        const sorted = [...list].sort((a, b) => Number(a.ts) - Number(b.ts));
        signals.push({
          external_id: `channel:${channel.id}:${day}`,
          title: `${label} · ${day}`,
          text: clip(sorted.map(render).join("\n"), 20_000),
          url: slackPermalink(workspaceUrl, channel.id, sorted[0]!.ts),
          at: slackTsToIso(sorted[sorted.length - 1]!.ts),
          kind_hint: "channel_day",
        });
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

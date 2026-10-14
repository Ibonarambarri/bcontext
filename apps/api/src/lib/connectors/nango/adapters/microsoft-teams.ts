/**
 * Microsoft Teams — `microsoft-teams` → Nango `microsoft-teams` (alias of
 * the `microsoft` OAuth2 provider; proxy base https://graph.microsoft.com).
 *
 * Channel messages modified since the cursor, with their replies, across
 * the teams the account has joined. Graph has no `$filter` on plain channel
 * messages, so the initial *delta* query is used with
 * `$filter=lastModifiedDateTime gt <since>` — that is the documented way
 * to get "messages changed after an instant" without holding a delta token.
 * System messages (member added, …) are skipped.
 *
 * Install config: `teams` (allow-list of team ids or display names),
 * `channels` (allow-list of channel ids or display names).
 * Scopes: ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { graphIdentity, graphWalk, odataSince } from "./graph";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface Team { id: string; displayName?: string }
interface Channel { id: string; displayName?: string; webUrl?: string }
interface ChatMessage {
  id: string;
  messageType?: string;
  subject?: string | null;
  summary?: string | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  deletedDateTime?: string | null;
  webUrl?: string;
  from?: unknown;
  body?: { contentType?: string; content?: string };
}

const KEY = "microsoft-teams";
const MAX_TEAMS = 10;
const MAX_CHANNELS = 20;
const MAX_REPLY_FETCHES = 20;

function wanted(list: string[] | null, id: string, name?: string): boolean {
  if (!list) return true;
  return list.includes(id) || (!!name && list.some((n) => n.toLowerCase() === name.toLowerCase()));
}

export function messageText(m: ChatMessage): string {
  const raw = m.body?.content ?? "";
  return m.body?.contentType === "html" ? htmlToText(raw) : raw.trim();
}

export const microsoftTeamsAdapter: NangoAdapter = {
  id: KEY,
  provider: "microsoft-teams",
  sourceHint: "microsoft-teams:channel-messages",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const teamsAllow = allowList(config, "teams");
    const channelsAllow = allowList(config, "channels");
    const signals: IngestSignal[] = [];
    const stats = { teams: 0, channels: 0, messages: 0, replies: 0, skipped: 0 };

    const teams: Team[] = [];
    await graphWalk<Team>(client, KEY, connectionId, "/v1.0/me/joinedTeams", {}, (t) => {
      if (wanted(teamsAllow, t.id, t.displayName)) teams.push(t);
      return teams.length < MAX_TEAMS;
    }, { maxPages: 2 });
    stats.teams = teams.length;

    let replyFetches = 0;
    for (const team of teams) {
      const channels: Channel[] = [];
      await graphWalk<Channel>(client, KEY, connectionId, `/v1.0/teams/${encodeURIComponent(team.id)}/channels`, {}, (c) => {
        if (wanted(channelsAllow, c.id, c.displayName)) channels.push(c);
        return stats.channels + channels.length < MAX_CHANNELS;
      }, { maxPages: 2 });
      stats.channels += channels.length;

      for (const channel of channels) {
        const base = `/v1.0/teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(channel.id)}/messages`;
        const messages: ChatMessage[] = [];
        await graphWalk<ChatMessage>(
          client,
          KEY,
          connectionId,
          `${base}/delta`,
          { $filter: `lastModifiedDateTime gt ${odataSince(since)}`, $top: Math.min(50, limit) },
          (m) => {
            if (m.messageType && m.messageType !== "message") { stats.skipped += 1; return true; }
            if (m.deletedDateTime) { stats.skipped += 1; return true; }
            messages.push(m);
            return signals.length + messages.length < limit;
          },
          { maxPages: 3 },
        );

        for (const m of messages) {
          let replies = "";
          if (replyFetches < MAX_REPLY_FETCHES) {
            replyFetches += 1;
            const lines: string[] = [];
            try {
              await graphWalk<ChatMessage>(client, KEY, connectionId, `${base}/${encodeURIComponent(m.id)}/replies`, { $top: 20 }, (r) => {
                if (r.deletedDateTime) return true;
                const t = messageText(r);
                if (t) lines.push(`- ${graphIdentity(r.from) ?? "someone"} (${r.createdDateTime ?? ""}): ${clip(t, 800)}`);
                stats.replies += 1;
                return lines.length < 20;
              }, { maxPages: 1 });
            } catch {
              // Replies are a bonus; the root message still counts.
            }
            if (lines.length) replies = `\nReplies:\n${lines.join("\n")}`;
          }
          const body = messageText(m);
          const author = graphIdentity(m.from);
          const head = m.subject?.trim() || body.split("\n")[0]?.slice(0, 80) || m.id;
          signals.push({
            external_id: `message:${channel.id}:${m.id}`,
            title: `${team.displayName ?? "Team"} / #${channel.displayName ?? channel.id} · ${head}`,
            text: [
              `Team: ${team.displayName ?? team.id} · Channel: ${channel.displayName ?? channel.id}${author ? ` · From: ${author}` : ""}`,
              "",
              clip(body),
              replies,
            ].join("\n"),
            url: m.webUrl ?? channel.webUrl,
            author,
            at: m.lastModifiedDateTime ?? m.createdDateTime,
            kind_hint: "channel_message",
          });
          stats.messages += 1;
          if (signals.length >= limit) break;
        }
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

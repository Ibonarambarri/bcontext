/**
 * Discord — `discord` → Nango `discord` (OAuth2; proxy base
 * https://discord.com). Channel messages after the cursor, one signal per
 * channel per run (a channel's conversation is the unit NEXO reads for
 * decisions), across `config.guilds` / `config.channels` allow-lists.
 *
 * IMPORTANT: Discord's user OAuth token can list the user's guilds
 * (`identify guilds`) but NOT read channels or messages — that needs the
 * integration to be installed with the `bot` scope (plus the Message
 * Content privileged intent on the app). The Nango integration for
 * `discord` must therefore carry scopes `identify guilds bot` and the app
 * must have the intent enabled; until then this adapter reports the
 * guilds it saw and `stats.forbidden` for every channel it could not read.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

const DISCORD_EPOCH = 1420070400000n;

/** Snowflake whose timestamp is `d` — messages `after` it were sent later. */
export function snowflakeAfter(d: Date): string {
  return ((BigInt(d.getTime()) - DISCORD_EPOCH) << 22n).toString();
}

interface Guild {
  id: string;
  name?: string;
}

interface Channel {
  id: string;
  name?: string;
  type?: number;
  guild_id?: string;
}

interface Message {
  id: string;
  content?: string;
  timestamp?: string;
  author?: { username?: string; global_name?: string | null; bot?: boolean };
}

const TEXT_CHANNEL = 0;
const PUBLIC_THREAD = 11;

export const discordAdapter: NangoAdapter = {
  id: "discord",
  provider: "discord",
  sourceHint: "discord:channels",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const guildAllow = allowList(config, "guilds");
    const channelAllow = allowList(config, "channels");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { guilds: 0, channels: 0, messages: 0, forbidden: 0 };

    const guilds = await client.proxy<Guild[]>({
      method: "GET",
      providerConfigKey: "discord",
      connectionId,
      path: "/api/v10/users/@me/guilds",
    });
    if (!guilds.ok) throw new Error(`discord guilds failed (${guilds.status})`);
    const after = snowflakeAfter(since);

    for (const guild of Array.isArray(guilds.data) ? guilds.data : []) {
      if (guildAllow && !guildAllow.includes(guild.id) && !guildAllow.includes(guild.name ?? "")) continue;
      stats.guilds = (stats.guilds ?? 0) + 1;
      const channels = await client.proxy<Channel[]>({
        method: "GET",
        providerConfigKey: "discord",
        connectionId,
        path: `/api/v10/guilds/${guild.id}/channels`,
      });
      if (!channels.ok) {
        stats.forbidden = (stats.forbidden ?? 0) + 1;
        continue;
      }
      for (const ch of Array.isArray(channels.data) ? channels.data : []) {
        if (ch.type !== TEXT_CHANNEL && ch.type !== PUBLIC_THREAD) continue;
        if (channelAllow && !channelAllow.includes(ch.id) && !channelAllow.includes(ch.name ?? "")) continue;
        const msgs = await client.proxy<Message[]>({
          method: "GET",
          providerConfigKey: "discord",
          connectionId,
          path: `/api/v10/channels/${ch.id}/messages`,
          query: { after, limit: 100 },
        });
        if (!msgs.ok) {
          stats.forbidden = (stats.forbidden ?? 0) + 1;
          continue;
        }
        const rows = (Array.isArray(msgs.data) ? msgs.data : [])
          .filter((m) => m.content && !m.author?.bot)
          .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
        if (!rows.length) continue;
        stats.channels = (stats.channels ?? 0) + 1;
        stats.messages = (stats.messages ?? 0) + rows.length;
        const last = rows[rows.length - 1]!;
        signals.push({
          external_id: `channel:${ch.id}:${last.id}`,
          title: `${guild.name ?? guild.id} · #${ch.name ?? ch.id}`,
          text: clip(rows.map((m) => `[${m.timestamp ?? ""}] ${m.author?.global_name ?? m.author?.username ?? "someone"}: ${m.content}`).join("\n"), 12000),
          url: `https://discord.com/channels/${guild.id}/${ch.id}/${last.id}`,
          at: last.timestamp,
          kind_hint: "conversation",
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

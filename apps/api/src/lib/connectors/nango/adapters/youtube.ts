/**
 * YouTube — `youtube` → Nango `youtube` (OAuth2, alias of `google`; proxy
 * base https://www.googleapis.com via the alias — no override needed).
 *
 * The channel the token owns (`channels.list?mine=true`, or
 * `config.channel_id`) → its uploads playlist → `playlistItems.list`
 * newest-first, kept while `videoPublishedAt > since` (≤ 5 pages) → for the
 * newest ≤ 10 new videos, `commentThreads.list?order=time` (comments off or
 * forbidden is tolerated). One signal per video: description + the top
 * comments, so NEXO learns what was published and how people reacted.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, type NangoAdapter } from "./shared";

interface Channel {
  id?: string;
  snippet?: { title?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface PlaylistItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    videoOwnerChannelTitle?: string;
    channelTitle?: string;
    resourceId?: { videoId?: string };
  };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

interface CommentThread {
  snippet?: {
    totalReplyCount?: number;
    topLevelComment?: {
      snippet?: { textOriginal?: string; textDisplay?: string; authorDisplayName?: string; publishedAt?: string; likeCount?: number };
    };
  };
}

interface Page<T> {
  items?: T[];
  nextPageToken?: string;
}

const MAX_PAGES = 5;
const COMMENTS_FOR = 10;

export function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export const youtubeAdapter: NangoAdapter = {
  id: "youtube",
  provider: "youtube",
  sourceHint: "youtube:uploads",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const channelId = configString(config, "channel_id");
    const ch = await client.proxy<Page<Channel>>({
      method: "GET",
      providerConfigKey: "youtube",
      connectionId,
      path: "/youtube/v3/channels",
      query: { part: "contentDetails,snippet", ...(channelId ? { id: channelId } : { mine: true }) },
    });
    if (!ch.ok) throw new Error(`youtube channels failed (${ch.status})`);
    const channel = ch.data?.items?.[0];
    const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return { signals: [], stats: { no_uploads_playlist: 1 } as Record<string, number> };
    const channelTitle = channel?.snippet?.title;

    const fresh: Array<{ id: string; item: PlaylistItem; at: string }> = [];
    let pageToken: string | undefined;
    let pages = 0;
    let exhausted = false;
    do {
      const res = await client.proxy<Page<PlaylistItem>>({
        method: "GET",
        providerConfigKey: "youtube",
        connectionId,
        path: "/youtube/v3/playlistItems",
        query: { part: "snippet,contentDetails", playlistId: uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) },
      });
      if (!res.ok) throw new Error(`youtube playlistItems failed (${res.status})`);
      pages++;
      for (const item of res.data?.items ?? []) {
        const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        const at = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
        if (!id || !at) continue;
        if (new Date(at) <= since) {
          exhausted = true; // uploads are newest-first
          continue;
        }
        fresh.push({ id, item, at });
      }
      pageToken = res.data?.nextPageToken;
    } while (pageToken && !exhausted && pages < MAX_PAGES && fresh.length < limit);

    const signals: IngestSignal[] = [];
    let commentsRead = 0;
    for (const [i, v] of fresh.slice(0, limit).entries()) {
      let comments = "";
      if (i < COMMENTS_FOR) {
        const ct = await client.proxy<Page<CommentThread>>({
          method: "GET",
          providerConfigKey: "youtube",
          connectionId,
          path: "/youtube/v3/commentThreads",
          query: { part: "snippet", videoId: v.id, order: "time", maxResults: 20, textFormat: "plainText" },
        });
        if (ct.ok) {
          commentsRead++;
          comments = (ct.data?.items ?? [])
            .map((t) => t.snippet?.topLevelComment?.snippet)
            .filter((c): c is NonNullable<typeof c> => !!c && !!(c.textOriginal ?? c.textDisplay))
            .map((c) => `- ${c.authorDisplayName ?? "someone"}${c.likeCount ? ` (+${c.likeCount})` : ""}: ${c.textOriginal ?? c.textDisplay}`)
            .join("\n");
        }
      }
      const s = v.item.snippet ?? {};
      signals.push({
        external_id: `video:${v.id}`,
        title: s.title ?? `Video ${v.id}`,
        text: [
          `Published: ${v.at}${channelTitle ? ` · Channel: ${channelTitle}` : ""}`,
          "",
          clip(s.description ?? ""),
          comments ? `\nComments:\n${clip(comments, 4000)}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n"),
        url: videoUrl(v.id),
        author: s.videoOwnerChannelTitle ?? s.channelTitle ?? channelTitle,
        at: v.at,
        kind_hint: "video",
      });
    }
    return { signals, stats: { pages, videos: fresh.length, comments_read: commentsRead } };
  },
};

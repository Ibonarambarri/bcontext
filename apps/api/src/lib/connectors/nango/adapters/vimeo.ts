/**
 * Vimeo — `vimeo` → Nango `vimeo-basic` (BASIC: personal access token;
 * proxy base https://api.vimeo.com).
 *
 * Videos of the connected account modified since the cursor, newest first
 * (`sort=modified_time&direction=desc`, stop at the first older item), with
 * the newest comments on each of the first ten. One signal per video.
 *
 * Assumptions (docs, not exercised live): `modified_time` is ISO-8601 with
 * offset; `paging.next` is a relative path we can pass back as `page`
 * number instead (we page by `page`, ≤3 pages); comments are under
 * `/videos/{id}/comments` with `text`, `user.name`, `created_on`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, str, type NangoAdapter } from "./shared";

interface VimeoVideo {
  uri?: string;
  name?: string;
  description?: string | null;
  link?: string;
  modified_time?: string;
  created_time?: string;
  duration?: number;
  stats?: { plays?: number | null };
  privacy?: { view?: string };
  user?: { name?: string };
}

interface VimeoComment {
  text?: string;
  created_on?: string;
  user?: { name?: string };
}

interface VimeoPage<T> {
  data?: T[];
  paging?: { next?: string | null };
}

export const VIMEO_FIELDS = "uri,name,description,link,modified_time,created_time,duration,stats,privacy,user";

function videoId(uri: string): string {
  return uri.split("/").filter(Boolean).pop() ?? uri;
}

function minutes(seconds: number | undefined): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export const vimeoAdapter: NangoAdapter = {
  id: "vimeo",
  provider: "vimeo-basic",
  sourceHint: "vimeo:videos",
  async fetchChanges({ client, connectionId, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { pages: 0, videos: 0, comments: 0 };
    const recent: VimeoVideo[] = [];
    let page = 1;
    let more = true;
    while (more && page <= 3 && recent.length < limit) {
      const res = await client.proxy<VimeoPage<VimeoVideo>>({
        method: "GET",
        providerConfigKey: "vimeo",
        connectionId,
        path: "/me/videos",
        query: { sort: "modified_time", direction: "desc", per_page: Math.min(50, limit), page, fields: VIMEO_FIELDS },
      });
      if (!res.ok) throw new Error(`vimeo videos failed (${res.status})`);
      stats.pages = (stats.pages ?? 0) + 1;
      const rows = res.data?.data ?? [];
      for (const v of rows) {
        const modified = v.modified_time ? new Date(v.modified_time) : null;
        if (!modified || Number.isNaN(modified.getTime()) || modified <= since) {
          more = false;
          break;
        }
        recent.push(v);
        if (recent.length >= limit) break;
      }
      if (!res.data?.paging?.next || rows.length === 0) more = false;
      page += 1;
    }
    stats.videos = recent.length;

    for (const [i, v] of recent.entries()) {
      const id = videoId(str(v.uri));
      let comments = "";
      if (i < 10) {
        const c = await client.proxy<VimeoPage<VimeoComment>>({
          method: "GET",
          providerConfigKey: "vimeo",
          connectionId,
          path: `/videos/${id}/comments`,
          query: { per_page: 20, direction: "desc" },
        });
        if (c.ok) {
          const rows = c.data?.data ?? [];
          stats.comments = (stats.comments ?? 0) + rows.length;
          comments = rows
            .map((x) => `- ${x.user?.name ?? "someone"} (${x.created_on ?? ""}): ${clip(str(x.text), 500)}`)
            .join("\n");
        }
      }
      signals.push({
        external_id: `video:${id}`,
        title: str(v.name) || `Video ${id}`,
        text: [
          `Duration: ${minutes(v.duration) || "?"} · Privacy: ${v.privacy?.view ?? "?"} · Plays: ${v.stats?.plays ?? "?"}`,
          v.created_time ? `Created: ${v.created_time}` : null,
          "",
          clip(str(v.description)),
          comments ? `\nComments:\n${comments}` : null,
        ]
          .filter((l) => l !== null)
          .join("\n"),
        url: v.link,
        author: v.user?.name,
        at: v.modified_time ? new Date(v.modified_time).toISOString() : undefined,
        kind_hint: "video",
      });
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

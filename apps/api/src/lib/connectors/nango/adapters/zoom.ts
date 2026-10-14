/**
 * Zoom — `zoom` → Nango `zoom` (OAuth2; proxy base https://api.zoom.us/v2).
 *
 * Two sources of "what was said", both scoped to the connected user:
 *
 *   1. AI Companion meeting summaries: `GET /meetings/meeting_summaries`
 *      lists the summaries created in a window (30 days max per call), then
 *      `GET /meetings/{uuid}/meeting_summary` returns overview, per-topic
 *      details and next steps. This is the cheap, high-signal path.
 *   2. Cloud recording transcripts: `GET /users/me/recordings` lists
 *      recordings in the window; a `TRANSCRIPT` file (VTT) is downloaded
 *      through the proxy with Nango's `Base-Url-Override` header because
 *      `download_url` lives on `<account>.zoom.us`, not on the API host. Any
 *      failure there is skipped — a transcript is a bonus, never a blocker.
 *
 * Meetings that already produced a summary are not fetched again as a
 * transcript. Zoom caps `from`/`to` at 30 days, so a `since` older than that
 * is clamped (the cursor advances normally on the next run).
 *
 * Install config: none. Assumptions noted here: `meeting_summaries` is
 * available on accounts with AI Companion; `download_url` accepts the OAuth
 * bearer token (documented for cloud recordings).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { ProxyResponse } from "@/lib/nango/client";
import { clip, type NangoAdapter } from "./shared";

interface ZoomSummaryListItem {
  meeting_uuid?: string;
  meeting_id?: number;
  meeting_topic?: string;
  meeting_start_time?: string;
  meeting_end_time?: string;
  meeting_host_email?: string;
  summary_created_time?: string;
  summary_last_modified_time?: string;
  summary_title?: string;
}

interface ZoomSummary {
  summary_title?: string;
  summary_overview?: string;
  summary_details?: Array<{ label?: string; summary?: string }>;
  next_steps?: string[];
  summary_last_modified_time?: string;
}

interface ZoomRecordingFile {
  id?: string;
  file_type?: string;
  recording_type?: string;
  download_url?: string;
  status?: string;
}

interface ZoomRecordingMeeting {
  uuid?: string;
  id?: number;
  topic?: string;
  start_time?: string;
  share_url?: string;
  host_email?: string;
  recording_files?: ZoomRecordingFile[];
}

const MAX_WINDOW_DAYS = 30;

/** Zoom wants `yyyy-mm-dd` and at most 30 days between from and to. */
export function zoomWindow(since: Date, now = new Date()): { from: string; to: string } {
  const floor = new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000);
  const start = since < floor ? floor : since;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { from: day(start), to: day(now) };
}

/** Meeting UUIDs may contain `/` or start with `/`: Zoom asks for double encoding then. */
export function zoomMeetingPath(uuid: string): string {
  const needsDouble = uuid.startsWith("/") || uuid.includes("//");
  const once = encodeURIComponent(uuid);
  return needsDouble ? encodeURIComponent(once) : once;
}

/** WebVTT → "Speaker: text" lines (cue ids, timestamps and blank lines dropped). */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) || /-->/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n");
}

export function summaryToText(s: ZoomSummary): string {
  const parts: string[] = [];
  if (s.summary_overview) parts.push(s.summary_overview.trim());
  for (const d of s.summary_details ?? []) {
    const label = d.label?.trim();
    const body = d.summary?.trim();
    if (!body) continue;
    parts.push(label ? `${label}\n${body}` : body);
  }
  if (s.next_steps?.length) parts.push(`Next steps:\n${s.next_steps.map((n) => `- ${n}`).join("\n")}`);
  return parts.join("\n\n").trim();
}

export const zoomAdapter: NangoAdapter = {
  id: "zoom",
  provider: "zoom",
  sourceHint: "zoom:meetings",
  async fetchChanges({ client, connectionId, since, limit }) {
    const window = zoomWindow(since);
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { summaries: 0, transcripts: 0, skipped: 0 };
    const covered = new Set<string>();

    // 1. AI Companion summaries in the window.
    let token: string | undefined;
    let pages = 0;
    do {
      const list: ProxyResponse<{ summaries?: ZoomSummaryListItem[]; next_page_token?: string }> = await client.proxy({
        method: "GET",
        providerConfigKey: "zoom",
        connectionId,
        path: "/meetings/meeting_summaries",
        query: { from: window.from, to: window.to, page_size: 50, ...(token ? { next_page_token: token } : {}) },
      });
      if (!list.ok) {
        // 404/403 = AI Companion not enabled for this account; transcripts still work.
        stats.summaries_unavailable = 1;
        break;
      }
      for (const item of list.data?.summaries ?? []) {
        const uuid = item.meeting_uuid;
        if (!uuid) continue;
        const modified = item.summary_last_modified_time ?? item.summary_created_time;
        if (modified && new Date(modified) <= since) continue;
        const detail = await client.proxy<ZoomSummary>({
          method: "GET",
          providerConfigKey: "zoom",
          connectionId,
          path: `/meetings/${zoomMeetingPath(uuid)}/meeting_summary`,
        });
        if (!detail.ok) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const text = summaryToText(detail.data ?? {});
        if (!text) continue;
        covered.add(uuid);
        signals.push({
          external_id: `summary:${uuid}`,
          title: item.summary_title ?? detail.data?.summary_title ?? item.meeting_topic ?? "Zoom meeting summary",
          text: clip([`Meeting: ${item.meeting_topic ?? "?"} · ${item.meeting_start_time ?? ""}`, "", text].join("\n")),
          author: item.meeting_host_email,
          at: modified ?? item.meeting_end_time ?? item.meeting_start_time,
          kind_hint: "meeting_summary",
        });
        stats.summaries = (stats.summaries ?? 0) + 1;
        if (signals.length >= limit) break;
      }
      token = list.data?.next_page_token || undefined;
      pages++;
    } while (token && pages < 5 && signals.length < limit);

    // 2. Cloud recording transcripts for meetings without a summary.
    token = undefined;
    pages = 0;
    do {
      if (signals.length >= limit) break;
      const rec: ProxyResponse<{ meetings?: ZoomRecordingMeeting[]; next_page_token?: string }> = await client.proxy({
        method: "GET",
        providerConfigKey: "zoom",
        connectionId,
        path: "/users/me/recordings",
        query: { from: window.from, to: window.to, page_size: 30, ...(token ? { next_page_token: token } : {}) },
      });
      if (!rec.ok) throw new Error(`zoom recordings failed (${rec.status})`);
      for (const m of rec.data?.meetings ?? []) {
        if (!m.uuid || covered.has(m.uuid)) continue;
        if (m.start_time && new Date(m.start_time) <= since) continue;
        const file = (m.recording_files ?? []).find((f) => f.file_type === "TRANSCRIPT" && f.download_url);
        if (!file?.download_url) continue;
        let origin: string;
        let path: string;
        try {
          const u = new URL(file.download_url);
          origin = u.origin;
          path = `${u.pathname}${u.search}`;
        } catch {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const dl = await client.proxy<string>({
          method: "GET",
          providerConfigKey: "zoom",
          connectionId,
          path,
          baseUrlOverride: origin,
        });
        if (!dl.ok || typeof dl.data !== "string") {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const text = vttToText(dl.data);
        if (!text) continue;
        signals.push({
          external_id: `transcript:${m.uuid}`,
          title: m.topic ? `${m.topic} (transcript)` : "Zoom meeting transcript",
          text: clip([`Meeting: ${m.topic ?? "?"} · ${m.start_time ?? ""}`, "", text].join("\n")),
          url: m.share_url,
          author: m.host_email,
          at: m.start_time,
          kind_hint: "transcript",
        });
        stats.transcripts = (stats.transcripts ?? 0) + 1;
        if (signals.length >= limit) break;
      }
      token = rec.data?.next_page_token || undefined;
      pages++;
    } while (token && pages < 5 && signals.length < limit);

    return { signals: signals.slice(0, limit), stats };
  },
};

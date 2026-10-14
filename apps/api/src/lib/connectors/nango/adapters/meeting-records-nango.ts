/**
 * Meeting records (via Nango) — `meeting-records-nango` → Nango `recall-ai`
 * (API_KEY; proxy base https://${connectionConfig.region}.recall.ai, e.g.
 * `us-west-2`).
 *
 * The Nango-backed twin of the native `meeting-bot` connector. Native
 * schedules the recorder and receives Recall's webhooks; this adapter only
 * reads back what the customer's own Recall account already recorded, on
 * cadence. It targets Recall's **v1 Bot API**:
 *   GET /api/v1/bot/?join_at_after=<ISO>&page_size=50   (≤3 pages, `page`)
 *     → bots whose last status is `done`
 *   transcript, in order of preference:
 *     1. `recordings[].media_shortcuts.transcript.data.download_url` — a
 *        pre-signed URL on Recall's storage host, fetched directly (adding
 *        the proxy's Authorization header would break a pre-signed URL);
 *     2. the legacy `GET /api/v1/bot/{id}/transcript/` through the proxy,
 *        which still answers on some accounts.
 * One signal per meeting (`bot:<id>`) with speaker-attributed turns capped
 * at 20 KB and the participant names. `at` = last status change.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, str, type NangoAdapter } from "./shared";

interface RecallStatus {
  code?: string;
  created_at?: string;
}

interface RecallBot {
  id: string;
  join_at?: string | null;
  status_changes?: RecallStatus[];
  status?: { code?: string };
  meeting_url?: { meeting_id?: string; platform?: string } | string;
  meeting_metadata?: { title?: string | null } | null;
  meeting_participants?: Array<{ name?: string | null }>;
  participants?: Array<{ name?: string | null }>;
  recordings?: Array<{ media_shortcuts?: { transcript?: { status?: { code?: string }; data?: { download_url?: string | null } } } }>;
}

interface RecallList {
  results?: RecallBot[];
  next?: string | null;
}

type DownloadEntry = {
  participant?: { id?: number; name?: string | null };
  words?: Array<{ text: string; start_timestamp?: { relative?: number } | null }>;
};

interface LegacyTranscript {
  monologues?: Array<{ speaker: { name?: string | null; id?: number } | null; words: Array<{ text: string; start_timestamp?: { relative?: number } | null }> }>;
  data?: Array<{ speaker: string; words: Array<{ text: string; start_time?: number }> }>;
}

const PAGES = 3;
const TRANSCRIPT_READS = 20;
const TRANSCRIPT_MAX = 20_000;

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function turnsFromDownload(entries: DownloadEntry[]): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => {
      const text = (e.words ?? []).map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
      if (!text) return null;
      const who = e.participant?.name?.trim() || (typeof e.participant?.id === "number" ? `Speaker ${e.participant.id}` : "Unknown");
      return `[${mmss(e.words?.[0]?.start_timestamp?.relative ?? 0)}] ${who}: ${text}`;
    })
    .filter((x): x is string => x !== null);
}

export function turnsFromLegacy(body: LegacyTranscript): string[] {
  if (Array.isArray(body.monologues) && body.monologues.length) {
    return body.monologues
      .map((m) => {
        const text = m.words.map((w) => w.text).join(" ").trim();
        if (!text) return null;
        const who = m.speaker?.name?.trim() || (typeof m.speaker?.id === "number" ? `Speaker ${m.speaker.id}` : "Unknown");
        return `[${mmss(m.words[0]?.start_timestamp?.relative ?? 0)}] ${who}: ${text}`;
      })
      .filter((x): x is string => x !== null);
  }
  if (Array.isArray(body.data) && body.data.length) {
    return body.data
      .map((d) => {
        const text = d.words.map((w) => w.text).join(" ").trim();
        return text ? `[${mmss(d.words[0]?.start_time ?? 0)}] ${d.speaker}: ${text}` : null;
      })
      .filter((x): x is string => x !== null);
  }
  return [];
}

function lastStatus(bot: RecallBot): RecallStatus | undefined {
  const changes = bot.status_changes ?? [];
  return changes.length ? changes[changes.length - 1] : undefined;
}

function isDone(bot: RecallBot): boolean {
  return (lastStatus(bot)?.code ?? bot.status?.code) === "done";
}

export const meetingRecordsNangoAdapter: NangoAdapter = {
  id: "meeting-records-nango",
  provider: "recall-ai",
  sourceHint: "recall:meetings",
  async fetchChanges({ client, connectionId, since, limit }) {
    const stats: Record<string, number> & { requests: number; bots: number; transcripts: number } = { requests: 0, bots: 0, transcripts: 0 };
    const bots: RecallBot[] = [];
    for (let page = 1; page <= PAGES; page += 1) {
      const res = await client.proxy<RecallList>({
        method: "GET",
        providerConfigKey: "meeting-records-nango",
        connectionId,
        path: "/api/v1/bot/",
        query: { join_at_after: since.toISOString(), page_size: 50, page },
      });
      stats.requests += 1;
      if (!res.ok) throw new Error(`recall /api/v1/bot/ failed (${res.status})`);
      bots.push(...(res.data?.results ?? []));
      if (!res.data?.next || bots.length >= limit * 2) break;
    }

    const signals: IngestSignal[] = [];
    for (const bot of bots) {
      if (signals.length >= limit) break;
      if (!isDone(bot)) continue;
      const at = lastStatus(bot)?.created_at ?? bot.join_at ?? undefined;
      if (at && new Date(at) <= since) continue;
      stats.bots += 1;

      let turns: string[] = [];
      if (stats.transcripts < TRANSCRIPT_READS) {
        const download = bot.recordings?.map((r) => r.media_shortcuts?.transcript?.data?.download_url).find((u): u is string => !!u);
        if (download) {
          try {
            const res = await fetch(download);
            if (res.ok) turns = turnsFromDownload((await res.json()) as DownloadEntry[]);
          } catch {
            stats.download_failed = (stats.download_failed ?? 0) + 1;
          }
        }
        if (!turns.length) {
          const res = await client.proxy<LegacyTranscript>({
            method: "GET",
            providerConfigKey: "meeting-records-nango",
            connectionId,
            path: `/api/v1/bot/${bot.id}/transcript/`,
          });
          stats.requests += 1;
          if (res.ok && res.data && typeof res.data === "object") turns = turnsFromLegacy(res.data);
        }
        if (turns.length) stats.transcripts += 1;
      }

      const participants = (bot.meeting_participants ?? bot.participants ?? []).map((p) => str(p.name)).filter(Boolean);
      const platform = typeof bot.meeting_url === "object" && bot.meeting_url ? str(bot.meeting_url.platform) : "";
      const when = (bot.join_at ?? at ?? "").slice(0, 16).replace("T", " ");
      const title = bot.meeting_metadata?.title?.trim() || `${platform ? `${platform} ` : ""}meeting ${when}`.trim();
      signals.push({
        external_id: `bot:${bot.id}`,
        title,
        text: clip(
          [
            participants.length ? `Participants: ${participants.join(", ")}` : null,
            platform ? `Platform: ${platform}` : null,
            "",
            turns.length ? turns.join("\n") : "(no transcript available yet)",
          ]
            .filter((x): x is string => x !== null)
            .join("\n"),
          TRANSCRIPT_MAX,
        ),
        at,
        kind_hint: "meeting",
      });
    }

    return { signals, stats };
  },
};

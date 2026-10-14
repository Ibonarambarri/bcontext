/**
 * Grain — `grain` → Nango `grain-api-key` (API_KEY; proxy base
 * https://api.grain.com). `/_/public-api/recordings` (cursor paged, ≤ 5
 * pages) filtered client-side by `start_datetime > since` — the list has no
 * date filter — then `/_/public-api/recordings/{id}` with the JSON
 * transcript, participants and highlights. One signal per recording:
 * summary, highlights (with timestamps) and the transcript capped ~20 KB.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

interface GrainRecordingSummary {
  id: string;
  title?: string | null;
  url?: string | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
}

interface GrainRecording extends GrainRecordingSummary {
  summary?: string | null;
  owners?: string[] | null;
  participants?: Array<{ name?: string | null; email?: string | null; scope?: string | null }> | null;
  highlights?: Array<{ id?: string; text?: string | null; timestamp?: number | null; transcript?: string | null }> | null;
  transcript_json?: { segments?: Array<{ speaker?: string | null; text?: string | null; timestamp?: number | null }> | null } | null;
}

interface ListResponse {
  recordings?: GrainRecordingSummary[];
  cursor?: string | null;
}

const MAX_PAGES = 5;
const TRANSCRIPT_CAP = 20000;

function mmss(ms: number | null | undefined): string {
  if (typeof ms !== "number") return "";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const grainAdapter: NangoAdapter = {
  id: "grain",
  provider: "grain-api-key",
  sourceHint: "grain:recordings",
  async fetchChanges({ client, connectionId, since, limit }) {
    const recent: GrainRecordingSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let exhausted = false;
    do {
      const res = await client.proxy<ListResponse>({
        method: "GET",
        providerConfigKey: "grain",
        connectionId,
        path: "/_/public-api/recordings",
        query: { include_highlights: false, ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) throw new Error(`grain recordings failed (${res.status})`);
      pages++;
      for (const r of res.data?.recordings ?? []) {
        const started = r.start_datetime ? new Date(r.start_datetime) : null;
        if (started && started <= since) {
          exhausted = true; // list is newest-first; everything after this is older
          continue;
        }
        recent.push(r);
      }
      cursor = res.data?.cursor ?? undefined;
    } while (cursor && !exhausted && pages < MAX_PAGES && recent.length < limit);

    const signals: IngestSignal[] = [];
    for (const r of recent.slice(0, limit)) {
      const det = await client.proxy<GrainRecording>({
        method: "GET",
        providerConfigKey: "grain",
        connectionId,
        path: `/_/public-api/recordings/${r.id}`,
        query: { transcript_format: "json", include_participants: true, include_highlights: true },
      });
      const d: GrainRecording = det.ok && det.data ? det.data : r;
      const participants = (d.participants ?? [])
        .map((p) => `${p.name ?? p.email ?? "?"}${p.scope ? ` (${p.scope})` : ""}`)
        .join(", ");
      const highlights = (d.highlights ?? [])
        .filter((h) => h.text)
        .map((h) => `- ${mmss(h.timestamp) ? `[${mmss(h.timestamp)}] ` : ""}${h.text}${h.transcript ? ` — "${h.transcript}"` : ""}`)
        .join("\n");
      const transcript = (d.transcript_json?.segments ?? [])
        .filter((s) => s.text)
        .map((s) => `${s.speaker ?? "?"}: ${s.text}`)
        .join("\n");
      signals.push({
        external_id: `recording:${r.id}`,
        title: d.title ?? `Recording ${r.id}`,
        text: [
          `When: ${d.start_datetime ?? "?"}${d.end_datetime ? ` → ${d.end_datetime}` : ""}`,
          participants ? `Participants: ${participants}` : null,
          d.summary ? `\nSummary:\n${d.summary}` : null,
          highlights ? `\nHighlights:\n${highlights}` : null,
          transcript ? `\nTranscript:\n${clip(transcript, TRANSCRIPT_CAP)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: d.url ?? undefined,
        author: d.owners?.[0] ?? undefined,
        at: d.start_datetime ?? undefined,
        kind_hint: "meeting",
      });
    }
    return { signals, stats: { listed: recent.length, recordings: signals.length } };
  },
};

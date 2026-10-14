/**
 * Chorus (ZoomInfo) — `chorus` → Nango `chorus` (API_KEY: personal API
 * token as Bearer; proxy base https://chorus.ai).
 *
 * Engagements API (https://api-docs.chorus.ai — reference requires a
 * customer login, so the exact query-parameter names are an assumption
 * recorded here): `GET /api/v1/engagements` with `engagement_type=MEETING`,
 * `processing_state=done` (transcript only exists once processing is done)
 * and `date_time_from=<since>`, offset-paged (≤ 5 pages). Every row is also
 * filtered client-side on `date_time > since`, so an ignored date parameter
 * degrades to "read the first pages and keep the recent ones" instead of
 * over-ingesting. Then `GET /api/v1/engagements/{id}/transcript`, whose
 * utterances (`speaker_name`/`speaker_type`, `snippet`/`text`, `start_time`)
 * are flattened and capped ~20 KB. One signal per meeting.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

interface ChorusParticipant {
  person_id?: string;
  name?: string | null;
  email?: string | null;
  title?: string | null;
  speaker_type?: string | null;
}

interface ChorusEngagement {
  engagement_id?: string;
  id?: string;
  engagement_type?: string;
  subject?: string | null;
  date_time?: string | null;
  duration?: number | null;
  processing_state?: string | null;
  url?: string | null;
  owner?: { name?: string | null } | null;
  account?: { name?: string | null } | null;
  deal?: { name?: string | null } | null;
  participants?: ChorusParticipant[] | null;
  summary?: string | { text?: string } | null;
  action_items?: Array<{ text?: string } | string> | null;
}

interface ChorusUtterance {
  speaker_name?: string | null;
  speaker_id?: string | null;
  speaker_type?: string | null;
  snippet?: string | null;
  text?: string | null;
  start_time?: number | null;
}

interface EngagementsResponse {
  engagements?: ChorusEngagement[];
  data?: ChorusEngagement[];
  results?: ChorusEngagement[];
  total?: number;
}

interface TranscriptResponse {
  utterances?: ChorusUtterance[];
  transcript?: { utterances?: ChorusUtterance[] } | ChorusUtterance[];
}

const PAGE = 100;
const MAX_PAGES = 5;
const TRANSCRIPT_CAP = 20000;

function rows(res: EngagementsResponse | ChorusEngagement[] | undefined): ChorusEngagement[] {
  if (Array.isArray(res)) return res;
  return res?.engagements ?? res?.data ?? res?.results ?? [];
}

function utterances(res: TranscriptResponse | ChorusUtterance[] | undefined): ChorusUtterance[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.utterances)) return res.utterances;
  if (Array.isArray(res?.transcript)) return res.transcript;
  return res?.transcript?.utterances ?? [];
}

function mmss(seconds: number | null | undefined): string {
  if (typeof seconds !== "number") return "";
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function summaryText(s: ChorusEngagement["summary"]): string {
  if (!s) return "";
  return typeof s === "string" ? s : (s.text ?? "");
}

export const chorusAdapter: NangoAdapter = {
  id: "chorus",
  provider: "chorus",
  sourceHint: "chorus:engagements",
  async fetchChanges({ client, connectionId, since, limit }) {
    const recent: ChorusEngagement[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const res = await client.proxy<EngagementsResponse | ChorusEngagement[]>({
        method: "GET",
        providerConfigKey: "chorus",
        connectionId,
        path: "/api/v1/engagements",
        query: {
          engagement_type: "MEETING",
          processing_state: "done",
          date_time_from: since.toISOString(),
          offset,
          limit: PAGE,
        },
      });
      if (!res.ok) throw new Error(`chorus engagements failed (${res.status})`);
      pages++;
      const page = rows(res.data);
      for (const e of page) {
        const at = e.date_time ? new Date(e.date_time) : null;
        if (!at || Number.isNaN(at.getTime()) || at <= since) continue;
        if (e.processing_state && e.processing_state.toLowerCase() !== "done") continue;
        recent.push(e);
      }
      if (page.length < PAGE || pages >= MAX_PAGES || recent.length >= limit) break;
      offset += PAGE;
    }

    const signals: IngestSignal[] = [];
    let transcripts = 0;
    for (const e of recent.slice(0, limit)) {
      const id = e.engagement_id ?? e.id;
      if (!id) continue;
      const tr = await client.proxy<TranscriptResponse | ChorusUtterance[]>({
        method: "GET",
        providerConfigKey: "chorus",
        connectionId,
        path: `/api/v1/engagements/${encodeURIComponent(id)}/transcript`,
      });
      const lines = tr.ok
        ? utterances(tr.data)
            .filter((u) => u.snippet ?? u.text)
            .map((u) => `${mmss(u.start_time) ? `[${mmss(u.start_time)}] ` : ""}${u.speaker_name ?? u.speaker_type ?? u.speaker_id ?? "?"}: ${u.snippet ?? u.text}`)
        : [];
      if (lines.length) transcripts++;
      const participants = (e.participants ?? [])
        .map((p) => `${p.name ?? p.email ?? "?"}${p.title ? ` (${p.title})` : ""}${p.speaker_type ? ` [${p.speaker_type}]` : ""}`)
        .join(", ");
      const actions = (e.action_items ?? [])
        .map((a) => (typeof a === "string" ? a : a.text))
        .filter(Boolean)
        .map((a) => `- ${a}`)
        .join("\n");
      const summary = summaryText(e.summary);
      signals.push({
        external_id: `engagement:${id}`,
        title: e.subject?.trim() || `Meeting ${id}`,
        text: [
          `When: ${e.date_time ?? "?"}${typeof e.duration === "number" ? ` · Duration: ${Math.round(e.duration / 60)} min` : ""}`,
          e.account?.name ? `Account: ${e.account.name}${e.deal?.name ? ` · Deal: ${e.deal.name}` : ""}` : null,
          participants ? `Participants: ${participants}` : null,
          summary ? `\nSummary:\n${summary}` : null,
          actions ? `\nAction items:\n${actions}` : null,
          lines.length ? `\nTranscript:\n${clip(lines.join("\n"), TRANSCRIPT_CAP)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: e.url ?? undefined,
        author: e.owner?.name ?? undefined,
        at: e.date_time ?? undefined,
        kind_hint: "meeting",
      });
    }
    return { signals, stats: { pages, engagements: recent.length, transcripts } };
  },
};

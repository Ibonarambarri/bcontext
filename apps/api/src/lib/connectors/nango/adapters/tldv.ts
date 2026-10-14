/**
 * tl;dv — `tldv` → Nango `tldv` (API_KEY; proxy base https://pasta.tldv.io).
 * `/v1alpha1/meetings?from=<since>` (paged, ≤ 5 pages), then per meeting
 * `/v1alpha1/meetings/{id}/highlights` (AI notes / summary points) and
 * `/v1alpha1/meetings/{id}/transcript` (speaker turns, capped ~20 KB). One
 * signal per meeting. A transcript that is not ready yet (404 / 202) is
 * skipped, not fatal — the meeting still ships with its highlights.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

interface TldvMeeting {
  id: string;
  name?: string | null;
  happenedAt?: string | null;
  url?: string | null;
  organizer?: { name?: string | null; email?: string | null } | null;
  invitees?: Array<{ name?: string | null; email?: string | null }> | null;
}

interface MeetingsResponse {
  page?: number;
  pages?: number;
  total?: number;
  pageSize?: number;
  results?: TldvMeeting[];
}

interface HighlightsResponse {
  data?: Array<{ text?: string | null; startTime?: number | null; topic?: { title?: string | null } | null }>;
}

interface TranscriptResponse {
  data?: Array<{ speaker?: string | null; text?: string | null; startTime?: number | null }>;
}

const MAX_PAGES = 5;
const TRANSCRIPT_CAP = 20000;

export const tldvAdapter: NangoAdapter = {
  id: "tldv",
  provider: "tldv",
  sourceHint: "tldv:meetings",
  async fetchChanges({ client, connectionId, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats = { meetings: 0, transcripts: 0 };
    let page = 1;
    for (;;) {
      const res = await client.proxy<MeetingsResponse>({
        method: "GET",
        providerConfigKey: "tldv",
        connectionId,
        path: "/v1alpha1/meetings",
        query: { from: since.toISOString(), page, limit: Math.min(50, limit) },
      });
      if (!res.ok) throw new Error(`tldv meetings failed (${res.status})`);
      const rows = res.data?.results ?? [];
      stats.meetings += rows.length;
      for (const m of rows) {
        const [hl, tr] = await Promise.all([
          client.proxy<HighlightsResponse>({
            method: "GET",
            providerConfigKey: "tldv",
            connectionId,
            path: `/v1alpha1/meetings/${m.id}/highlights`,
          }),
          client.proxy<TranscriptResponse>({
            method: "GET",
            providerConfigKey: "tldv",
            connectionId,
            path: `/v1alpha1/meetings/${m.id}/transcript`,
          }),
        ]);
        const highlights = hl.ok
          ? (hl.data?.data ?? [])
              .filter((h) => h.text)
              .map((h) => `- ${h.topic?.title ? `[${h.topic.title}] ` : ""}${h.text}`)
              .join("\n")
          : "";
        const transcript = tr.ok
          ? (tr.data?.data ?? [])
              .filter((t) => t.text)
              .map((t) => `${t.speaker ?? "?"}: ${t.text}`)
              .join("\n")
          : "";
        if (transcript) stats.transcripts++;
        const people = (m.invitees ?? []).map((i) => i.name ?? i.email).filter(Boolean).join(", ");
        signals.push({
          external_id: `meeting:${m.id}`,
          title: m.name ?? `Meeting ${m.id}`,
          text: [
            m.happenedAt ? `When: ${m.happenedAt}` : null,
            m.organizer?.name || m.organizer?.email ? `Organizer: ${m.organizer?.name ?? m.organizer?.email}` : null,
            people ? `Participants: ${people}` : null,
            highlights ? `\nHighlights:\n${highlights}` : null,
            transcript ? `\nTranscript:\n${clip(transcript, TRANSCRIPT_CAP)}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          url: m.url ?? undefined,
          author: m.organizer?.name ?? m.organizer?.email ?? undefined,
          at: m.happenedAt ?? undefined,
          kind_hint: "meeting",
        });
        if (signals.length >= limit) break;
      }
      const pages = res.data?.pages ?? 1;
      if (rows.length === 0 || page >= pages || page >= MAX_PAGES || signals.length >= limit) break;
      page++;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

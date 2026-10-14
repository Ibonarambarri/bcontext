/**
 * Fireflies.ai — `fireflies` → Nango `fireflies` (API_KEY; proxy base
 * https://api.fireflies.ai). GraphQL `transcripts(fromDate, limit)`: one
 * signal per meeting with the AI summary (overview, action items,
 * keywords) followed by the transcript sentences, capped at ~20 KB so one
 * long call cannot eat the batch. `date` comes back as epoch milliseconds.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

interface Transcript {
  id: string;
  title?: string | null;
  date?: number | string | null;
  transcript_url?: string | null;
  organizer_email?: string | null;
  summary?: { overview?: string | null; action_items?: string | null; keywords?: string[] | null } | null;
  sentences?: Array<{ speaker_name?: string | null; text?: string | null }> | null;
}

export const FIREFLIES_QUERY = `query Transcripts($fromDate: DateTime, $limit: Int) {
  transcripts(fromDate: $fromDate, limit: $limit) {
    id title date transcript_url organizer_email
    summary { overview action_items keywords }
    sentences { speaker_name text }
  }
}`;

function whenIso(date: Transcript["date"]): string | undefined {
  if (typeof date === "number") return new Date(date).toISOString();
  if (typeof date === "string" && date) {
    const n = Number(date);
    return Number.isFinite(n) ? new Date(n).toISOString() : date;
  }
  return undefined;
}

export const firefliesAdapter: NangoAdapter = {
  id: "fireflies",
  provider: "fireflies",
  sourceHint: "fireflies:transcripts",
  async fetchChanges({ client, connectionId, since, limit }) {
    const res = await client.proxy<{ data?: { transcripts?: Transcript[] }; errors?: Array<{ message?: string }> }>({
      method: "POST",
      providerConfigKey: "fireflies",
      connectionId,
      path: "/graphql",
      body: { query: FIREFLIES_QUERY, variables: { fromDate: since.toISOString(), limit: Math.min(50, limit) } },
    });
    if (!res.ok) throw new Error(`fireflies transcripts failed (${res.status})`);
    if (res.data?.errors?.length) throw new Error(`fireflies query error: ${res.data.errors[0]?.message ?? "?"}`);
    const signals: IngestSignal[] = [];
    for (const t of res.data?.data?.transcripts ?? []) {
      const s = t.summary ?? {};
      const sentences = (t.sentences ?? [])
        .filter((x) => x.text)
        .map((x) => `${x.speaker_name ?? "?"}: ${x.text}`)
        .join("\n");
      signals.push({
        external_id: `transcript:${t.id}`,
        title: t.title ?? `Meeting ${t.id}`,
        text: [
          s.overview ? `Overview:\n${s.overview}` : null,
          s.action_items ? `\nAction items:\n${s.action_items}` : null,
          s.keywords?.length ? `\nKeywords: ${s.keywords.join(", ")}` : null,
          sentences ? `\nTranscript:\n${clip(sentences, 20000)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: t.transcript_url ?? undefined,
        author: t.organizer_email ?? undefined,
        at: whenIso(t.date),
        kind_hint: "meeting",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { transcripts: signals.length } };
  },
};

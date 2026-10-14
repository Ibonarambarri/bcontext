/**
 * Gong — `gong` → Nango `gong` (BASIC: access key + access key secret;
 * proxy base https://api.gong.io). `POST /v2/calls/extensive` with
 * `filter.fromDateTime = since` and the content selector exposing brief,
 * outline, key points, trackers and topics (paged by cursor, ≤ 5 pages),
 * then `POST /v2/calls/transcript` for the first `TRANSCRIPT_CALLS` calls
 * of the run so the batch is not all transcript. One signal per call.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

interface GongCall {
  metaData?: {
    id: string;
    title?: string | null;
    started?: string | null;
    duration?: number | null;
    url?: string | null;
    primaryUserId?: string | null;
    direction?: string | null;
    system?: string | null;
  };
  parties?: Array<{ name?: string | null; emailAddress?: string | null; affiliation?: string | null; speakerId?: string | null }> | null;
  content?: {
    brief?: string | null;
    outline?: Array<{ section?: string | null; items?: Array<{ text?: string | null }> | null }> | null;
    keyPoints?: Array<{ text?: string | null }> | null;
    trackers?: Array<{ name?: string | null; count?: number | null }> | null;
    topics?: Array<{ name?: string | null; duration?: number | null }> | null;
  } | null;
}

interface ExtensiveResponse {
  calls?: GongCall[];
  records?: { cursor?: string | null; totalRecords?: number; currentPageSize?: number };
}

interface TranscriptResponse {
  callTranscripts?: Array<{
    callId: string;
    transcript?: Array<{ speakerId?: string | null; topic?: string | null; sentences?: Array<{ text?: string | null }> | null }> | null;
  }>;
}

const MAX_PAGES = 5;
const TRANSCRIPT_CALLS = 10;
const TRANSCRIPT_CAP = 20000;

export const GONG_CONTENT_SELECTOR = {
  exposedFields: {
    parties: true,
    content: { brief: true, outline: true, keyPoints: true, trackers: true, topics: true },
  },
};

export const gongAdapter: NangoAdapter = {
  id: "gong",
  provider: "gong",
  sourceHint: "gong:calls",
  async fetchChanges({ client, connectionId, since, limit }) {
    const calls: GongCall[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<ExtensiveResponse>({
        method: "POST",
        providerConfigKey: "gong",
        connectionId,
        path: "/v2/calls/extensive",
        body: {
          filter: { fromDateTime: since.toISOString() },
          contentSelector: GONG_CONTENT_SELECTOR,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!res.ok) throw new Error(`gong calls/extensive failed (${res.status})`);
      pages++;
      calls.push(...(res.data?.calls ?? []));
      cursor = res.data?.records?.cursor ?? undefined;
    } while (cursor && pages < MAX_PAGES && calls.length < limit);

    const selected = calls.slice(0, limit);
    const transcripts = new Map<string, string>();
    const ids = selected.slice(0, TRANSCRIPT_CALLS).map((c) => c.metaData?.id).filter((x): x is string => !!x);
    if (ids.length) {
      const tr = await client.proxy<TranscriptResponse>({
        method: "POST",
        providerConfigKey: "gong",
        connectionId,
        path: "/v2/calls/transcript",
        body: { filter: { callIds: ids } },
      });
      if (tr.ok) {
        for (const t of tr.data?.callTranscripts ?? []) {
          const text = (t.transcript ?? [])
            .map((seg) => {
              const sentences = (seg.sentences ?? []).map((s) => s.text).filter(Boolean).join(" ");
              return sentences ? `${seg.speakerId ?? "?"}${seg.topic ? ` [${seg.topic}]` : ""}: ${sentences}` : "";
            })
            .filter(Boolean)
            .join("\n");
          if (text) transcripts.set(t.callId, text);
        }
      }
    }

    const signals: IngestSignal[] = selected.map((c) => {
      const md = c.metaData ?? { id: "?" };
      const speakerNames = new Map((c.parties ?? []).map((p) => [p.speakerId ?? "", p.name ?? p.emailAddress ?? "?"]));
      const parties = (c.parties ?? [])
        .map((p) => `${p.name ?? p.emailAddress ?? "?"}${p.affiliation ? ` (${p.affiliation})` : ""}`)
        .join(", ");
      const content = c.content ?? {};
      const outline = (content.outline ?? [])
        .map((o) => `${o.section ?? ""}\n${(o.items ?? []).map((i) => `  - ${i.text ?? ""}`).join("\n")}`)
        .join("\n");
      const keyPoints = (content.keyPoints ?? []).map((k) => `- ${k.text ?? ""}`).join("\n");
      const trackers = (content.trackers ?? []).filter((t) => (t.count ?? 0) > 0).map((t) => `${t.name} ×${t.count}`).join(", ");
      const topics = (content.topics ?? []).map((t) => t.name).filter(Boolean).join(", ");
      const raw = transcripts.get(md.id);
      const transcript = raw ? raw.replace(/^(\S+)(?=( \[|:))/gm, (id) => speakerNames.get(id) ?? id) : "";
      return {
        external_id: `call:${md.id}`,
        title: md.title ?? `Call ${md.id}`,
        text: [
          `When: ${md.started ?? "?"}${md.duration ? ` · ${Math.round(md.duration / 60)} min` : ""}${md.direction ? ` · ${md.direction}` : ""}`,
          parties ? `Participants: ${parties}` : null,
          content.brief ? `\nBrief:\n${content.brief}` : null,
          keyPoints ? `\nKey points:\n${keyPoints}` : null,
          outline ? `\nOutline:\n${outline}` : null,
          trackers ? `Trackers: ${trackers}` : null,
          topics ? `Topics: ${topics}` : null,
          transcript ? `\nTranscript:\n${clip(transcript, TRANSCRIPT_CAP)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: md.url ?? undefined,
        author: (c.parties ?? []).find((p) => p.affiliation === "Internal")?.name ?? undefined,
        at: md.started ?? undefined,
        kind_hint: "meeting",
      };
    });
    return { signals, stats: { calls: calls.length, transcripts: transcripts.size } };
  },
};

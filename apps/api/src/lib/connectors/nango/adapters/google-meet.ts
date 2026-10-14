/**
 * Google Meet — `google-meet` → Nango `google-meet` (OAuth2 via google;
 * proxy base https://meet.googleapis.com, Meet REST API v2).
 *
 * Conferences that started after the cursor
 * (`GET /v2/conferenceRecords?filter=start_time>="<since>"`), then for each
 * one its transcripts (`/transcripts`) and their entries (`/entries`,
 * paginated). Participant resource names are resolved once per conference
 * through `/participants` so the text reads "Ana: …" instead of an id.
 *
 * One signal per transcript. Entries are capped (a few pages) and the text
 * is clipped — a two-hour meeting does not need to enter the batch whole.
 *
 * Transcripts Meet writes to Drive as Google Docs also arrive through the
 * `google-drive` connector; this adapter is the structured path that does
 * not depend on the Drive folder layout.
 *
 * Install config: none.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { ProxyResponse } from "@/lib/nango/client";
import { clip, type NangoAdapter } from "./shared";

interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
  space?: string;
}

interface Transcript {
  name: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: { document?: string; exportUri?: string };
}

interface TranscriptEntry {
  name?: string;
  participant?: string;
  text?: string;
  startTime?: string;
}

interface Participant {
  name: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

const MAX_ENTRY_PAGES = 4;

/** Meet's list filter: RFC 3339 with the comparison operator, quoted. */
export function meetFilter(since: Date): string {
  return `start_time>="${since.toISOString()}"`;
}

export function participantName(p: Participant | undefined): string {
  return p?.signedinUser?.displayName ?? p?.anonymousUser?.displayName ?? p?.phoneUser?.displayName ?? "Participant";
}

export const googleMeetAdapter: NangoAdapter = {
  id: "google-meet",
  provider: "google-meet",
  sourceHint: "google-meet:transcripts",
  async fetchChanges({ client, connectionId, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { conferences: 0, transcripts: 0, skipped: 0 };
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const list: ProxyResponse<{ conferenceRecords?: ConferenceRecord[]; nextPageToken?: string }> = await client.proxy({
        method: "GET",
        providerConfigKey: "google-meet",
        connectionId,
        path: "/v2/conferenceRecords",
        query: { filter: meetFilter(since), pageSize: 25, ...(pageToken ? { pageToken } : {}) },
      });
      if (!list.ok) throw new Error(`google meet conferenceRecords failed (${list.status})`);
      for (const conf of list.data?.conferenceRecords ?? []) {
        stats.conferences = (stats.conferences ?? 0) + 1;
        const transcripts = await client.proxy<{ transcripts?: Transcript[] }>({
          method: "GET",
          providerConfigKey: "google-meet",
          connectionId,
          path: `/v2/${conf.name}/transcripts`,
        });
        if (!transcripts.ok) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const ready = (transcripts.data?.transcripts ?? []).filter((t) => !t.state || t.state === "FILE_GENERATED" || t.state === "ENDED");
        if (!ready.length) continue;

        const names = new Map<string, string>();
        const participants = await client.proxy<{ participants?: Participant[] }>({
          method: "GET",
          providerConfigKey: "google-meet",
          connectionId,
          path: `/v2/${conf.name}/participants`,
          query: { pageSize: 100 },
        });
        for (const p of participants.ok ? (participants.data?.participants ?? []) : []) names.set(p.name, participantName(p));

        for (const t of ready) {
          const lines: string[] = [];
          let entryToken: string | undefined;
          let entryPages = 0;
          do {
            const entries: ProxyResponse<{ transcriptEntries?: TranscriptEntry[]; nextPageToken?: string }> = await client.proxy({
              method: "GET",
              providerConfigKey: "google-meet",
              connectionId,
              path: `/v2/${t.name}/entries`,
              query: { pageSize: 100, ...(entryToken ? { pageToken: entryToken } : {}) },
            });
            if (!entries.ok) break;
            for (const e of entries.data?.transcriptEntries ?? []) {
              const text = e.text?.trim();
              if (!text) continue;
              const who = e.participant ? (names.get(e.participant) ?? "Participant") : "Participant";
              lines.push(`${who}: ${text}`);
            }
            entryToken = entries.data?.nextPageToken || undefined;
            entryPages++;
          } while (entryToken && entryPages < MAX_ENTRY_PAGES);
          if (!lines.length) continue;
          const day = (conf.startTime ?? t.startTime ?? "").slice(0, 10);
          signals.push({
            external_id: `transcript:${t.name}`,
            title: `Google Meet transcript${day ? ` · ${day}` : ""}`,
            text: clip([`Conference: ${conf.name} · ${conf.startTime ?? ""} → ${conf.endTime ?? ""}`, "", lines.join("\n")].join("\n")),
            url: t.docsDestination?.exportUri,
            at: t.endTime ?? conf.endTime ?? conf.startTime,
            kind_hint: "transcript",
          });
          stats.transcripts = (stats.transcripts ?? 0) + 1;
          if (signals.length >= limit) break;
        }
        if (signals.length >= limit) break;
      }
      pageToken = list.data?.nextPageToken || undefined;
      pages++;
    } while (pageToken && pages < 5 && signals.length < limit);
    return { signals: signals.slice(0, limit), stats };
  },
};

/**
 * PagerDuty — `pagerduty` → Nango `pagerduty` (OAuth2; proxy base
 * https://api.pagerduty.com; `Accept: application/vnd.pagerduty+json;version=2`).
 * Incidents whose status changed since the cursor, with their notes and the
 * overview log entries (acknowledged / resolved by whom) — the raw material
 * for bugs and post-mortem decisions. Optional `config.service_ids`.
 *
 * Assumption: `/incidents?since=&until=` filters on creation time, so the
 * window opens 30 days before the cursor and items are kept when
 * `last_status_change_at` (or `created_at`) is after the cursor. Notes and
 * log entries are fetched for the first 20 incidents of a run.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface PdIncident {
  id: string;
  incident_number?: number;
  title?: string;
  status?: string;
  urgency?: string;
  created_at?: string;
  last_status_change_at?: string;
  html_url?: string;
  service?: { summary?: string };
  priority?: { summary?: string } | null;
  assignments?: Array<{ assignee?: { summary?: string } }>;
}
interface PdNote {
  content?: string;
  created_at?: string;
  user?: { summary?: string };
}
interface PdLogEntry {
  type?: string;
  summary?: string;
  created_at?: string;
  agent?: { summary?: string };
}

const HEADERS = { Accept: "application/vnd.pagerduty+json;version=2" };
const LOOKBACK_MS = 30 * 24 * 3600 * 1000;
const MAX_DETAIL_FETCHES = 20;
const PAGE = 50;

export function pagerdutyWindowStart(since: Date): string {
  return new Date(since.getTime() - LOOKBACK_MS).toISOString();
}

export const pagerdutyAdapter: NangoAdapter = {
  id: "pagerduty",
  provider: "pagerduty",
  sourceHint: "pagerduty:incidents",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
      client.proxy<T>({ method: "GET", providerConfigKey: "pagerduty", connectionId, path, query, headers: HEADERS });

    const services = allowList(config, "service_ids");
    const until = new Date().toISOString();
    const signals: IngestSignal[] = [];
    let offset = 0;
    let more = true;
    let pages = 0;
    let detailFetches = 0;
    while (more && signals.length < limit && pages < 4) {
      const res = await get<{ incidents?: PdIncident[]; more?: boolean }>("/incidents", {
        since: pagerdutyWindowStart(since),
        until,
        sort_by: "created_at:desc",
        limit: PAGE,
        offset,
        ...(services ? { "service_ids[]": services.join(",") } : {}),
      });
      if (!res.ok) throw new Error(`pagerduty incidents failed (${res.status})`);
      pages += 1;
      more = !!res.data?.more;
      offset += PAGE;
      for (const inc of res.data?.incidents ?? []) {
        const changedAt = inc.last_status_change_at ?? inc.created_at;
        if (!changedAt || new Date(changedAt) <= since) continue;
        let notes = "";
        let timeline = "";
        if (detailFetches < MAX_DETAIL_FETCHES) {
          detailFetches += 1;
          const [n, l] = await Promise.all([
            get<{ notes?: PdNote[] }>(`/incidents/${inc.id}/notes`),
            get<{ log_entries?: PdLogEntry[] }>(`/incidents/${inc.id}/log_entries`, { is_overview: true, limit: 20 }),
          ]);
          if (n.ok) {
            notes = (n.data?.notes ?? [])
              .map((x) => `- ${x.user?.summary ?? "someone"} (${x.created_at ?? ""}): ${clip(x.content ?? "", 2000)}`)
              .join("\n");
          }
          if (l.ok) {
            timeline = (l.data?.log_entries ?? [])
              .map((x) => `- ${x.created_at ?? ""} ${x.summary ?? x.type ?? ""}${x.agent?.summary ? ` (${x.agent.summary})` : ""}`)
              .join("\n");
          }
        }
        signals.push({
          external_id: `incident:${inc.id}`,
          title: `#${inc.incident_number ?? inc.id} · ${inc.title ?? ""}`.trim(),
          text: [
            `Status: ${inc.status ?? "?"} · Urgency: ${inc.urgency ?? "?"}${inc.priority?.summary ? ` · Priority: ${inc.priority.summary}` : ""}${inc.service?.summary ? ` · Service: ${inc.service.summary}` : ""}`,
            inc.assignments?.length ? `Assigned: ${inc.assignments.map((a) => a.assignee?.summary).filter(Boolean).join(", ")}` : null,
            `Created: ${inc.created_at ?? "?"} · Last status change: ${inc.last_status_change_at ?? "?"}`,
            notes ? `\nNotes:\n${notes}` : null,
            timeline ? `\nTimeline:\n${timeline}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: inc.html_url,
          author: inc.assignments?.[0]?.assignee?.summary,
          at: changedAt,
          kind_hint: "incident",
        });
        if (signals.length >= limit) break;
      }
    }
    return { signals: signals.slice(0, limit), stats: { pages, detail_fetches: detailFetches } };
  },
};

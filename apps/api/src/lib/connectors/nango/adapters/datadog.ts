/**
 * Datadog — `datadog` → Nango `datadog` (API_KEY: API key + application key;
 * connection_config.siteParameter = datadoghq.com | datadoghq.eu | us3… ;
 * proxy base https://api.<site>/api, so paths start at /v1 or /v2).
 *
 * What changed since the cursor:
 *   - incidents modified (`GET /v2/incidents?include=users`, filtered on
 *     attributes.modified, timeline cells read from
 *     `GET /v2/incidents/{id}/timeline` when the endpoint answers — it is
 *     tolerated to fail, the incident still lands with its fields),
 *   - monitors modified (`GET /v1/monitor`, filtered on `modified`),
 *   - events in the window (`GET /v1/events?start&end&priority=normal`,
 *     capped to EVENTS_CAP so a noisy account cannot flood the batch).
 * Assumptions to confirm with a real account: the incidents endpoint pages
 * with `page[offset]`, `included` carries commander users when
 * `include=users`, timeline cells expose `attributes.content.content`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, epochSeconds, str, type NangoAdapter } from "./shared";

interface DdField {
  type?: string;
  value?: unknown;
}

interface DdIncident {
  id: string;
  attributes?: {
    public_id?: number;
    title?: string;
    created?: string;
    modified?: string;
    resolved?: string | null;
    customer_impacted?: boolean;
    customer_impact_scope?: string | null;
    time_to_resolve?: number;
    fields?: Record<string, DdField>;
  };
  relationships?: { commander_user?: { data?: { id?: string } | null } };
}

interface DdUser {
  id: string;
  type?: string;
  attributes?: { name?: string; email?: string; handle?: string };
}

interface DdTimelineCell {
  id: string;
  attributes?: {
    cell_type?: string;
    created?: string;
    content?: { content?: string; important?: boolean };
    author?: { name?: string; email?: string };
  };
}

interface DdMonitor {
  id: number;
  name?: string;
  type?: string;
  query?: string;
  message?: string;
  overall_state?: string;
  modified?: string;
  created?: string;
  creator?: { name?: string; email?: string };
  tags?: string[];
}

interface DdEvent {
  id: number;
  title?: string;
  text?: string;
  date_happened?: number;
  priority?: string;
  alert_type?: string;
  source?: string;
  tags?: string[];
  url?: string;
}

const EVENTS_CAP = 20;
const INCIDENT_PAGES = 3;

/** Where the browser opens Datadog for this site (app.datadoghq.com, app.datadoghq.eu, us3.datadoghq.com …). */
export function datadogAppUrl(connectionConfig: Record<string, unknown>): string {
  const site = str(connectionConfig.siteParameter) || "datadoghq.com";
  return site === "datadoghq.com" || site === "datadoghq.eu" ? `https://app.${site}` : `https://${site}`;
}

function fieldValue(fields: Record<string, DdField> | undefined, key: string): string {
  const v = fields?.[key]?.value;
  if (v == null) return "";
  return Array.isArray(v) ? v.map(str).join(", ") : str(v);
}

export const datadogAdapter: NangoAdapter = {
  id: "datadog",
  provider: "datadog",
  sourceHint: "datadog:incidents+monitors+events",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const app = datadogAppUrl(connectionConfig);
    const signals: IngestSignal[] = [];
    const stats = { incidents: 0, monitors: 0, events: 0, pages: 0 };

    // -- incidents ---------------------------------------------------------
    let offset = 0;
    for (let page = 0; page < INCIDENT_PAGES && signals.length < limit; page += 1) {
      const res = await client.proxy<{ data?: DdIncident[]; included?: DdUser[]; meta?: { pagination?: { next_offset?: number } } }>({
        method: "GET",
        providerConfigKey: "datadog",
        connectionId,
        path: "/v2/incidents",
        query: { "page[size]": 100, "page[offset]": offset, include: "users" },
      });
      if (!res.ok) throw new Error(`datadog incidents failed (${res.status})`);
      stats.pages += 1;
      const users = new Map<string, DdUser>();
      for (const u of res.data?.included ?? []) if (u?.type === "users" || u?.attributes) users.set(u.id, u);
      const rows = res.data?.data ?? [];
      let sawOlder = false;
      for (const inc of rows) {
        const a = inc.attributes ?? {};
        const modified = a.modified ? new Date(a.modified) : null;
        if (!modified || modified <= since) {
          sawOlder = true;
          continue;
        }
        const commanderId = inc.relationships?.commander_user?.data?.id;
        const commander = commanderId ? users.get(commanderId)?.attributes : undefined;
        const timeline = await readTimeline(client, connectionId, inc.id);
        const severity = fieldValue(a.fields, "severity");
        const state = fieldValue(a.fields, "state");
        signals.push({
          external_id: `incident:${inc.id}`,
          title: `${a.public_id != null ? `#${a.public_id} · ` : ""}${a.title ?? "Incident"}`,
          text: [
            `Severity: ${severity || "?"} · State: ${state || (a.resolved ? "resolved" : "active")}${a.customer_impacted ? " · Customer impacted" : ""}`,
            commander ? `Commander: ${commander.name ?? commander.handle ?? commander.email ?? commanderId}` : null,
            a.created ? `Created: ${a.created}${a.resolved ? ` · Resolved: ${a.resolved}` : ""}` : null,
            a.customer_impact_scope ? `Impact: ${a.customer_impact_scope}` : null,
            fieldValue(a.fields, "root_cause") ? `Root cause: ${fieldValue(a.fields, "root_cause")}` : null,
            fieldValue(a.fields, "summary") ? `Summary: ${fieldValue(a.fields, "summary")}` : null,
            timeline.length ? "" : null,
            ...timeline,
          ]
            .filter((x): x is string => x !== null)
            .join("\n"),
          url: a.public_id != null ? `${app}/incidents/${a.public_id}` : undefined,
          author: commander?.name ?? commander?.email,
          at: a.modified,
          kind_hint: "incident",
        });
        stats.incidents += 1;
        if (signals.length >= limit) break;
      }
      const next = res.data?.meta?.pagination?.next_offset;
      if (sawOlder || rows.length === 0 || next == null) break;
      offset = next;
    }

    // -- monitors ----------------------------------------------------------
    if (signals.length < limit) {
      const tags = allowList(config, "monitor_tags");
      const res = await client.proxy<DdMonitor[]>({
        method: "GET",
        providerConfigKey: "datadog",
        connectionId,
        path: "/v1/monitor",
        query: { page_size: 100, ...(tags ? { monitor_tags: tags.join(",") } : {}) },
      });
      if (!res.ok) throw new Error(`datadog monitors failed (${res.status})`);
      for (const m of Array.isArray(res.data) ? res.data : []) {
        if (!m.modified || new Date(m.modified) <= since) continue;
        signals.push({
          external_id: `monitor:${m.id}`,
          title: `Monitor · ${m.name ?? m.id}`,
          text: [
            `Type: ${m.type ?? "?"} · State: ${m.overall_state ?? "?"}${m.tags?.length ? ` · Tags: ${m.tags.join(", ")}` : ""}`,
            m.query ? `Query: ${m.query}` : null,
            "",
            clip(m.message ?? ""),
          ]
            .filter((x): x is string => x !== null)
            .join("\n"),
          url: `${app}/monitors/${m.id}`,
          author: m.creator?.name ?? m.creator?.email,
          at: m.modified,
          kind_hint: "monitor",
        });
        stats.monitors += 1;
        if (signals.length >= limit) break;
      }
    }

    // -- events ------------------------------------------------------------
    if (signals.length < limit) {
      const res = await client.proxy<{ events?: DdEvent[] }>({
        method: "GET",
        providerConfigKey: "datadog",
        connectionId,
        path: "/v1/events",
        query: { start: epochSeconds(since), end: epochSeconds(new Date()), priority: "normal", unaggregated: false },
      });
      if (!res.ok) throw new Error(`datadog events failed (${res.status})`);
      const events = (res.data?.events ?? []).slice(0, EVENTS_CAP);
      for (const ev of events) {
        const at = ev.date_happened ? new Date(ev.date_happened * 1000).toISOString() : undefined;
        signals.push({
          external_id: `event:${ev.id}`,
          title: ev.title ?? `Event ${ev.id}`,
          text: [
            `Source: ${ev.source ?? "?"}${ev.alert_type ? ` · ${ev.alert_type}` : ""}${ev.tags?.length ? ` · Tags: ${ev.tags.slice(0, 10).join(", ")}` : ""}`,
            "",
            clip(ev.text ?? "", 3000),
          ].join("\n"),
          url: ev.url ? (ev.url.startsWith("http") ? ev.url : `${app}${ev.url}`) : `${app}/event/event?id=${ev.id}`,
          at,
          kind_hint: "event",
        });
        stats.events += 1;
        if (signals.length >= limit) break;
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

async function readTimeline(client: FetchClient, connectionId: string, incidentId: string): Promise<string[]> {
  const res = await client.proxy<{ data?: DdTimelineCell[] }>({
    method: "GET",
    providerConfigKey: "datadog",
    connectionId,
    path: `/v2/incidents/${encodeURIComponent(incidentId)}/timeline`,
    query: { "page[size]": 50 },
  });
  if (!res.ok) return [];
  const cells = (res.data?.data ?? []).filter((c) => c.attributes?.content?.content);
  return cells.slice(-15).map((c) => {
    const a = c.attributes ?? {};
    const who = a.author?.name ?? a.author?.email ?? "someone";
    return `- ${who} (${a.created ?? ""})${a.content?.important ? " [important]" : ""}: ${clip(a.content?.content ?? "", 800)}`;
  });
}

type FetchClient = Parameters<NangoAdapter["fetchChanges"]>[0]["client"];

/**
 * Google Analytics — `google-analytics` → Nango `google-analytics` (OAuth2
 * via the `google` provider). The Nango entry has no proxy base of its own
 * (it inherits https://www.googleapis.com), so every call carries a
 * `Base-Url-Override` to the Admin API (https://analyticsadmin.googleapis.com)
 * or the Data API (https://analyticsdata.googleapis.com). GA4 only.
 *
 *   GET  /v1beta/accountSummaries                       → accounts + properties
 *   POST /v1beta/properties/{id}:batchRunReports        → totals, top pages,
 *                                                         top channels since the cursor
 *   POST /v1alpha/accounts/{id}:searchChangeHistoryEvents → what admins changed
 *                                                         (key events, streams,
 *                                                         custom dimensions, …)
 *
 * Signals: one traffic snapshot per property for the window since → today
 * (`traffic:<property>:<start>:<end>`; the numbers, never visitor data) and
 * the configuration changes per account per UTC day
 * (`changes:<account>:<day>`) with the actor's email — the only person in
 * any signal, and an admin of the account. `config.property_ids` narrows the
 * properties (`123` or `properties/123`).
 *
 * Scope: analytics.readonly. Assumptions (docs, not exercised live): the
 * `keyEvents` metric exists on every GA4 property (it replaced
 * `conversions` in 2024); `searchChangeHistoryEvents` is still v1alpha and
 * may answer 403 for viewers — tolerated, reported as
 * `stats.change_history_unavailable`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

export const GA_ADMIN_BASE = "https://analyticsadmin.googleapis.com";
export const GA_DATA_BASE = "https://analyticsdata.googleapis.com";

interface PropertySummary {
  property?: string;
  displayName?: string;
  propertyType?: string;
}
interface AccountSummary {
  account?: string;
  displayName?: string;
  propertySummaries?: PropertySummary[];
}
interface Report {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string; type?: string }>;
  rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
  rowCount?: number;
}
interface ChangeEvent {
  id?: string;
  changeTime?: string;
  actorType?: string;
  userActorEmail?: string;
  changesFiltered?: boolean;
  changes?: Array<{
    resource?: string;
    action?: string;
    resourceBeforeChange?: Record<string, unknown>;
    resourceAfterChange?: Record<string, unknown>;
  }>;
}

const MAX_PROPERTIES = 10;
const TOP_ROWS = 10;
const TOTAL_METRICS = ["activeUsers", "newUsers", "sessions", "screenPageViews", "keyEvents", "engagementRate", "averageSessionDuration"];

export function gaDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `properties/123` or `123` → `123`. */
export function gaPropertyId(raw: string): string {
  return raw.replace(/^properties\//, "");
}

export function gaPropertyUrl(propertyId: string): string {
  return `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/intelligenthome`;
}

export function gaReportRequests(startDate: string, endDate: string): unknown[] {
  const dateRanges = [{ startDate, endDate }];
  return [
    { dateRanges, metrics: TOTAL_METRICS.map((name) => ({ name })) },
    {
      dateRanges,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: TOP_ROWS,
    },
    {
      dateRanges,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: TOP_ROWS,
    },
  ];
}

function fmt(name: string, value: string | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value ?? "?";
  if (name === "engagementRate") return `${Math.round(n * 1000) / 10}%`;
  if (name === "averageSessionDuration") return `${Math.round(n)}s`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** The single row of a totals report → "activeUsers 1,234 · sessions 2,000 · …". */
export function gaTotalsLine(report: Report | undefined): string {
  const headers = report?.metricHeaders ?? [];
  const values = report?.rows?.[0]?.metricValues ?? [];
  if (!headers.length || !values.length) return "No traffic in the window";
  return headers.map((h, i) => `${h.name ?? "?"} ${fmt(h.name ?? "", values[i]?.value)}`).join(" · ");
}

/** A dimension report → "- <dimension>: m1 v1, m2 v2" lines. */
export function gaTopLines(report: Report | undefined): string[] {
  const metrics = report?.metricHeaders ?? [];
  return (report?.rows ?? []).map((row) => {
    const dim = row.dimensionValues?.[0]?.value ?? "?";
    const nums = metrics.map((m, i) => `${m.name ?? "?"} ${fmt(m.name ?? "", row.metricValues?.[i]?.value)}`).join(", ");
    return `- ${dim}: ${nums}`;
  });
}

export const googleAnalyticsAdapter: NangoAdapter = {
  id: "google-analytics",
  provider: "google-analytics",
  sourceHint: "google-analytics:properties",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const stats: Record<string, number> = { accounts: 0, properties: 0, change_events: 0 };
    const signals: IngestSignal[] = [];
    const now = new Date();
    const startDate = gaDay(since);
    const endDate = gaDay(now);

    const summaries = await client.proxy<{ accountSummaries?: AccountSummary[] }>({
      method: "GET",
      providerConfigKey: "google-analytics",
      connectionId,
      path: "/v1beta/accountSummaries",
      query: { pageSize: 50 },
      baseUrlOverride: GA_ADMIN_BASE,
    });
    if (!summaries.ok) throw new Error(`google-analytics accountSummaries failed (${summaries.status})`);
    const accounts = summaries.data?.accountSummaries ?? [];
    stats.accounts = accounts.length;

    const allowed = allowList(config, "property_ids")?.map(gaPropertyId) ?? null;
    const properties: Array<{ id: string; name: string; account: string }> = [];
    for (const a of accounts) {
      for (const p of a.propertySummaries ?? []) {
        const id = gaPropertyId(str(p.property));
        if (!id || (allowed && !allowed.includes(id))) continue;
        properties.push({ id, name: p.displayName || id, account: a.displayName || str(a.account) });
      }
    }
    stats.properties = Math.min(properties.length, MAX_PROPERTIES);

    for (const property of properties.slice(0, MAX_PROPERTIES)) {
      if (signals.length >= limit) break;
      const res = await client.proxy<{ reports?: Report[] }>({
        method: "POST",
        providerConfigKey: "google-analytics",
        connectionId,
        path: `/v1beta/properties/${encodeURIComponent(property.id)}:batchRunReports`,
        body: { requests: gaReportRequests(startDate, endDate) },
        baseUrlOverride: GA_DATA_BASE,
      });
      if (!res.ok) {
        stats.report_failed = (stats.report_failed ?? 0) + 1;
        continue;
      }
      const [totals, pages, channels] = res.data?.reports ?? [];
      const pageLines = gaTopLines(pages);
      const channelLines = gaTopLines(channels);
      signals.push({
        external_id: `traffic:${property.id}:${startDate}:${endDate}`,
        title: `${property.name} · traffic ${startDate} → ${endDate}`,
        text: clip(
          [
            `Property: ${property.name} (${property.id}) · Account: ${property.account}`,
            `Window: ${startDate} → ${endDate}`,
            `Totals: ${gaTotalsLine(totals)}`,
            pageLines.length ? ["", "Top pages:", ...pageLines].join("\n") : null,
            channelLines.length ? ["", "Channels:", ...channelLines].join("\n") : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
        ),
        url: gaPropertyUrl(property.id),
        at: now.toISOString(),
        kind_hint: "traffic_snapshot",
      });
    }

    // What admins changed in the accounts (v1alpha; tolerated to fail).
    for (const a of accounts) {
      if (signals.length >= limit) break;
      const accountId = str(a.account).replace(/^accounts\//, "");
      if (!accountId) continue;
      const res = await client.proxy<{ changeHistoryEvents?: ChangeEvent[] }>({
        method: "POST",
        providerConfigKey: "google-analytics",
        connectionId,
        path: `/v1alpha/accounts/${encodeURIComponent(accountId)}:searchChangeHistoryEvents`,
        body: { earliestChangeTime: since.toISOString(), pageSize: 100 },
        baseUrlOverride: GA_ADMIN_BASE,
      });
      if (!res.ok) {
        stats.change_history_unavailable = (stats.change_history_unavailable ?? 0) + 1;
        continue;
      }
      const byDay = new Map<string, ChangeEvent[]>();
      for (const e of res.data?.changeHistoryEvents ?? []) {
        if (!e.changeTime || new Date(e.changeTime) <= since) continue;
        stats.change_events = (stats.change_events ?? 0) + 1;
        const day = e.changeTime.slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), e]);
      }
      for (const [day, events] of byDay) {
        if (signals.length >= limit) break;
        events.sort((x, y) => str(x.changeTime).localeCompare(str(y.changeTime)));
        const actors = new Map<string, number>();
        const lines: string[] = [];
        for (const e of events) {
          const actor = e.userActorEmail || e.actorType || "system";
          actors.set(actor, (actors.get(actor) ?? 0) + 1);
          for (const c of e.changes ?? []) {
            const after = c.resourceAfterChange ? clip(JSON.stringify(c.resourceAfterChange), 300) : "";
            lines.push(`- ${e.changeTime ?? ""} · ${actor} · ${c.action ?? "?"} ${c.resource ?? "?"}${after ? ` → ${after}` : ""}`);
          }
        }
        const top = [...actors.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        signals.push({
          external_id: `changes:${accountId}:${day}`,
          title: `${a.displayName || accountId} · ${events.length} configuration change${events.length === 1 ? "" : "s"} on ${day}`,
          text: clip([`Account: ${a.displayName || accountId} · Actors: ${[...actors.keys()].join(", ")}`, "", ...lines].join("\n"), 12_000),
          url: `https://analytics.google.com/analytics/web/#/a${accountId}/admin/account/changehistory`,
          author: top,
          at: events[events.length - 1]!.changeTime,
          kind_hint: "config_change",
        });
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

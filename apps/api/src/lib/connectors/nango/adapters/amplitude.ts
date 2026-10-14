/**
 * Amplitude — `amplitude` → Nango `amplitude` (BASIC: project API key +
 * secret key; proxy base https://<connection_config.hostname> or
 * https://amplitude.com — EU projects set `analytics.eu.amplitude.com`).
 *
 * Reads, per run: annotations (dated notes on the charts — releases,
 * campaigns, incidents) dated on/after the cursor, and the current numbers
 * of the charts pinned in `config.chart_ids`, one signal per chart.
 *
 * Assumptions (docs, not exercised live): `/api/2/annotations` answers
 * `{ data: [{ id, date: "YYYY-MM-DD", label, details }] }`;
 * `/api/3/chart/{id}/query` answers `{ data: { series, seriesLabels,
 * xValues } }`. Chart URLs need the org slug, so none is emitted.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface AmpAnnotation {
  id: number | string;
  date?: string;
  label?: string;
  details?: string | null;
  app_id?: number | string;
}
interface AmpChartQuery {
  data?: {
    series?: unknown[];
    seriesLabels?: unknown[];
    seriesCollapsed?: unknown[];
    xValues?: unknown[];
  };
}

const MAX_CHARTS = 10;

/** "YYYY-MM-DD" → the start of that day (UTC); other strings parsed as-is. */
export function amplitudeDate(v?: string | null): Date | null {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function label(v: unknown): string {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(" / ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return str(v);
}

/** Series × last points → a few `label: x=v, …` lines. */
export function amplitudeChartText(chart: AmpChartQuery | undefined, maxSeries = 8, maxPoints = 8): string {
  const data = chart?.data ?? {};
  const series = Array.isArray(data.series) ? data.series : [];
  const labels = Array.isArray(data.seriesLabels) ? data.seriesLabels : [];
  const xs = Array.isArray(data.xValues) ? data.xValues : [];
  const lines: string[] = [];
  series.slice(0, maxSeries).forEach((s, i) => {
    const name = label(labels[i]) || `series ${i + 1}`;
    if (Array.isArray(s)) {
      const tail = s.slice(-maxPoints);
      const offset = s.length - tail.length;
      const points = tail.map((v, j) => {
        const x = xs[offset + j];
        const value = v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v;
        return x != null ? `${str(x)}=${str(value)}` : str(value);
      });
      lines.push(`${name}: ${points.join(", ")}`);
    } else {
      lines.push(`${name}: ${str(s)}`);
    }
  });
  const collapsed = Array.isArray(data.seriesCollapsed) ? data.seriesCollapsed : [];
  if (!lines.length && collapsed.length) lines.push(`totals: ${collapsed.map(label).join(", ")}`);
  return lines.join("\n");
}

export const amplitudeAdapter: NangoAdapter = {
  id: "amplitude",
  provider: "amplitude",
  sourceHint: "amplitude:product-analytics",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
      client.proxy<T>({ method: "GET", providerConfigKey: "amplitude", connectionId, path, query });
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { annotations: 0, charts: 0 };

    const ann = await get<{ data?: AmpAnnotation[] }>("/api/2/annotations");
    if (!ann.ok) throw new Error(`amplitude annotations failed (${ann.status})`);
    for (const a of ann.data?.data ?? []) {
      const at = amplitudeDate(a.date);
      if (!at || at < since) continue;
      stats.annotations = (stats.annotations ?? 0) + 1;
      signals.push({
        external_id: `annotation:${a.id}`,
        title: `Annotation: ${clip(a.label ?? "", 80).replace(/\n/g, " ")}`,
        text: [`Date: ${a.date ?? "?"}${a.app_id != null ? ` · Project: ${a.app_id}` : ""}`, "", clip(a.details ?? a.label ?? "")].join("\n"),
        at: at.toISOString(),
        kind_hint: "annotation",
      });
      if (signals.length >= limit) return { signals, stats };
    }

    const charts = allowList(config, "chart_ids") ?? [];
    const now = new Date().toISOString();
    for (const id of charts.slice(0, MAX_CHARTS)) {
      const res = await get<AmpChartQuery>(`/api/3/chart/${encodeURIComponent(id)}/query`);
      if (!res.ok) {
        stats.chart_errors = (stats.chart_errors ?? 0) + 1;
        continue;
      }
      const numbers = amplitudeChartText(res.data);
      if (!numbers) continue;
      stats.charts = (stats.charts ?? 0) + 1;
      signals.push({
        external_id: `chart:${id}`,
        title: `Chart ${id} snapshot`,
        text: [`Snapshot at: ${now}`, "", clip(numbers, 3000)].join("\n"),
        at: now,
        kind_hint: "chart",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

/**
 * Mixpanel — `mixpanel` → Nango `mixpanel` (BASIC: service account username
 * + secret; proxy base https://mixpanel.com). `config.project_id` is
 * required — a service account can span projects and the API is per project.
 *
 * Reads, per run: annotations (the dated notes a team leaves on the
 * timeline — launches, incidents, experiments) created on/after the cursor,
 * and saved reports ("bookmarks") modified since, each with a compact
 * snapshot of its current numbers from the Insights query API.
 *
 * Assumptions (docs, not exercised live): `/api/app/projects/{id}/annotations`
 * and `/bookmarks` answer `{ results: [...] }`; annotation `date` and
 * bookmark `modified` are "YYYY-MM-DD HH:MM:SS" (UTC); `/api/query/insights`
 * answers `{ computed_at, series: { <name>: { <date>: <value> } } }`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, str, type NangoAdapter } from "./shared";

interface MpUser {
  first_name?: string;
  last_name?: string;
  email?: string;
}
interface MpAnnotation {
  id: number | string;
  date?: string;
  description?: string;
  user?: MpUser | null;
}
interface MpBookmark {
  id: number | string;
  name?: string;
  description?: string | null;
  type?: string;
  modified?: string;
  creator_name?: string;
  creator?: MpUser | null;
}
interface MpList<T> {
  results?: T[];
}
interface MpInsights {
  computed_at?: string;
  series?: Record<string, Record<string, unknown> | unknown>;
}

const MAX_REPORTS = 10;

/** Mixpanel timestamps are "YYYY-MM-DD HH:MM:SS" without a zone; treat as UTC. */
export function mixpanelDate(v?: string | null): Date | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function who(u?: MpUser | null): string | undefined {
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ");
  return name || u?.email || undefined;
}

/** `{ series: { Signups: { "2026-09-01": 12, ... } } }` → a few lines of numbers. */
export function mixpanelSeriesText(insights: MpInsights | undefined, maxSeries = 8, maxPoints = 8): string {
  const series = insights?.series ?? {};
  const lines: string[] = [];
  for (const [name, points] of Object.entries(series).slice(0, maxSeries)) {
    if (points && typeof points === "object") {
      const entries = Object.entries(points as Record<string, unknown>).slice(-maxPoints);
      lines.push(`${name}: ${entries.map(([k, v]) => `${k}=${str(v)}`).join(", ")}`);
    } else {
      lines.push(`${name}: ${str(points)}`);
    }
  }
  return lines.join("\n");
}

export const mixpanelAdapter: NangoAdapter = {
  id: "mixpanel",
  provider: "mixpanel",
  sourceHint: "mixpanel:product-analytics",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const pid = configString(config, "project_id");
    if (!pid) return { signals: [], stats: { missing_project_id: 1 } };
    const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
      client.proxy<T>({ method: "GET", providerConfigKey: "mixpanel", connectionId, path, query });
    const projectUrl = `https://mixpanel.com/project/${encodeURIComponent(pid)}`;
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { annotations: 0, reports: 0 };

    const ann = await get<MpList<MpAnnotation>>(`/api/app/projects/${encodeURIComponent(pid)}/annotations`);
    if (!ann.ok) throw new Error(`mixpanel annotations failed (${ann.status})`);
    for (const a of ann.data?.results ?? []) {
      const at = mixpanelDate(a.date);
      if (!at || at < since) continue;
      stats.annotations = (stats.annotations ?? 0) + 1;
      signals.push({
        external_id: `annotation:${pid}:${a.id}`,
        title: `Annotation: ${clip(a.description ?? "", 80).replace(/\n/g, " ")}`,
        text: [`Marked at: ${a.date ?? "?"}`, "", clip(a.description ?? "")].join("\n"),
        url: projectUrl,
        author: who(a.user),
        at: at.toISOString(),
        kind_hint: "annotation",
      });
      if (signals.length >= limit) return { signals, stats };
    }

    const bm = await get<MpList<MpBookmark>>(`/api/app/projects/${encodeURIComponent(pid)}/bookmarks`);
    if (!bm.ok) throw new Error(`mixpanel bookmarks failed (${bm.status})`);
    const changed = (bm.data?.results ?? [])
      .map((b) => ({ b, at: mixpanelDate(b.modified) }))
      .filter((x): x is { b: MpBookmark; at: Date } => !!x.at && x.at > since)
      .sort((x, y) => y.at.getTime() - x.at.getTime())
      .slice(0, MAX_REPORTS);
    for (const { b, at } of changed) {
      const insights = await get<MpInsights>("/api/query/insights", { project_id: pid, bookmark_id: String(b.id) });
      const numbers = insights.ok ? mixpanelSeriesText(insights.data) : "";
      stats.reports = (stats.reports ?? 0) + 1;
      signals.push({
        external_id: `report:${pid}:${b.id}`,
        title: `Report: ${b.name ?? String(b.id)}`,
        text: [
          `Type: ${b.type ?? "report"} · Modified: ${b.modified ?? "?"}${insights.data?.computed_at ? ` · Computed: ${insights.data.computed_at}` : ""}`,
          b.description ? "" : null,
          b.description ? clip(b.description, 1500) : null,
          numbers ? "" : null,
          numbers ? clip(numbers, 3000) : null,
        ]
          .filter((l): l is string => l !== null)
          .join("\n"),
        url: projectUrl,
        author: b.creator_name || who(b.creator),
        at: at.toISOString(),
        kind_hint: "report",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

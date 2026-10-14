/**
 * Power BI — `microsoft-power-bi` → Nango `microsoft-power-bi` (alias of
 * the `microsoft` OAuth2 provider; proxy base https://api.powerbi.com).
 *
 * The REST API has no "modified since" on reports or dashboards, so the
 * inventory is emitted every run with stable ids (`report:<id>`,
 * `dashboard:<id>`, `at` = cursor) and dedupe keeps the graph quiet; what
 * actually changes between runs is the dataset refresh history:
 * `/datasets/{id}/refreshes?$top=5` yields one signal per refresh that
 * ended after the cursor, failures carrying the service exception so NEXO
 * can file them as bugs.
 *
 * Install config: `workspace_ids` (Power BI groups; default = "my
 * workspace" endpoints under `/myorg`). Scopes: Report.Read.All,
 * Dashboard.Read.All, Dataset.Read.All.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { NangoClient } from "@/lib/nango/client";
import { allowList, clip, type NangoAdapter } from "./shared";

const KEY = "microsoft-power-bi";
const MAX_DATASETS = 20;

interface Report {
  id: string;
  name?: string;
  webUrl?: string;
  datasetId?: string;
  reportType?: string;
}
interface Dashboard {
  id: string;
  displayName?: string;
  webUrl?: string;
}
interface Dataset {
  id: string;
  name?: string;
  webUrl?: string;
  configuredBy?: string;
}
export interface Refresh {
  requestId?: string;
  id?: number;
  refreshType?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  serviceExceptionJson?: string;
}

/** `serviceExceptionJson` → one line, or "" when absent/unparseable. */
export function refreshError(r: Refresh): string {
  if (!r.serviceExceptionJson) return "";
  try {
    const j = JSON.parse(r.serviceExceptionJson) as { errorCode?: string; errorDescription?: string };
    return [j.errorCode, j.errorDescription].filter(Boolean).join(": ") || r.serviceExceptionJson.slice(0, 300);
  } catch {
    return r.serviceExceptionJson.slice(0, 300);
  }
}

async function list<T>(client: NangoClient, connectionId: string, path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T[]> {
  const res = await client.proxy<{ value?: T[] }>({ method: "GET", providerConfigKey: KEY, connectionId, path, ...(query ? { query } : {}) });
  return res.ok ? (res.data?.value ?? []) : [];
}

export const microsoftPowerBiAdapter: NangoAdapter = {
  id: KEY,
  provider: "microsoft-power-bi",
  sourceHint: "power-bi:refreshes",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const groups = allowList(config, "workspace_ids");
    const roots = groups ? groups.slice(0, 5).map((g) => `/v1.0/myorg/groups/${encodeURIComponent(g)}`) : ["/v1.0/myorg"];
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { reports: 0, dashboards: 0, datasets: 0, refreshes: 0, failed: 0 };
    const at = since.toISOString();
    for (const root of roots) {
      const scope = root === "/v1.0/myorg" ? "My workspace" : `Workspace ${root.split("/").pop()}`;
      for (const r of await list<Report>(client, connectionId, `${root}/reports`)) {
        stats.reports = (stats.reports ?? 0) + 1;
        signals.push({
          external_id: `report:${r.id}`,
          title: r.name ?? r.id,
          text: `Power BI report · ${scope}${r.reportType ? ` · ${r.reportType}` : ""}${r.datasetId ? ` · Dataset: ${r.datasetId}` : ""}`,
          url: r.webUrl,
          at,
          kind_hint: "report",
        });
      }
      for (const d of await list<Dashboard>(client, connectionId, `${root}/dashboards`)) {
        stats.dashboards = (stats.dashboards ?? 0) + 1;
        signals.push({
          external_id: `dashboard:${d.id}`,
          title: d.displayName ?? d.id,
          text: `Power BI dashboard · ${scope}`,
          url: d.webUrl,
          at,
          kind_hint: "dashboard",
        });
      }
      const datasets = await list<Dataset>(client, connectionId, `${root}/datasets`);
      for (const ds of datasets.slice(0, MAX_DATASETS)) {
        stats.datasets = (stats.datasets ?? 0) + 1;
        const refreshes = await list<Refresh>(client, connectionId, `${root}/datasets/${encodeURIComponent(ds.id)}/refreshes`, { $top: 5 });
        for (const rf of refreshes) {
          const ended = rf.endTime ? Date.parse(rf.endTime) : NaN;
          if (Number.isNaN(ended) || ended <= since.getTime()) continue;
          const failed = rf.status === "Failed";
          const error = failed ? refreshError(rf) : "";
          stats.refreshes = (stats.refreshes ?? 0) + 1;
          if (failed) stats.failed = (stats.failed ?? 0) + 1;
          signals.push({
            external_id: `refresh:${ds.id}:${rf.requestId ?? rf.id ?? rf.startTime ?? rf.endTime}`,
            title: `${ds.name ?? ds.id} · refresh ${rf.status ?? "?"}`,
            text: clip(
              [
                `Dataset: ${ds.name ?? ds.id} · ${scope}${ds.configuredBy ? ` · Configured by: ${ds.configuredBy}` : ""}`,
                `Refresh ${rf.refreshType ?? ""} ${rf.status ?? "?"} · Started: ${rf.startTime ?? "?"} · Ended: ${rf.endTime ?? "?"}`,
                error ? `Error: ${error}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
              4000,
            ),
            url: ds.webUrl,
            author: ds.configuredBy,
            at: rf.endTime,
            kind_hint: failed ? "incident" : "refresh",
          });
        }
      }
    }
    // Failures first so the cap never drops them behind the inventory.
    signals.sort((a, b) => Number(b.kind_hint === "incident") - Number(a.kind_hint === "incident"));
    return { signals: signals.slice(0, limit), stats };
  },
};

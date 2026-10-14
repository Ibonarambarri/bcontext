/**
 * Grafana — `grafana` → Nango `grafana` (API_KEY: service-account token;
 * connection_config.domain, e.g. acme.grafana.net; proxy base https://<domain>).
 *
 * What changed since the cursor:
 *   - annotations in the window (`GET /api/annotations?from&to`), alert
 *     state changes included,
 *   - dashboards changed: `GET /api/search?type=dash-db` lists them without
 *     an updated stamp, so each candidate is read with
 *     `GET /api/dashboards/uid/{uid}` and kept when `meta.updated > since`;
 *     `config.dashboard_uids` narrows the list, otherwise the first
 *     DASHBOARD_READS results are inspected per run (documented cap),
 *   - alerts firing since the cursor (`GET /api/alertmanager/grafana/api/v2/alerts`).
 * Assumption to confirm: unified alerting is enabled (the alertmanager
 * endpoint answers 404 on legacy alerting — tolerated, counted in stats).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface GrafanaAnnotation {
  id: number;
  dashboardUID?: string;
  panelId?: number;
  time?: number;
  timeEnd?: number;
  text?: string;
  tags?: string[];
  login?: string;
  email?: string;
  alertId?: number;
  alertName?: string;
  newState?: string;
  prevState?: string;
}

interface GrafanaSearchHit {
  uid: string;
  title?: string;
  url?: string;
  folderTitle?: string;
  type?: string;
}

interface GrafanaDashboard {
  meta?: { updated?: string; updatedBy?: string; version?: number; url?: string; folderTitle?: string };
  dashboard?: { title?: string; description?: string; tags?: string[]; panels?: Array<{ title?: string; description?: string; type?: string }> };
}

interface GrafanaAlert {
  fingerprint?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  status?: { state?: string };
  generatorURL?: string;
}

const DASHBOARD_READS = 40;

export const grafanaAdapter: NangoAdapter = {
  id: "grafana",
  provider: "grafana",
  sourceHint: "grafana:annotations+dashboards+alerts",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const base = `https://${str(connectionConfig.domain).replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
    const signals: IngestSignal[] = [];
    const stats = { annotations: 0, dashboards: 0, dashboards_read: 0, alerts: 0, alerts_unavailable: 0 };

    // -- annotations -------------------------------------------------------
    const ann = await client.proxy<GrafanaAnnotation[]>({
      method: "GET",
      providerConfigKey: "grafana",
      connectionId,
      path: "/api/annotations",
      query: { from: since.getTime(), to: Date.now(), limit: 100 },
    });
    if (!ann.ok) throw new Error(`grafana annotations failed (${ann.status})`);
    for (const a of Array.isArray(ann.data) ? ann.data : []) {
      const isAlert = !!a.alertId && a.alertId > 0;
      signals.push({
        external_id: `annotation:${a.id}`,
        title: isAlert ? `Alert · ${a.alertName ?? a.alertId}` : `Annotation · ${clip(a.text ?? "", 80).replace(/\n/g, " ")}`,
        text: [
          isAlert ? `State: ${a.prevState ?? "?"} → ${a.newState ?? "?"}` : null,
          a.tags?.length ? `Tags: ${a.tags.join(", ")}` : null,
          a.timeEnd && a.time && a.timeEnd > a.time ? `Window: ${new Date(a.time).toISOString()} → ${new Date(a.timeEnd).toISOString()}` : null,
          "",
          clip(a.text ?? "", 3000),
        ]
          .filter((x): x is string => x !== null)
          .join("\n"),
        url: a.dashboardUID ? `${base}/d/${a.dashboardUID}${a.panelId ? `?viewPanel=${a.panelId}` : ""}` : undefined,
        author: a.login ?? a.email,
        at: a.time ? new Date(a.time).toISOString() : undefined,
        kind_hint: isAlert ? "alert" : "annotation",
      });
      stats.annotations += 1;
      if (signals.length >= limit) return { signals: signals.slice(0, limit), stats };
    }

    // -- dashboards --------------------------------------------------------
    const pinned = allowList(config, "dashboard_uids");
    let uids: string[];
    if (pinned) {
      uids = pinned.slice(0, DASHBOARD_READS);
    } else {
      const search = await client.proxy<GrafanaSearchHit[]>({
        method: "GET",
        providerConfigKey: "grafana",
        connectionId,
        path: "/api/search",
        query: { type: "dash-db", limit: DASHBOARD_READS },
      });
      if (!search.ok) throw new Error(`grafana search failed (${search.status})`);
      uids = (Array.isArray(search.data) ? search.data : []).map((h) => h.uid).filter(Boolean);
    }
    for (const uid of uids) {
      const res = await client.proxy<GrafanaDashboard>({
        method: "GET",
        providerConfigKey: "grafana",
        connectionId,
        path: `/api/dashboards/uid/${encodeURIComponent(uid)}`,
      });
      stats.dashboards_read += 1;
      if (!res.ok) continue;
      const updated = res.data?.meta?.updated;
      if (!updated || new Date(updated) <= since) continue;
      const d = res.data?.dashboard ?? {};
      const panels = (d.panels ?? []).filter((p) => p.title).slice(0, 30);
      signals.push({
        external_id: `dashboard:${uid}`,
        title: `Dashboard · ${d.title ?? uid}`,
        text: [
          `Version: ${res.data?.meta?.version ?? "?"}${res.data?.meta?.folderTitle ? ` · Folder: ${res.data.meta.folderTitle}` : ""}${d.tags?.length ? ` · Tags: ${d.tags.join(", ")}` : ""}`,
          d.description ? `Description: ${clip(d.description, 1000)}` : null,
          panels.length ? `Panels: ${panels.map((p) => (p.description ? `${p.title} (${clip(p.description, 120)})` : p.title)).join("; ")}` : null,
        ]
          .filter((x): x is string => x !== null)
          .join("\n"),
        url: res.data?.meta?.url ? `${base}${res.data.meta.url}` : `${base}/d/${uid}`,
        author: res.data?.meta?.updatedBy,
        at: updated,
        kind_hint: "dashboard",
      });
      stats.dashboards += 1;
      if (signals.length >= limit) return { signals: signals.slice(0, limit), stats };
    }

    // -- alerts ------------------------------------------------------------
    const alerts = await client.proxy<GrafanaAlert[]>({
      method: "GET",
      providerConfigKey: "grafana",
      connectionId,
      path: "/api/alertmanager/grafana/api/v2/alerts",
      query: { active: true, silenced: false, inhibited: false },
    });
    if (alerts.ok) {
      for (const al of Array.isArray(alerts.data) ? alerts.data : []) {
        if (!al.startsAt || new Date(al.startsAt) <= since) continue;
        const name = al.labels?.alertname ?? "alert";
        const labels = Object.entries(al.labels ?? {})
          .filter(([k]) => k !== "alertname")
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        signals.push({
          external_id: `alert:${al.fingerprint ?? `${name}:${al.startsAt}`}`,
          title: `Firing · ${name}`,
          text: [
            `State: ${al.status?.state ?? "?"} · Since: ${al.startsAt}${labels ? ` · ${labels}` : ""}`,
            al.annotations?.summary ? `Summary: ${al.annotations.summary}` : null,
            al.annotations?.description ? clip(al.annotations.description, 2000) : null,
          ]
            .filter((x): x is string => x !== null)
            .join("\n"),
          url: al.generatorURL,
          at: al.startsAt,
          kind_hint: "alert",
        });
        stats.alerts += 1;
        if (signals.length >= limit) break;
      }
    } else {
      stats.alerts_unavailable = 1;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

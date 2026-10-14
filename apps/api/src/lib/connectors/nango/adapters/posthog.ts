/**
 * PostHog — `posthog` → Nango `posthog` (API_KEY: personal API key;
 * proxy base https://<connection_config.subdomain>.posthog.com, e.g. `us`,
 * `eu` or `app`). Per project (`config.project_ids`, default: every project
 * the key lists): annotations, saved insights and feature flags changed since
 * the cursor — where product decisions and experiments are recorded.
 *
 * Assumptions: list endpoints are DRF pages `{ results, next }`; annotations
 * carry `date_marker` + `created_at`, insights `last_modified_at`, feature
 * flags `updated_at` (falling back to `created_at`). Filtering is
 * client-side on the first page (100 / 50 / 100 items), newest first.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, subdomain, type NangoAdapter } from "./shared";

interface PhProject {
  id: number | string;
  name?: string;
}
interface PhUser {
  first_name?: string;
  email?: string;
}
interface PhAnnotation {
  id: number | string;
  content?: string;
  date_marker?: string;
  created_at?: string;
  scope?: string;
  created_by?: PhUser | null;
}
interface PhInsight {
  id: number | string;
  short_id?: string;
  name?: string | null;
  derived_name?: string | null;
  description?: string | null;
  last_modified_at?: string;
  last_modified_by?: PhUser | null;
  tags?: string[];
}
interface PhFlag {
  id: number | string;
  key?: string;
  name?: string;
  active?: boolean;
  created_at?: string;
  updated_at?: string;
  created_by?: PhUser | null;
  rollout_percentage?: number | null;
  filters?: { groups?: Array<{ rollout_percentage?: number | null }> };
}
interface PhPage<T> {
  results?: T[];
}

const MAX_PROJECTS = 10;

function who(u?: PhUser | null): string | undefined {
  return u?.first_name || u?.email || undefined;
}

export function posthogProjectUrl(connectionConfig: Record<string, unknown>, projectId: string | number): string {
  return `https://${subdomain(connectionConfig) || "app"}.posthog.com/project/${projectId}`;
}

export const posthogAdapter: NangoAdapter = {
  id: "posthog",
  provider: "posthog",
  sourceHint: "posthog:product",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
      client.proxy<T>({ method: "GET", providerConfigKey: "posthog", connectionId, path, query });

    let projects: PhProject[];
    const allowed = allowList(config, "project_ids");
    if (allowed) {
      projects = allowed.map((id) => ({ id }));
    } else {
      const res = await get<PhPage<PhProject>>("/api/projects/");
      if (!res.ok) throw new Error(`posthog projects failed (${res.status})`);
      projects = res.data?.results ?? [];
    }

    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { projects: projects.length, annotations: 0, insights: 0, feature_flags: 0 };
    const after = (iso?: string | null) => !!iso && new Date(iso) > since;
    for (const project of projects.slice(0, MAX_PROJECTS)) {
      if (signals.length >= limit) break;
      const pid = str(project.id);
      const base = `/api/projects/${encodeURIComponent(pid)}`;
      const url = posthogProjectUrl(connectionConfig, pid);
      const label = project.name ? ` (${project.name})` : "";

      const ann = await get<PhPage<PhAnnotation>>(`${base}/annotations/`, { limit: 100 });
      if (!ann.ok) throw new Error(`posthog annotations failed (${ann.status})`);
      for (const a of ann.data?.results ?? []) {
        const at = a.created_at ?? a.date_marker;
        if (!after(at) && !after(a.date_marker)) continue;
        stats.annotations = (stats.annotations ?? 0) + 1;
        signals.push({
          external_id: `annotation:${pid}:${a.id}`,
          title: `Annotation${label}: ${clip(a.content ?? "", 80).replace(/\n/g, " ")}`,
          text: [`Marked at: ${a.date_marker ?? "?"} · Scope: ${a.scope ?? "?"}`, "", clip(a.content ?? "")].join("\n"),
          url: `${url}/annotations`,
          author: who(a.created_by),
          at,
          kind_hint: "annotation",
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;

      const ins = await get<PhPage<PhInsight>>(`${base}/insights/`, { order: "-last_modified_at", limit: 50, saved: true });
      if (!ins.ok) throw new Error(`posthog insights failed (${ins.status})`);
      for (const i of ins.data?.results ?? []) {
        if (!after(i.last_modified_at)) continue;
        stats.insights = (stats.insights ?? 0) + 1;
        signals.push({
          external_id: `insight:${pid}:${i.id}`,
          title: `Insight${label}: ${i.name || i.derived_name || i.short_id || String(i.id)}`,
          text: [
            `Modified: ${i.last_modified_at ?? "?"}${i.tags?.length ? ` · Tags: ${i.tags.join(", ")}` : ""}`,
            "",
            clip(i.description ?? ""),
          ].join("\n"),
          url: i.short_id ? `${url}/insights/${i.short_id}` : `${url}/insights`,
          author: who(i.last_modified_by),
          at: i.last_modified_at,
          kind_hint: "insight",
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;

      const flags = await get<PhPage<PhFlag>>(`${base}/feature_flags/`, { limit: 100 });
      if (!flags.ok) throw new Error(`posthog feature flags failed (${flags.status})`);
      for (const f of flags.data?.results ?? []) {
        const at = f.updated_at ?? f.created_at;
        if (!after(at)) continue;
        stats.feature_flags = (stats.feature_flags ?? 0) + 1;
        const rollout = f.rollout_percentage ?? f.filters?.groups?.[0]?.rollout_percentage;
        signals.push({
          external_id: `feature_flag:${pid}:${f.id}`,
          title: `Feature flag${label}: ${f.key ?? String(f.id)}`,
          text: [
            `Active: ${f.active ? "yes" : "no"}${rollout != null ? ` · Rollout: ${rollout}%` : ""} · Changed: ${at ?? "?"}`,
            "",
            clip(f.name ?? ""),
          ].join("\n"),
          url: `${url}/feature_flags/${f.id}`,
          author: who(f.created_by),
          at,
          kind_hint: "feature_flag",
        });
        if (signals.length >= limit) break;
      }
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

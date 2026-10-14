/**
 * GitLab — `gitlab` → Nango `gitlab-pat` (API_KEY: personal access token;
 * connection_config.hostname, e.g. gitlab.com or a self-managed host).
 * Merge requests and issues updated since the cursor, across every project
 * the token can see or only `config.projects` (ids or URL-encoded paths).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface GitLabItem {
  id: number;
  iid: number;
  title?: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  updated_at?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  labels?: string[];
  author?: { name?: string; username?: string };
  references?: { full?: string };
  project_id?: number;
}

const KINDS: Array<{ resource: "merge_requests" | "issues"; kind: string; prefix: string }> = [
  { resource: "merge_requests", kind: "merge_request", prefix: "!" },
  { resource: "issues", kind: "issue", prefix: "#" },
];

export const gitlabAdapter: NangoAdapter = {
  id: "gitlab",
  provider: "gitlab-pat",
  sourceHint: "gitlab:changes",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const projects = allowList(config, "projects");
    const scopes: Array<string | null> = projects ? projects.slice(0, 10) : [null];
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    for (const project of scopes) {
      for (const { resource, kind, prefix } of KINDS) {
        const path = project
          ? `/api/v4/projects/${encodeURIComponent(project)}/${resource}`
          : `/api/v4/${resource}`;
        const res = await client.proxy<GitLabItem[]>({
          method: "GET",
          providerConfigKey: "gitlab",
          connectionId,
          path,
          query: {
            scope: "all",
            updated_after: since.toISOString(),
            order_by: "updated_at",
            sort: "desc",
            per_page: Math.min(50, limit),
          },
        });
        if (!res.ok) throw new Error(`gitlab ${resource} failed (${res.status})`);
        const rows = Array.isArray(res.data) ? res.data : [];
        stats[resource] = (stats[resource] ?? 0) + rows.length;
        for (const it of rows) {
          const ref = it.references?.full ?? `${prefix}${it.iid}`;
          const state = it.merged_at ? "merged" : (it.state ?? "?");
          signals.push({
            external_id: `${kind}:${it.id}`,
            title: `${ref} · ${it.title ?? ""}`.trim(),
            text: [
              `State: ${state}${it.labels?.length ? ` · Labels: ${it.labels.join(", ")}` : ""}`,
              "",
              clip(it.description ?? ""),
            ].join("\n"),
            url: it.web_url,
            author: it.author?.name ?? it.author?.username,
            at: it.updated_at,
            kind_hint: kind,
          });
          if (signals.length >= limit) break;
        }
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

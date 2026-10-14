/**
 * Vercel — `vercel` → Nango `vercel` (API_KEY: account/team token; proxy
 * base https://api.vercel.com).
 *
 * What changed since the cursor: deployments created after `since`
 * (`GET /v6/deployments?since=<ms>&state=READY,ERROR`, paged with
 * `pagination.next` → `until`), kept when they failed or when they reached
 * production, grouped into ONE signal per project (the batch extractor
 * wants "what shipped / what broke", not one node per build). Project
 * links come from `GET /v9/projects` (tolerated to fail). `config.team_id`
 * scopes the token to a team, `config.projects` is a name allow-list.
 * Assumption to confirm: `state` accepts a comma-separated list on v6.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface VercelDeployment {
  uid: string;
  name?: string;
  url?: string;
  state?: string;
  readyState?: string;
  target?: string | null;
  created?: number;
  createdAt?: number;
  ready?: number;
  inspectorUrl?: string;
  creator?: { username?: string; email?: string };
  meta?: Record<string, string | undefined>;
}

interface VercelProject {
  id: string;
  name?: string;
  link?: { type?: string; org?: string; repo?: string };
  framework?: string | null;
}

const PAGES = 3;

export const vercelAdapter: NangoAdapter = {
  id: "vercel",
  provider: "vercel",
  sourceHint: "vercel:deployments",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const teamId = configString(config, "team_id");
    const allowed = allowList(config, "projects");
    const scope = teamId ? { teamId } : {};

    const projects = new Map<string, VercelProject>();
    const pr = await client.proxy<{ projects?: VercelProject[] }>({
      method: "GET",
      providerConfigKey: "vercel",
      connectionId,
      path: "/v9/projects",
      query: { limit: 100, ...scope },
    });
    if (pr.ok) for (const p of pr.data?.projects ?? []) if (p.name) projects.set(p.name, p);

    const byProject = new Map<string, VercelDeployment[]>();
    let until: number | undefined;
    let pages = 0;
    let total = 0;
    do {
      const res = await client.proxy<{ deployments?: VercelDeployment[]; pagination?: { next?: number | null } }>({
        method: "GET",
        providerConfigKey: "vercel",
        connectionId,
        path: "/v6/deployments",
        query: { since: since.getTime(), limit: 100, state: "READY,ERROR", ...scope, ...(until ? { until } : {}) },
      });
      if (!res.ok) throw new Error(`vercel deployments failed (${res.status})`);
      const rows = res.data?.deployments ?? [];
      total += rows.length;
      for (const d of rows) {
        const name = d.name ?? "unknown";
        if (allowed && !allowed.includes(name)) continue;
        const state = d.readyState ?? d.state;
        const failed = state === "ERROR";
        const shipped = state === "READY" && d.target === "production";
        if (!failed && !shipped) continue;
        const createdAt = d.createdAt ?? d.created ?? 0;
        if (createdAt && createdAt <= since.getTime()) continue;
        const list = byProject.get(name) ?? [];
        list.push(d);
        byProject.set(name, list);
      }
      until = res.data?.pagination?.next ?? undefined;
      pages += 1;
    } while (until && pages < PAGES);

    const signals: IngestSignal[] = [];
    for (const [name, list] of byProject) {
      list.sort((a, b) => (b.createdAt ?? b.created ?? 0) - (a.createdAt ?? a.created ?? 0));
      const latest = list[0]!;
      const project = projects.get(name);
      const failures = list.filter((d) => (d.readyState ?? d.state) === "ERROR").length;
      const lines = list.slice(0, 25).map((d) => {
        const m = d.meta ?? {};
        const state = (d.readyState ?? d.state) === "ERROR" ? "FAILED" : "production";
        const when = new Date(d.createdAt ?? d.created ?? 0).toISOString();
        const commit = m.githubCommitMessage ?? m.gitlabCommitMessage ?? m.bitbucketCommitMessage ?? "";
        const author = m.githubCommitAuthorName ?? m.gitlabCommitAuthorName ?? d.creator?.username ?? d.creator?.email ?? "";
        const ref = m.githubCommitRef ?? m.gitlabCommitRef ?? m.bitbucketCommitRef ?? "";
        return `- ${when} · ${state}${ref ? ` · ${ref}` : ""}${author ? ` · ${author}` : ""}: ${clip(commit.split("\n")[0] ?? "", 200)}${d.url ? ` (https://${d.url})` : ""}`;
      });
      signals.push({
        external_id: `deployments:${name}:${latest.uid}`,
        title: `${name} · ${list.length} deployment${list.length === 1 ? "" : "s"}${failures ? `, ${failures} failed` : ""}`,
        text: [
          `Project: ${name}${project?.framework ? ` · ${project.framework}` : ""}${project?.link?.repo ? ` · ${project.link.org}/${project.link.repo}` : ""}`,
          "",
          ...lines,
        ].join("\n"),
        url: latest.inspectorUrl ?? (latest.url ? `https://${latest.url}` : undefined),
        author: latest.meta?.githubCommitAuthorName ?? latest.creator?.username ?? latest.creator?.email,
        at: new Date(latest.createdAt ?? latest.created ?? Date.now()).toISOString(),
        kind_hint: "deployment",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { deployments: total, projects: byProject.size, pages } };
  },
};

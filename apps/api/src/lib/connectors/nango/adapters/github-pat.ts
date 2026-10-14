/**
 * GitHub (token) — `github-pat` → Nango `github-pat` (API_KEY: personal
 * access token; connection_config.version = REST API version, Nango sends
 * 2022-11-28 by default; proxy base https://api.github.com).
 *
 * The token-based GitHub source for organisations that do not want the
 * GitHub App (the native `github` connector). Issues and pull requests
 * updated since the cursor:
 *   - with `config.repos` (owner/name): `GET /repos/{owner}/{repo}/issues?since`
 *     per repo (the endpoint returns pull requests too),
 *   - otherwise `GET /issues?filter=all&state=all&since` — everything the
 *     token's user created, is assigned to, mentioned in or subscribed to;
 *     when that is empty, `GET /search/issues?q=updated:>=<date> involves:@me`.
 * The last comments since the cursor are appended for the first
 * COMMENT_READS items (`GET /repos/{o}/{r}/issues/{n}/comments?since`).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface GhIssue {
  id: number;
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  html_url?: string;
  updated_at?: string;
  closed_at?: string | null;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }>;
  user?: { login?: string };
  pull_request?: { merged_at?: string | null; html_url?: string };
  repository_url?: string;
  repository?: { full_name?: string };
  comments?: number;
}

interface GhComment {
  id: number;
  body?: string;
  created_at?: string;
  user?: { login?: string };
}

const COMMENT_READS = 20;
const PAGES = 2;

/** "https://api.github.com/repos/acme/app" → "acme/app". */
export function repoFullName(issue: GhIssue): string {
  if (issue.repository?.full_name) return issue.repository.full_name;
  const m = (issue.repository_url ?? "").match(/\/repos\/([^/]+\/[^/]+)$/);
  return m?.[1] ?? "";
}

function labelNames(labels: GhIssue["labels"]): string[] {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
}

/**
 * One implementation, two integrations: `github-pat` (personal token) and
 * `github-nango` (OAuth through Nango, the twin of the native GitHub App
 * connector). `id` doubles as the Nango providerConfigKey.
 */
export function createGithubAdapter(opts: { id: string; provider: string }): NangoAdapter {
  const key = opts.id;
  return {
  id: opts.id,
  provider: opts.provider,
  sourceHint: "github:issues+pull-requests",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const repos = allowList(config, "repos");
    const items: GhIssue[] = [];
    const stats = { requests: 0, search_fallback: 0 };

    const list = async (path: string, query: Record<string, string | number | boolean | undefined>) => {
      for (let page = 1; page <= PAGES; page += 1) {
        const res = await client.proxy<GhIssue[]>({
          method: "GET",
          providerConfigKey: key,
          connectionId,
          path,
          query: { ...query, page, per_page: 100 },
        });
        stats.requests += 1;
        if (!res.ok) throw new Error(`github ${path} failed (${res.status})`);
        const rows = Array.isArray(res.data) ? res.data : [];
        items.push(...rows);
        if (rows.length < 100 || items.length >= limit) break;
      }
    };

    const common = { state: "all", since: since.toISOString(), sort: "updated", direction: "desc" };
    if (repos) {
      for (const repo of repos.slice(0, 20)) {
        await list(`/repos/${repo}/issues`, common);
        if (items.length >= limit) break;
      }
    } else {
      await list("/issues", { ...common, filter: "all" });
      if (items.length === 0) {
        const day = since.toISOString().slice(0, 10);
        const res = await client.proxy<{ items?: GhIssue[] }>({
          method: "GET",
          providerConfigKey: key,
          connectionId,
          path: "/search/issues",
          query: { q: `updated:>=${day} involves:@me`, sort: "updated", order: "desc", per_page: Math.min(100, limit) },
        });
        stats.requests += 1;
        stats.search_fallback = 1;
        if (res.ok) items.push(...(res.data?.items ?? []));
      }
    }

    const signals: IngestSignal[] = [];
    const seen = new Set<number>();
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      if (it.updated_at && new Date(it.updated_at) <= since) continue;
      const repo = repoFullName(it);
      const isPr = !!it.pull_request;
      const comments = signals.length < COMMENT_READS && repo && (it.comments ?? 1) > 0 ? await readComments(client, key, connectionId, repo, it.number, since) : [];
      const state = isPr && it.pull_request?.merged_at ? "merged" : (it.state ?? "?");
      signals.push({
        external_id: `${isPr ? "pr" : "issue"}:${it.id}`,
        title: `${repo ? `${repo}#${it.number}` : `#${it.number}`} · ${it.title ?? ""}`.trim(),
        text: [
          `${isPr ? "Pull request" : "Issue"} · State: ${state}${it.state_reason ? ` (${it.state_reason})` : ""}${labelNames(it.labels).length ? ` · Labels: ${labelNames(it.labels).join(", ")}` : ""}`,
          it.assignees?.length ? `Assignees: ${it.assignees.map((a) => a.login).filter(Boolean).join(", ")}` : null,
          "",
          clip(it.body ?? ""),
          comments.length ? "" : null,
          ...comments,
        ]
          .filter((x): x is string => x !== null)
          .join("\n"),
        url: it.html_url,
        author: it.user?.login,
        at: it.updated_at,
        kind_hint: isPr ? "pull_request" : "issue",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { ...stats, items: items.length } };
  },
  };
}

export const githubPatAdapter: NangoAdapter = createGithubAdapter({ id: "github-pat", provider: "github-pat" });

async function readComments(client: FetchClient, key: string, connectionId: string, repo: string, number: number, since: Date): Promise<string[]> {
  const res = await client.proxy<GhComment[]>({
    method: "GET",
    providerConfigKey: key,
    connectionId,
    path: `/repos/${repo}/issues/${number}/comments`,
    query: { since: since.toISOString(), per_page: 5 },
  });
  if (!res.ok) return [];
  return (Array.isArray(res.data) ? res.data : []).slice(-5).map((c) => `- ${c.user?.login ?? "someone"} (${c.created_at ?? ""}): ${clip(c.body ?? "", 800)}`);
}

type FetchClient = Parameters<NangoAdapter["fetchChanges"]>[0]["client"];

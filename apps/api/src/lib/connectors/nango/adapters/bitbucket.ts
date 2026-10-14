/**
 * Bitbucket Cloud — `bitbucket` → Nango `bitbucket` (OAuth2; proxy base
 * https://api.bitbucket.org). Pull requests updated since the cursor across
 * the repositories of one workspace (`config.workspace`, default: the first
 * workspace the token lists), optionally only `config.repos` (slugs), with
 * the last few comments of each PR.
 *
 * Assumptions (Bitbucket API 2.0): repositories are listed with
 * `role=member` sorted by `-updated_on` so repos untouched since the cursor
 * are skipped without a PR call; PR search uses the `q` filter language
 * (`updated_on > "<ISO>" AND (state = "MERGED" OR …)`); comments are
 * `/pullrequests/{id}/comments` sorted `-created_on`, capped to 5 and only
 * fetched for the first 20 PRs of a run to bound API calls.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface Page<T> {
  values?: T[];
  next?: string;
}
interface BbWorkspace {
  slug?: string;
  name?: string;
}
interface BbRepo {
  slug?: string;
  full_name?: string;
  updated_on?: string;
}
interface BbPullRequest {
  id: number;
  title?: string;
  description?: string;
  state?: string;
  updated_on?: string;
  created_on?: string;
  author?: { display_name?: string; nickname?: string };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  links?: { html?: { href?: string } };
  comment_count?: number;
}
interface BbComment {
  content?: { raw?: string };
  user?: { display_name?: string; nickname?: string };
  created_on?: string;
}

const MAX_REPOS = 30;
const MAX_COMMENT_FETCHES = 20;

/** The `q` filter Bitbucket wants for "updated since, any of these states". */
export function bitbucketPrQuery(since: Date): string {
  return `updated_on > "${since.toISOString()}" AND (state = "MERGED" OR state = "OPEN" OR state = "DECLINED")`;
}

export const bitbucketAdapter: NangoAdapter = {
  id: "bitbucket",
  provider: "bitbucket",
  sourceHint: "bitbucket:pull_requests",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
      client.proxy<T>({ method: "GET", providerConfigKey: "bitbucket", connectionId, path, query });

    let workspace = configString(config, "workspace");
    if (!workspace) {
      const ws = await get<Page<BbWorkspace>>("/2.0/workspaces", { pagelen: 10 });
      if (!ws.ok) throw new Error(`bitbucket workspaces failed (${ws.status})`);
      workspace = ws.data?.values?.[0]?.slug ?? null;
      if (!workspace) return { signals: [], stats: { workspaces: 0, repos: 0, pull_requests: 0 } };
    }

    const allowed = allowList(config, "repos");
    let repos: BbRepo[];
    if (allowed) {
      repos = allowed.slice(0, MAX_REPOS).map((slug) => ({ slug }));
    } else {
      const res = await get<Page<BbRepo>>(`/2.0/repositories/${encodeURIComponent(workspace)}`, {
        role: "member",
        sort: "-updated_on",
        pagelen: MAX_REPOS,
      });
      if (!res.ok) throw new Error(`bitbucket repositories failed (${res.status})`);
      // Sorted by -updated_on: everything after the first stale repo is stale too.
      repos = [];
      for (const r of res.data?.values ?? []) {
        if (r.updated_on && new Date(r.updated_on) <= since) break;
        repos.push(r);
      }
    }

    const signals: IngestSignal[] = [];
    let commentFetches = 0;
    let pullRequests = 0;
    for (const repo of repos) {
      if (!repo.slug || signals.length >= limit) continue;
      const base = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo.slug)}`;
      const prs = await get<Page<BbPullRequest>>(`${base}/pullrequests`, {
        q: bitbucketPrQuery(since),
        sort: "-updated_on",
        pagelen: Math.min(50, limit),
      });
      if (!prs.ok) throw new Error(`bitbucket pull requests failed (${prs.status})`);
      for (const pr of prs.data?.values ?? []) {
        pullRequests += 1;
        let comments = "";
        if (commentFetches < MAX_COMMENT_FETCHES && (pr.comment_count ?? 1) > 0) {
          commentFetches += 1;
          const c = await get<Page<BbComment>>(`${base}/pullrequests/${pr.id}/comments`, { sort: "-created_on", pagelen: 5 });
          if (c.ok) {
            comments = (c.data?.values ?? [])
              .filter((x) => x.content?.raw)
              .map((x) => `- ${x.user?.display_name ?? x.user?.nickname ?? "someone"} (${x.created_on ?? ""}): ${x.content?.raw?.trim()}`)
              .join("\n");
          }
        }
        const fullName = repo.full_name ?? `${workspace}/${repo.slug}`;
        signals.push({
          external_id: `pr:${fullName}:${pr.id}`,
          title: `${fullName} !${pr.id} · ${pr.title ?? ""}`.trim(),
          text: [
            `State: ${pr.state ?? "?"} · ${pr.source?.branch?.name ?? "?"} → ${pr.destination?.branch?.name ?? "?"}`,
            "",
            clip(pr.description ?? ""),
            comments ? `\nRecent comments:\n${comments}` : "",
          ].join("\n"),
          url: pr.links?.html?.href,
          author: pr.author?.display_name ?? pr.author?.nickname,
          at: pr.updated_on ?? pr.created_on,
          kind_hint: "pull_request",
        });
        if (signals.length >= limit) break;
      }
    }
    return { signals: signals.slice(0, limit), stats: { workspaces: 1, repos: repos.length, pull_requests: pullRequests } };
  },
};

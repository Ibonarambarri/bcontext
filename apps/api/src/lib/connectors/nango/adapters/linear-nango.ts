/**
 * Linear (via Nango) — `linear-nango` → Nango `linear` (OAuth2; proxy base
 * https://api.linear.app).
 *
 * The Nango-backed twin of the native `linear` connector (webhooks + two-way
 * status). One GraphQL call per page:
 *   issues(filter: { updatedAt: { gt: <since> } }, orderBy: updatedAt, first: 50, after)
 *     → identifier, title, description, state, team, project, assignee,
 *       labels, last 5 comments
 *   projectUpdates(filter: { updatedAt: { gt: <since> } }, first: 50)
 *     → health + body, one signal per update (first page only)
 * `config.teams` filters by team key or name, client-side.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { ProxyResponse } from "@/lib/nango/client";
import { allowList, clip, type NangoAdapter } from "./shared";

interface LinearIssue {
  id: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  updatedAt?: string;
  priorityLabel?: string;
  state?: { name?: string; type?: string } | null;
  team?: { key?: string; name?: string } | null;
  project?: { name?: string } | null;
  assignee?: { name?: string } | null;
  creator?: { name?: string } | null;
  labels?: { nodes?: Array<{ name?: string }> };
  comments?: { nodes?: Array<{ body?: string; createdAt?: string; user?: { name?: string } | null }> };
}

interface LinearProjectUpdate {
  id: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  health?: string;
  url?: string;
  user?: { name?: string } | null;
  project?: { name?: string; url?: string } | null;
}

interface LinearResponse {
  data?: {
    issues?: { nodes?: LinearIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
    projectUpdates?: { nodes?: LinearProjectUpdate[] };
  };
  errors?: Array<{ message?: string }>;
}

const PAGES = 3;

export const LINEAR_QUERY = `query Changed($since: DateTimeOrDuration!, $first: Int!, $after: String, $withUpdates: Boolean!) {
  issues(filter: { updatedAt: { gt: $since } }, orderBy: updatedAt, first: $first, after: $after) {
    nodes {
      id identifier title description url updatedAt priorityLabel
      state { name type }
      team { key name }
      project { name }
      assignee { name }
      creator { name }
      labels { nodes { name } }
      comments(last: 5) { nodes { body createdAt user { name } } }
    }
    pageInfo { hasNextPage endCursor }
  }
  projectUpdates(filter: { updatedAt: { gt: $since } }, first: 50) @include(if: $withUpdates) {
    nodes { id body createdAt updatedAt health url user { name } project { name url } }
  }
}`;

export const linearNangoAdapter: NangoAdapter = {
  id: "linear-nango",
  provider: "linear",
  sourceHint: "linear:issues+project-updates",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const teams = allowList(config, "teams")?.map((t) => t.toLowerCase()) ?? null;
    const signals: IngestSignal[] = [];
    const stats = { requests: 0, issues: 0, project_updates: 0 };
    let after: string | null = null;

    for (let page = 0; page < PAGES; page += 1) {
      const res: ProxyResponse<LinearResponse> = await client.proxy<LinearResponse>({
        method: "POST",
        providerConfigKey: "linear-nango",
        connectionId,
        path: "/graphql",
        body: { query: LINEAR_QUERY, variables: { since: since.toISOString(), first: 50, after, withUpdates: page === 0 } },
      });
      stats.requests += 1;
      if (!res.ok) throw new Error(`linear graphql failed (${res.status})`);
      if (res.data?.errors?.length) throw new Error(`linear graphql: ${res.data.errors.map((e) => e.message).join("; ")}`);

      for (const u of res.data?.data?.projectUpdates?.nodes ?? []) {
        stats.project_updates += 1;
        signals.push({
          external_id: `project-update:${u.id}`,
          title: `${u.project?.name ?? "Project"} · project update${u.health ? ` (${u.health})` : ""}`,
          text: clip(u.body ?? ""),
          url: u.url ?? u.project?.url,
          author: u.user?.name ?? undefined,
          at: u.updatedAt ?? u.createdAt,
          kind_hint: "project_update",
        });
      }

      for (const it of res.data?.data?.issues?.nodes ?? []) {
        const teamKey = it.team?.key?.toLowerCase() ?? "";
        const teamName = it.team?.name?.toLowerCase() ?? "";
        if (teams && !teams.includes(teamKey) && !teams.includes(teamName)) continue;
        stats.issues += 1;
        const labels = (it.labels?.nodes ?? []).map((l) => l.name).filter(Boolean);
        const comments = (it.comments?.nodes ?? []).map((c) => `- ${c.user?.name ?? "someone"} (${c.createdAt ?? ""}): ${clip(c.body ?? "", 800)}`);
        signals.push({
          external_id: `issue:${it.id}`,
          title: `${it.identifier ?? ""} · ${it.title ?? ""}`.trim(),
          text: [
            `Team: ${it.team?.name ?? it.team?.key ?? "?"} · State: ${it.state?.name ?? "?"}${it.state?.type ? ` (${it.state.type})` : ""} · Priority: ${it.priorityLabel ?? "?"}`,
            it.project?.name ? `Project: ${it.project.name}` : null,
            it.assignee?.name ? `Assignee: ${it.assignee.name}` : null,
            labels.length ? `Labels: ${labels.join(", ")}` : null,
            "",
            clip(it.description ?? ""),
            comments.length ? "" : null,
            ...comments,
          ]
            .filter((x): x is string => x !== null)
            .join("\n"),
          url: it.url,
          author: it.creator?.name ?? undefined,
          at: it.updatedAt,
          kind_hint: "issue",
        });
        if (signals.length >= limit) break;
      }

      const info: { hasNextPage?: boolean; endCursor?: string | null } | undefined = res.data?.data?.issues?.pageInfo;
      after = info?.hasNextPage && info.endCursor ? info.endCursor : null;
      if (!after || signals.length >= limit) break;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

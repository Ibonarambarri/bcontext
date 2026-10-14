/**
 * Jira — `jira` → Nango `jira-basic` (BASIC: email + API token;
 * connection_config.subdomain). Issues updated since the cursor, with the
 * last few comments, via the JQL search endpoint (`/search/jql`; the older
 * `/search` is being retired on Cloud).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { adfToText, allowList, jqlDate, subdomain, type NangoAdapter } from "./shared";

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    updated?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    comment?: { comments?: Array<{ author?: { displayName?: string }; body?: unknown; created?: string }> };
  };
}

export const jiraAdapter: NangoAdapter = {
  id: "jira",
  provider: "jira-basic",
  sourceHint: "jira:issues",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const projects = allowList(config, "projects");
    const jql = [
      projects ? `project in (${projects.map((p) => `"${p.replace(/"/g, "")}"`).join(",")})` : null,
      `updated >= "${jqlDate(since)}"`,
    ]
      .filter(Boolean)
      .join(" AND ") + " ORDER BY updated DESC";
    const signals: IngestSignal[] = [];
    let nextPageToken: string | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<{ issues?: JiraIssue[]; nextPageToken?: string }>({
        method: "GET",
        providerConfigKey: "jira",
        connectionId,
        path: "/rest/api/3/search/jql",
        query: {
          jql,
          maxResults: Math.min(50, limit),
          fields: "summary,description,updated,status,issuetype,priority,assignee,reporter,comment",
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      });
      if (!res.ok) throw new Error(`jira search failed (${res.status})`);
      for (const issue of res.data?.issues ?? []) {
        const f = issue.fields ?? {};
        const comments = (f.comment?.comments ?? [])
          .slice(-5)
          .map((c) => `- ${c.author?.displayName ?? "someone"} (${c.created ?? ""}): ${adfToText(c.body).trim()}`)
          .join("\n");
        signals.push({
          external_id: `issue:${issue.key}`,
          title: `${issue.key} · ${f.summary ?? ""}`.trim(),
          text: [
            `Type: ${f.issuetype?.name ?? "?"} · Status: ${f.status?.name ?? "?"} · Priority: ${f.priority?.name ?? "?"}`,
            f.assignee?.displayName ? `Assignee: ${f.assignee.displayName}` : null,
            "",
            adfToText(f.description).trim(),
            comments ? `\nRecent comments:\n${comments}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: subdomain(connectionConfig) ? `https://${subdomain(connectionConfig)}.atlassian.net/browse/${issue.key}` : undefined,
          author: f.reporter?.displayName,
          at: f.updated,
          kind_hint: "issue",
        });
      }
      nextPageToken = res.data?.nextPageToken;
      pages += 1;
    } while (nextPageToken && signals.length < limit && pages < 5);
    return { signals: signals.slice(0, limit), stats: { pages } };
  },
};

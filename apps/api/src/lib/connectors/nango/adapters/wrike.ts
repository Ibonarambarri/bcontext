/**
 * Wrike — `wrike` → Nango `wrike` (OAuth2; proxy base
 * https://<connection_config.host>/api/v4, e.g. www.wrike.com or a regional
 * host). Tasks updated since the cursor across the account, or only inside
 * the folders in `config.folders` (folder ids), newest first with
 * `nextPageToken` paging; the first 20 tasks also carry their comments.
 *
 * Assumptions to check live: `updatedDate` accepts a JSON `{start}` window,
 * `fields` accepts a JSON array, and `/tasks/{id}/comments` returns the
 * thread newest-last.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface WrikeTask {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  importance?: string;
  permalink?: string;
  updatedDate?: string;
  dates?: { due?: string; start?: string };
  responsibleIds?: string[];
  authorIds?: string[];
  customStatusId?: string;
}

interface WrikeComment {
  id: string;
  authorId?: string;
  text?: string;
  createdDate?: string;
}

interface WrikeContact {
  id: string;
  firstName?: string;
  lastName?: string;
}

const COMMENTS_FOR_FIRST = 20;

function fullName(c?: WrikeContact): string {
  return c ? [c.firstName, c.lastName].filter(Boolean).join(" ") : "";
}

export const wrikeAdapter: NangoAdapter = {
  id: "wrike",
  provider: "wrike",
  sourceHint: "wrike:tasks",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const folders = allowList(config, "folders");
    const scopes: Array<string | null> = folders ? folders.slice(0, 10) : [null];
    const tasks: WrikeTask[] = [];
    let pages = 0;
    for (const folder of scopes) {
      let nextPageToken: string | undefined;
      do {
        const res = await client.proxy<{ data?: WrikeTask[]; nextPageToken?: string }>({
          method: "GET",
          providerConfigKey: "wrike",
          connectionId,
          path: folder ? `/folders/${encodeURIComponent(folder)}/tasks` : "/tasks",
          query: {
            updatedDate: JSON.stringify({ start: since.toISOString().replace(/\.\d{3}Z$/, "Z") }),
            fields: JSON.stringify(["description", "responsibleIds", "authorIds", "parentIds"]),
            sortField: "UpdatedDate",
            sortOrder: "Desc",
            limit: Math.min(100, limit),
            ...(nextPageToken ? { nextPageToken } : {}),
          },
        });
        if (!res.ok) throw new Error(`wrike tasks failed (${res.status})`);
        tasks.push(...(res.data?.data ?? []));
        nextPageToken = res.data?.nextPageToken;
        pages += 1;
      } while (nextPageToken && tasks.length < limit && pages < 5);
      if (tasks.length >= limit) break;
    }

    // Resolve people once (names only), tolerated to fail.
    const ids = new Set<string>();
    for (const t of tasks) for (const id of [...(t.responsibleIds ?? []), ...(t.authorIds ?? [])]) ids.add(id);
    const people = new Map<string, string>();
    if (ids.size) {
      const res = await client.proxy<{ data?: WrikeContact[] }>({
        method: "GET",
        providerConfigKey: "wrike",
        connectionId,
        path: `/contacts/${[...ids].slice(0, 100).join(",")}`,
      });
      if (res.ok) for (const c of res.data?.data ?? []) people.set(c.id, fullName(c));
    }
    const who = (id?: string) => (id ? people.get(id) || id : "");

    const signals: IngestSignal[] = [];
    let commentsFetched = 0;
    for (const t of tasks.slice(0, limit)) {
      let comments = "";
      if (commentsFetched < COMMENTS_FOR_FIRST) {
        commentsFetched += 1;
        const res = await client.proxy<{ data?: WrikeComment[] }>({
          method: "GET",
          providerConfigKey: "wrike",
          connectionId,
          path: `/tasks/${encodeURIComponent(t.id)}/comments`,
        });
        if (res.ok) {
          comments = (res.data?.data ?? [])
            .slice(-5)
            .map((c) => `- ${who(c.authorId) || "someone"} (${c.createdDate ?? ""}): ${htmlToText(c.text ?? "")}`)
            .join("\n");
        }
      }
      const responsible = (t.responsibleIds ?? []).map(who).filter(Boolean);
      signals.push({
        external_id: `task:${t.id}`,
        title: t.title ?? "(untitled task)",
        text: [
          `Status: ${t.status ?? "?"}${t.importance ? ` · Importance: ${t.importance}` : ""}`,
          t.dates?.due ? `Due: ${t.dates.due}` : null,
          responsible.length ? `Responsible: ${responsible.join(", ")}` : null,
          "",
          clip(htmlToText(t.description ?? "")),
          comments ? `\nComments:\n${comments}` : null,
        ]
          .filter((x) => x !== null)
          .join("\n"),
        url: t.permalink,
        author: who(t.authorIds?.[0]) || undefined,
        at: t.updatedDate,
        kind_hint: "task",
      });
    }
    return { signals, stats: { pages, tasks: tasks.length, comments_fetched: commentsFetched } };
  },
};

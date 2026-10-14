/**
 * Google Tasks — `google-tasks` → Nango `google-tasks` (OAuth2 via `google`;
 * proxy base https://tasks.googleapis.com). Every task list the account
 * owns (or `config.list_ids`), then the tasks updated since the cursor,
 * completed and hidden ones included so "done" shows up as a change.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface TaskList {
  id: string;
  title?: string;
}

interface GTask {
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  completed?: string;
  updated?: string;
  webViewLink?: string;
  parent?: string;
  links?: Array<{ link?: string; description?: string }>;
}

export const googleTasksAdapter: NangoAdapter = {
  id: "google-tasks",
  provider: "google-tasks",
  sourceHint: "google-tasks:tasks",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    let lists: TaskList[];
    const wanted = allowList(config, "list_ids");
    if (wanted) {
      lists = wanted.map((id) => ({ id }));
    } else {
      const res = await client.proxy<{ items?: TaskList[] }>({
        method: "GET",
        providerConfigKey: "google-tasks",
        connectionId,
        path: "/tasks/v1/users/@me/lists",
        query: { maxResults: 100 },
      });
      if (!res.ok) throw new Error(`google tasks tasklists.list failed (${res.status})`);
      lists = res.data?.items ?? [];
    }
    const signals: IngestSignal[] = [];
    let pages = 0;
    for (const list of lists.slice(0, 20)) {
      let pageToken: string | undefined;
      do {
        const res = await client.proxy<{ items?: GTask[]; nextPageToken?: string }>({
          method: "GET",
          providerConfigKey: "google-tasks",
          connectionId,
          path: `/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks`,
          query: {
            updatedMin: since.toISOString(),
            showCompleted: true,
            showHidden: true,
            maxResults: Math.min(100, limit),
            ...(pageToken ? { pageToken } : {}),
          },
        });
        if (!res.ok) throw new Error(`google tasks tasks.list failed (${res.status})`);
        for (const t of res.data?.items ?? []) {
          if (!t.title && !t.notes) continue;
          const links = (t.links ?? []).map((l) => l.link).filter(Boolean).join(", ");
          signals.push({
            external_id: `task:${list.id}:${t.id}`,
            title: t.title || "(untitled task)",
            text: [
              `List: ${list.title ?? list.id} · Status: ${t.status ?? "?"}`,
              t.due ? `Due: ${t.due}` : null,
              t.completed ? `Completed: ${t.completed}` : null,
              t.parent ? `Subtask of: ${t.parent}` : null,
              links ? `Links: ${links}` : null,
              "",
              clip(t.notes ?? ""),
            ]
              .filter((x) => x !== null)
              .join("\n"),
            url: t.webViewLink,
            at: t.updated,
            kind_hint: "task",
          });
          if (signals.length >= limit) break;
        }
        pageToken = res.data?.nextPageToken;
        pages += 1;
      } while (pageToken && signals.length < limit && pages < 10);
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { lists: lists.length, pages } };
  },
};

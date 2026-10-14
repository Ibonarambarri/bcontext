/**
 * Todoist — `todoist` → Nango `todoist` (OAuth2; proxy base
 * https://api.todoist.com). Two reads per run: active tasks created after
 * the cursor (REST v2 `/rest/v2/tasks`, which exposes `created_at` but no
 * "updated" instant) and tasks completed after the cursor (Sync v9
 * `/sync/v9/completed/get_all?since=`). Comments of the newest tasks are
 * appended (`/rest/v2/comments?task_id=`), capped so one run stays small.
 *
 * The Sync API's incremental `sync_token` would be the precise cursor, but
 * adapters cannot persist state between runs, so `since` drives both reads.
 * `config.projects` narrows to project ids (or names, resolved through
 * `/rest/v2/projects`).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface TodoistProject {
  id: string;
  name?: string;
  url?: string;
}

interface TodoistTask {
  id: string;
  project_id?: string;
  content?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  url?: string;
  created_at?: string;
  due?: { date?: string; string?: string } | null;
  creator_id?: string;
  assignee_id?: string | null;
}

interface TodoistCompleted {
  id?: string;
  task_id: string;
  project_id?: string;
  content?: string;
  completed_at?: string;
  note_count?: number;
}

interface TodoistComment {
  id: string;
  content?: string;
  posted_at?: string;
}

/** Sync v9 `since` wants `YYYY-MM-DDTHH:MM:SS` (no milliseconds, UTC). */
export function todoistSince(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

const COMMENTS_MAX_TASKS = 20;

export const todoistAdapter: NangoAdapter = {
  id: "todoist",
  provider: "todoist",
  sourceHint: "todoist:tasks",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "projects");

    const projectsRes = await client.proxy<TodoistProject[]>({
      method: "GET",
      providerConfigKey: "todoist",
      connectionId,
      path: "/rest/v2/projects",
    });
    if (!projectsRes.ok) throw new Error(`todoist projects failed (${projectsRes.status})`);
    const projects = Array.isArray(projectsRes.data) ? projectsRes.data : [];
    const projectName = new Map(projects.map((p) => [p.id, p.name ?? p.id]));
    const allowedIds = wanted
      ? new Set(
          projects
            .filter((p) => wanted.includes(p.id) || (p.name !== undefined && wanted.includes(p.name)))
            .map((p) => p.id),
        )
      : null;
    const inScope = (projectId?: string) => !allowedIds || (projectId !== undefined && allowedIds.has(projectId));

    const signals: IngestSignal[] = [];
    const stats = { created: 0, completed: 0, comments: 0 };

    // Active tasks created after the cursor.
    const tasksRes = await client.proxy<TodoistTask[]>({
      method: "GET",
      providerConfigKey: "todoist",
      connectionId,
      path: "/rest/v2/tasks",
      ...(allowedIds && allowedIds.size === 1 ? { query: { project_id: [...allowedIds][0] } } : {}),
    });
    if (!tasksRes.ok) throw new Error(`todoist tasks failed (${tasksRes.status})`);
    const created = (Array.isArray(tasksRes.data) ? tasksRes.data : [])
      .filter((t) => inScope(t.project_id) && !!t.created_at && new Date(t.created_at) > since)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    let commentsFetched = 0;
    for (const t of created) {
      let comments = "";
      if (commentsFetched < COMMENTS_MAX_TASKS) {
        commentsFetched++;
        const res = await client.proxy<TodoistComment[]>({
          method: "GET",
          providerConfigKey: "todoist",
          connectionId,
          path: "/rest/v2/comments",
          query: { task_id: t.id },
        });
        if (res.ok && Array.isArray(res.data) && res.data.length) {
          stats.comments += res.data.length;
          comments = res.data
            .slice(-5)
            .map((c) => `- (${c.posted_at ?? ""}): ${c.content ?? ""}`)
            .join("\n");
        }
      }
      signals.push({
        external_id: `task:${t.id}`,
        title: `${projectName.get(t.project_id ?? "") ?? "Todoist"} · ${t.content ?? ""}`.trim(),
        text: [
          `Status: open · Priority: p${5 - (t.priority ?? 1)}${t.labels?.length ? ` · Labels: ${t.labels.join(", ")}` : ""}`,
          t.due?.string || t.due?.date ? `Due: ${t.due.string ?? t.due.date}` : null,
          t.description ? `\n${clip(t.description)}` : null,
          comments ? `\nComments:\n${comments}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: t.url,
        author: t.creator_id,
        at: t.created_at,
        kind_hint: "task",
      });
      stats.created++;
      if (signals.length >= limit) break;
    }

    // Tasks completed after the cursor.
    if (signals.length < limit) {
      const doneRes = await client.proxy<{ items?: TodoistCompleted[]; projects?: Record<string, TodoistProject> }>({
        method: "GET",
        providerConfigKey: "todoist",
        connectionId,
        path: "/sync/v9/completed/get_all",
        query: {
          since: todoistSince(since),
          limit: Math.min(200, limit),
          ...(allowedIds && allowedIds.size === 1 ? { project_id: [...allowedIds][0] } : {}),
        },
      });
      if (!doneRes.ok) throw new Error(`todoist completed failed (${doneRes.status})`);
      for (const item of doneRes.data?.items ?? []) {
        if (!inScope(item.project_id)) continue;
        signals.push({
          external_id: `task:${item.task_id}:completed`,
          title: `${projectName.get(item.project_id ?? "") ?? "Todoist"} · ${item.content ?? ""}`.trim(),
          text: `Status: completed${item.completed_at ? ` at ${item.completed_at}` : ""}`,
          url: `https://app.todoist.com/app/task/${item.task_id}`,
          at: item.completed_at,
          kind_hint: "task",
        });
        stats.completed++;
        if (signals.length >= limit) break;
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

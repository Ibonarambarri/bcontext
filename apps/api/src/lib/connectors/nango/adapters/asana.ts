/**
 * Asana — `asana` → Nango `asana` (OAuth2; proxy base https://app.asana.com).
 * Asana's task list needs a project (a bare workspace is refused), so the
 * adapter walks workspaces → projects → tasks modified since the cursor,
 * plus each project's status updates (the "here is where we are" posts
 * that often carry decisions).
 *
 * Install config: `workspace_gid` (default: every workspace the account
 * sees), `projects` (allow-list of project gids or names).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface AsanaProject { gid: string; name?: string; archived?: boolean }
interface AsanaTask {
  gid: string;
  name?: string;
  notes?: string;
  completed?: boolean;
  completed_at?: string | null;
  modified_at?: string;
  due_on?: string | null;
  permalink_url?: string;
  assignee?: { name?: string } | null;
  memberships?: Array<{ section?: { name?: string } }>;
}
interface AsanaStatusUpdate {
  gid: string;
  title?: string;
  text?: string;
  status_type?: string;
  created_at?: string;
  created_by?: { name?: string };
}

const TASK_FIELDS = "name,notes,completed,completed_at,modified_at,due_on,permalink_url,assignee.name,memberships.section.name";
const MAX_PROJECTS = 10;

export const asanaAdapter: NangoAdapter = {
  id: "asana",
  provider: "asana",
  sourceHint: "asana:tasks",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const projectFilter = allowList(config, "projects");
    let workspaces = configString(config, "workspace_gid") ? [configString(config, "workspace_gid")!] : [];
    if (workspaces.length === 0) {
      const ws = await client.proxy<{ data?: Array<{ gid: string }> }>({
        method: "GET",
        providerConfigKey: "asana",
        connectionId,
        path: "/api/1.0/workspaces",
        query: { limit: 20 },
      });
      if (!ws.ok) throw new Error(`asana workspaces failed (${ws.status})`);
      workspaces = (ws.data?.data ?? []).map((w) => w.gid);
    }

    const projects: AsanaProject[] = [];
    for (const workspace of workspaces.slice(0, 3)) {
      const res = await client.proxy<{ data?: AsanaProject[] }>({
        method: "GET",
        providerConfigKey: "asana",
        connectionId,
        path: "/api/1.0/projects",
        query: { workspace, archived: false, limit: 50, opt_fields: "name,archived" },
      });
      if (!res.ok) throw new Error(`asana projects failed (${res.status})`);
      for (const p of res.data?.data ?? []) {
        if (projectFilter && !projectFilter.includes(p.gid) && !projectFilter.includes(p.name ?? "")) continue;
        projects.push(p);
      }
    }

    const signals: IngestSignal[] = [];
    let statusUpdates = 0;
    for (const project of projects.slice(0, MAX_PROJECTS)) {
      const tasks = await client.proxy<{ data?: AsanaTask[] }>({
        method: "GET",
        providerConfigKey: "asana",
        connectionId,
        path: "/api/1.0/tasks",
        query: { project: project.gid, modified_since: since.toISOString(), limit: Math.min(50, limit), opt_fields: TASK_FIELDS },
      });
      if (tasks.ok) {
        for (const t of tasks.data?.data ?? []) {
          const section = t.memberships?.[0]?.section?.name;
          signals.push({
            external_id: `task:${t.gid}`,
            title: `${project.name ?? project.gid} · ${t.name ?? t.gid}`,
            text: [
              `Status: ${t.completed ? `completed ${t.completed_at ?? ""}`.trim() : "open"}${t.due_on ? ` · Due: ${t.due_on}` : ""}${section ? ` · Section: ${section}` : ""}`,
              t.assignee?.name ? `Assignee: ${t.assignee.name}` : null,
              "",
              clip(t.notes ?? ""),
            ]
              .filter((x) => x !== null)
              .join("\n"),
            url: t.permalink_url,
            author: t.assignee?.name ?? undefined,
            at: t.modified_at,
            kind_hint: "task",
          });
          if (signals.length >= limit) break;
        }
      }
      if (signals.length >= limit) break;

      const updates = await client.proxy<{ data?: AsanaStatusUpdate[] }>({
        method: "GET",
        providerConfigKey: "asana",
        connectionId,
        path: "/api/1.0/status_updates",
        query: { parent: project.gid, limit: 10, opt_fields: "title,text,status_type,created_at,created_by.name" },
      });
      if (updates.ok) {
        for (const u of updates.data?.data ?? []) {
          if (u.created_at && new Date(u.created_at) <= since) continue;
          statusUpdates += 1;
          signals.push({
            external_id: `status_update:${u.gid}`,
            title: `${project.name ?? project.gid} · ${u.title ?? "Status update"}`,
            text: [`Status: ${u.status_type ?? "?"}`, "", clip(u.text ?? "")].join("\n"),
            url: `https://app.asana.com/0/${project.gid}/overview`,
            author: u.created_by?.name,
            at: u.created_at,
            kind_hint: "status_update",
          });
          if (signals.length >= limit) break;
        }
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { projects: projects.length, status_updates: statusUpdates } };
  },
};

/**
 * ClickUp — `clickup` → Nango `clickup` (OAuth2; proxy base
 * https://api.clickup.com). Teams (workspaces) → tasks updated since the
 * cursor (`date_updated_gt`, milliseconds), closed ones and subtasks
 * included.
 *
 * Install config: `team_ids` (allow-list; default: every team).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface ClickUpTask {
  id: string;
  name?: string;
  description?: string | null;
  text_content?: string | null;
  status?: { status?: string };
  priority?: { priority?: string } | null;
  url?: string;
  date_updated?: string;
  due_date?: string | null;
  assignees?: Array<{ username?: string }>;
  creator?: { username?: string };
  list?: { name?: string };
  folder?: { name?: string };
  space?: { name?: string };
  tags?: Array<{ name?: string }>;
}

export const clickupAdapter: NangoAdapter = {
  id: "clickup",
  provider: "clickup",
  sourceHint: "clickup:tasks",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const teamFilter = allowList(config, "team_ids");
    const teamsRes = await client.proxy<{ teams?: Array<{ id: string; name?: string }> }>({
      method: "GET",
      providerConfigKey: "clickup",
      connectionId,
      path: "/api/v2/team",
    });
    if (!teamsRes.ok) throw new Error(`clickup teams failed (${teamsRes.status})`);
    const teams = (teamsRes.data?.teams ?? []).filter((t) => !teamFilter || teamFilter.includes(t.id) || teamFilter.includes(t.name ?? ""));
    const signals: IngestSignal[] = [];
    let pages = 0;
    for (const team of teams.slice(0, 3)) {
      let page = 0;
      let last = false;
      do {
        const res = await client.proxy<{ tasks?: ClickUpTask[]; last_page?: boolean }>({
          method: "GET",
          providerConfigKey: "clickup",
          connectionId,
          path: `/api/v2/team/${encodeURIComponent(team.id)}/task`,
          query: {
            date_updated_gt: since.getTime(),
            include_closed: true,
            subtasks: true,
            order_by: "updated",
            reverse: true,
            page,
          },
        });
        if (!res.ok) throw new Error(`clickup tasks failed (${res.status})`);
        const tasks = res.data?.tasks ?? [];
        for (const t of tasks) {
          const assignees = (t.assignees ?? []).map((a) => a.username ?? "").filter(Boolean);
          const where = [t.space?.name, t.folder?.name, t.list?.name].filter(Boolean).join(" / ");
          signals.push({
            external_id: `task:${t.id}`,
            title: t.name ?? t.id,
            text: [
              `Status: ${t.status?.status ?? "?"}${t.priority?.priority ? ` · Priority: ${t.priority.priority}` : ""}${where ? ` · In: ${where}` : ""}`,
              assignees.length ? `Assignees: ${assignees.join(", ")}` : null,
              t.tags?.length ? `Tags: ${t.tags.map((x) => x.name).filter(Boolean).join(", ")}` : null,
              "",
              clip(t.text_content ?? htmlToText(t.description ?? "")),
            ]
              .filter((x) => x !== null)
              .join("\n"),
            url: t.url,
            author: t.creator?.username,
            at: t.date_updated ? new Date(Number(t.date_updated)).toISOString() : undefined,
            kind_hint: "task",
          });
          if (signals.length >= limit) break;
        }
        last = res.data?.last_page !== false || tasks.length === 0;
        page += 1;
        pages += 1;
      } while (!last && signals.length < limit && pages < 5);
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { teams: teams.length, pages } };
  },
};

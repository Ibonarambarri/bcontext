/**
 * Rippling — `rippling` → Nango `rippling` (API_KEY; proxy
 * https://rest.ripplingapis.com).
 *
 * The Rippling REST API has no "changed since" on workers, and adapters
 * are stateless, so the org is delivered as one snapshot per department
 * (headcount, titles, statuses, teams) stamped `at = since`; stable ids let
 * dedupe collapse unchanged snapshots. Leave requests created after the
 * cursor are aggregated per department and type — never per person.
 *
 * Assumptions (docs): list endpoints return `{ results: [...], next_link }`
 * and page by following `next_link`'s `cursor` query param. Names, emails
 * and compensation are never read into signal text.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, str, type NangoAdapter } from "./shared";

interface Named {
  id: string;
  name?: string;
  parent_id?: string | null;
}

interface Worker {
  id: string;
  status?: string;
  title?: string;
  department_id?: string | null;
  team_id?: string | null;
  employment_type_id?: string | null;
  manager_id?: string | null;
  start_date?: string;
}

interface LeaveRequest {
  id: string;
  status?: string;
  leave_type_id?: string | null;
  leave_type?: { name?: string } | null;
  department_id?: string | null;
  worker_id?: string;
  created_at?: string;
  updated_at?: string;
  start_date?: string;
  end_date?: string;
}

interface ListPage<T> {
  results?: T[];
  next_link?: string | null;
}

const MAX_PAGES = 5;

function cursorOf(nextLink: string | null | undefined): string | undefined {
  if (!nextLink) return undefined;
  try {
    return new URL(nextLink, "https://rest.ripplingapis.com").searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

async function listAll<T>(
  client: Parameters<NangoAdapter["fetchChanges"]>[0]["client"],
  connectionId: string,
  path: string,
  extra: Record<string, string | number | boolean | undefined> = {},
): Promise<{ rows: T[]; ok: boolean; status: number }> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.proxy<ListPage<T>>({
      method: "GET",
      providerConfigKey: "rippling",
      connectionId,
      path,
      query: { limit: 100, ...extra, ...(cursor ? { cursor } : {}) },
    });
    if (!res.ok) return { rows, ok: false, status: res.status };
    rows.push(...(res.data?.results ?? []));
    cursor = cursorOf(res.data?.next_link);
    if (!cursor) break;
  }
  return { rows, ok: true, status: 200 };
}

export const ripplingAdapter: NangoAdapter = {
  id: "rippling",
  provider: "rippling",
  sourceHint: "rippling:org",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const departmentsAllow = allowList(config, "departments");
    const stats: Record<string, number> = { workers: 0, leave_requests: 0 };
    const signals: IngestSignal[] = [];

    const departments = await listAll<Named>(client, connectionId, "/departments");
    const teams = await listAll<Named>(client, connectionId, "/teams");
    const deptName = new Map(departments.rows.map((d) => [d.id, d.name ?? d.id]));
    const teamName = new Map(teams.rows.map((t) => [t.id, t.name ?? t.id]));

    const workers = await listAll<Worker>(client, connectionId, "/workers");
    if (!workers.ok) throw new Error(`rippling workers failed (${workers.status})`);

    const byDept = new Map<string, { count: number; active: number; titles: Map<string, number>; teams: Set<string>; managers: Set<string> }>();
    for (const w of workers.rows) {
      const dept = deptName.get(str(w.department_id)) ?? (w.department_id ? str(w.department_id) : "no department");
      if (departmentsAllow && !departmentsAllow.includes(dept)) continue;
      stats.workers = (stats.workers ?? 0) + 1;
      const b = byDept.get(dept) ?? { count: 0, active: 0, titles: new Map(), teams: new Set(), managers: new Set() };
      b.count++;
      if ((w.status ?? "").toUpperCase() === "ACTIVE") b.active++;
      if (w.title) b.titles.set(w.title, (b.titles.get(w.title) ?? 0) + 1);
      const team = teamName.get(str(w.team_id));
      if (team) b.teams.add(team);
      if (w.manager_id) b.managers.add(w.manager_id);
      byDept.set(dept, b);
    }

    // Leave requests created after the cursor, aggregated per department + type.
    const leave = await listAll<LeaveRequest>(client, connectionId, "/leave-requests");
    const leaveByDept = new Map<string, Map<string, number>>();
    if (leave.ok) {
      for (const r of leave.rows) {
        const created = r.created_at ?? r.updated_at;
        if (!created || new Date(created) <= since) continue;
        stats.leave_requests = (stats.leave_requests ?? 0) + 1;
        const dept = deptName.get(str(r.department_id)) ?? "no department";
        if (departmentsAllow && !departmentsAllow.includes(dept)) continue;
        const type = str(r.leave_type?.name || r.leave_type_id) || "leave";
        const key = `${type} (${r.status ?? "?"})`;
        const m = leaveByDept.get(dept) ?? new Map<string, number>();
        m.set(key, (m.get(key) ?? 0) + 1);
        leaveByDept.set(dept, m);
      }
    } else {
      stats.leave_unavailable = 1;
    }

    for (const [dept, b] of byDept) {
      if (signals.length >= limit) break;
      const titles = [...b.titles.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 12)
        .map(([t, n]) => `${t} ×${n}`)
        .join(", ");
      const leaveLines = [...(leaveByDept.get(dept) ?? new Map()).entries()].map(([k, n]) => `${k} ×${n}`);
      signals.push({
        external_id: `department:${dept}`,
        title: `Department ${dept} · ${b.count} people`,
        text: [
          `Headcount: ${b.count} (${b.active} active) · Managers: ${b.managers.size}`,
          b.teams.size ? `Teams: ${[...b.teams].sort().join(", ")}` : null,
          titles ? `Roles: ${titles}` : null,
          leaveLines.length ? `Leave requests since ${since.toISOString().slice(0, 10)}: ${leaveLines.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: "https://app.rippling.com/",
        at: since.toISOString(),
        kind_hint: "org_snapshot",
      });
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

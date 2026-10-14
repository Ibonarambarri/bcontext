/**
 * HiBob — `hibob` → Nango `hibob-service-user` (BASIC: service user id +
 * token; proxy base https://api.hibob.com).
 *
 * The people API has no "changed since" filter and adapters are stateless,
 * so this emits one org snapshot per department (headcount, titles, sites,
 * managers, joiners in the period) stamped `at = since`, with stable ids so
 * an unchanged department dedupes on the next run. Only work fields are
 * requested — never names beyond the manager's display name, emails or
 * personal data. Absences come from `whosout` as counts per department.
 *
 * Assumptions (docs, not exercised live): `POST /v1/people/search` accepts
 * `{ fields, filters, showInactive }` and returns `{ employees: [{ id,
 * work: {...}, internal: {...} }] }` with the requested paths unfolded;
 * `GET /v1/timeoff/whosout?from&to` returns `{ outs: [...] }`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

export const HIBOB_FIELDS = [
  "/root/id",
  "/root/displayName",
  "/work/title",
  "/work/department",
  "/work/site",
  "/work/startDate",
  "/work/reportsTo",
  "/internal/status",
];

interface HibobEmployee {
  id?: string;
  displayName?: string;
  work?: {
    title?: string;
    department?: string;
    site?: string;
    startDate?: string;
    reportsTo?: { id?: string; displayName?: string; email?: string } | null;
  };
  internal?: { status?: string };
}

interface HibobOut {
  employeeId?: string;
  employeeDisplayName?: string;
  policyTypeDisplayName?: string;
  startDate?: string;
  endDate?: string;
}

interface DeptSummary {
  name: string;
  headcount: number;
  titles: Record<string, number>;
  sites: Record<string, number>;
  managers: Record<string, number>;
  joiners: number;
  out: Record<string, number>;
}

function counts(map: Record<string, number>, max = 12): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const hibobAdapter: NangoAdapter = {
  id: "hibob",
  provider: "hibob-service-user",
  sourceHint: "hibob:org",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const allow = allowList(config, "departments");
    const stats: Record<string, number> = { employees: 0, departments: 0, out: 0 };

    const res = await client.proxy<{ employees?: HibobEmployee[] }>({
      method: "POST",
      providerConfigKey: "hibob",
      connectionId,
      path: "/v1/people/search",
      body: { fields: HIBOB_FIELDS, filters: [], showInactive: false },
    });
    if (!res.ok) throw new Error(`hibob people search failed (${res.status})`);
    const employees = res.data?.employees ?? [];
    stats.employees = employees.length;

    const idToDept = new Map<string, string>();
    const depts = new Map<string, DeptSummary>();
    const summary = (name: string): DeptSummary => {
      let s = depts.get(name);
      if (!s) {
        s = { name, headcount: 0, titles: {}, sites: {}, managers: {}, joiners: 0, out: {} };
        depts.set(name, s);
      }
      return s;
    };
    for (const e of employees) {
      const dept = e.work?.department?.trim() || "(no department)";
      if (e.id) idToDept.set(e.id, dept);
      const s = summary(dept);
      s.headcount += 1;
      if (e.work?.title) s.titles[e.work.title] = (s.titles[e.work.title] ?? 0) + 1;
      if (e.work?.site) s.sites[e.work.site] = (s.sites[e.work.site] ?? 0) + 1;
      const manager = e.work?.reportsTo?.displayName;
      if (manager) s.managers[manager] = (s.managers[manager] ?? 0) + 1;
      const start = e.work?.startDate ? new Date(e.work.startDate) : null;
      if (start && !Number.isNaN(start.getTime()) && start > since) s.joiners += 1;
    }

    const now = new Date();
    const out = await client.proxy<{ outs?: HibobOut[] }>({
      method: "GET",
      providerConfigKey: "hibob",
      connectionId,
      path: "/v1/timeoff/whosout",
      query: { from: day(since), to: day(now), includeHourly: false, includePrivate: false },
    });
    if (out.ok) {
      const outs = out.data?.outs ?? [];
      stats.out = outs.length;
      for (const o of outs) {
        const dept = (o.employeeId && idToDept.get(o.employeeId)) || "(no department)";
        const type = o.policyTypeDisplayName ?? "time off";
        const s = summary(dept);
        s.out[type] = (s.out[type] ?? 0) + 1;
      }
    }

    const signals: IngestSignal[] = [];
    const ordered = [...depts.values()].sort((a, b) => b.headcount - a.headcount);
    stats.departments = ordered.length;
    for (const s of ordered) {
      if (allow && !allow.includes(s.name)) continue;
      if (s.headcount === 0) continue;
      const lines = [
        `Headcount: ${s.headcount}${s.joiners ? ` · Joined since ${day(since)}: ${s.joiners}` : ""}`,
        Object.keys(s.titles).length ? `Titles: ${counts(s.titles)}` : null,
        Object.keys(s.sites).length ? `Sites: ${counts(s.sites)}` : null,
        Object.keys(s.managers).length ? `Managers: ${counts(s.managers, 8)}` : null,
        Object.keys(s.out).length ? `Out of office (${day(since)} → ${day(now)}): ${counts(s.out)}` : null,
      ].filter((l) => l !== null);
      signals.push({
        external_id: `department:${s.name}:${s.headcount}:${s.joiners}`,
        title: `Org · ${s.name}`,
        text: lines.join("\n"),
        at: since.toISOString(),
        kind_hint: "org_snapshot",
      });
      if (signals.length >= limit) break;
    }
    return { signals, stats };
  },
};

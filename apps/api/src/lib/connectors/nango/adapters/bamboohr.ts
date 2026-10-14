/**
 * BambooHR — `bamboohr` → Nango `bamboohr-basic` (BASIC: API key as
 * username, "x" as password; proxy base
 * https://api.bamboohr.com/api/gateway.php/<subdomain>).
 *
 * Organisation changes since the cursor — who changed job title,
 * department, division, location or status — read per changed employee
 * with an explicit field list that carries no personal contact data, plus
 * an aggregated view of approved time off in the window (counts per type
 * and per department, no names).
 *
 * Assumptions (docs, not exercised live): `/v1/employees/changed` takes an
 * ISO-8601 `since` and returns `{ employees: { "<id>": { action,
 * lastChanged } } }`; `/v1/time_off/requests/` takes `start`/`end`
 * (YYYY-MM-DD) and `status`; JSON needs `Accept: application/json`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { str, subdomain, type NangoAdapter } from "./shared";

interface ChangedEmployees {
  latest?: string;
  employees?: Record<string, { id?: string | number; action?: string; lastChanged?: string }>;
}

interface EmployeeFields {
  id?: string | number;
  jobTitle?: string | null;
  department?: string | null;
  division?: string | null;
  location?: string | null;
  hireDate?: string | null;
  status?: string | null;
  employmentHistoryStatus?: string | null;
  supervisor?: string | null;
}

interface TimeOffRequest {
  id?: string | number;
  employeeId?: string | number;
  status?: { status?: string };
  start?: string;
  end?: string;
  type?: { name?: string };
  amount?: { unit?: string; amount?: string | number };
}

const EMPLOYEE_FIELDS = "jobTitle,department,division,location,hireDate,status,employmentHistoryStatus,supervisor";
const JSON_HEADERS = { Accept: "application/json" };

export function bamboohrDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

export const bamboohrAdapter: NangoAdapter = {
  id: "bamboohr",
  provider: "bamboohr-basic",
  sourceHint: "bamboohr:org",
  async fetchChanges({ client, connectionId, connectionConfig, since, limit }) {
    const host = subdomain(connectionConfig);
    const signals: IngestSignal[] = [];
    const stats = { changed: 0, employees: 0, time_off: 0 };

    const changed = await client.proxy<ChangedEmployees>({
      method: "GET",
      providerConfigKey: "bamboohr",
      connectionId,
      path: "/v1/employees/changed",
      query: { since: since.toISOString(), type: "updated" },
      headers: JSON_HEADERS,
    });
    if (!changed.ok) throw new Error(`bamboohr changed employees failed (${changed.status})`);
    const entries = Object.entries(changed.data?.employees ?? {});
    stats.changed = entries.length;
    const recent = entries
      .map(([id, e]) => ({ id: str(e?.id ?? id), lastChanged: e?.lastChanged ?? "", action: e?.action ?? "Updated" }))
      .sort((a, b) => (a.lastChanged < b.lastChanged ? 1 : -1))
      .slice(0, Math.min(30, limit));

    for (const e of recent) {
      const res = await client.proxy<EmployeeFields>({
        method: "GET",
        providerConfigKey: "bamboohr",
        connectionId,
        path: `/v1/employees/${encodeURIComponent(e.id)}`,
        query: { fields: EMPLOYEE_FIELDS, onlyCurrent: true },
        headers: JSON_HEADERS,
      });
      if (!res.ok) continue;
      const f = res.data ?? {};
      stats.employees += 1;
      signals.push({
        external_id: `employee:${e.id}`,
        title: `Org change · ${f.jobTitle ?? "role"} in ${f.department ?? "?"}`,
        text: [
          `Change: ${e.action} · Employee ref: ${e.id}`,
          `Role: ${f.jobTitle ?? "?"} · Department: ${f.department ?? "?"}${f.division ? ` · Division: ${f.division}` : ""}`,
          `Location: ${f.location ?? "?"} · Status: ${f.status ?? f.employmentHistoryStatus ?? "?"}`,
          f.supervisor ? `Reports to: ${f.supervisor}` : null,
          f.hireDate ? `Hire date: ${f.hireDate}` : null,
        ]
          .filter((x) => x !== null)
          .join("\n"),
        url: host ? `https://${host}.bamboohr.com/employees/employee.php?id=${encodeURIComponent(e.id)}` : undefined,
        at: e.lastChanged || undefined,
        kind_hint: "org-change",
      });
    }

    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86_400_000);
    const timeOff = await client.proxy<TimeOffRequest[]>({
      method: "GET",
      providerConfigKey: "bamboohr",
      connectionId,
      path: "/v1/time_off/requests/",
      query: { start: bamboohrDate(since), end: bamboohrDate(end), status: "approved" },
      headers: JSON_HEADERS,
    });
    if (timeOff.ok && Array.isArray(timeOff.data) && timeOff.data.length) {
      const byType: Record<string, number> = {};
      const people = new Set<string>();
      let days = 0;
      for (const r of timeOff.data) {
        byType[r.type?.name ?? "time off"] = (byType[r.type?.name ?? "time off"] ?? 0) + 1;
        if (r.employeeId != null) people.add(str(r.employeeId));
        const amount = Number(r.amount?.amount ?? 0);
        if (r.amount?.unit === "days" && Number.isFinite(amount)) days += amount;
      }
      stats.time_off = timeOff.data.length;
      signals.push({
        external_id: `timeoff:${bamboohrDate(since)}:${bamboohrDate(end)}`,
        title: `Approved time off · ${bamboohrDate(since)} → ${bamboohrDate(end)}`,
        text: [
          `Requests: ${timeOff.data.length} across ${people.size} people${days ? ` · ${days} days` : ""}`,
          `By type: ${counts(byType)}`,
        ].join("\n"),
        at: now.toISOString(),
        kind_hint: "absence-summary",
      });
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

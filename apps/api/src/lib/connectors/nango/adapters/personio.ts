/**
 * Personio — `personio` → Nango `personio` (OAUTH2_CC: the customer's own
 * client id/secret are entered at connect time, Nango exchanges them for
 * the bearer token; proxy base https://api.personio.de/v1, partner/app
 * headers added by Nango from connection_config).
 *
 * Organisation changes since the cursor — position, department, office,
 * status — read from the employees endpoint with `updated_since`, plus an
 * aggregated view of time off in the window (counts per type and status,
 * no names). Names, emails and contact fields are never copied into a
 * signal; the employee id is the only reference.
 *
 * Assumptions (docs, not exercised live): `/company/employees` accepts
 * `updated_since` (ISO-8601), `limit`/`offset`; attributes come as
 * `{ label, value }` where relation values nest `{ attributes: { name } }`;
 * `/company/time-offs` takes `start_date`/`end_date` (YYYY-MM-DD).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { str, type NangoAdapter } from "./shared";

interface PersonioAttr {
  label?: string;
  value?: unknown;
}

interface PersonioEmployee {
  type?: string;
  attributes?: Record<string, PersonioAttr>;
}

interface PersonioTimeOff {
  attributes?: {
    id?: number;
    status?: string;
    start_date?: string;
    end_date?: string;
    days_count?: number;
    time_off_type?: { attributes?: { name?: string } };
  };
}

interface PersonioList<T> {
  success?: boolean;
  data?: T[];
  metadata?: { total_elements?: number; total_pages?: number; current_page?: number };
}

/** Read `attributes.<key>.value`; relations (`{ attributes: { name } }`) collapse to their name. */
export function personioValue(e: PersonioEmployee, key: string): string {
  const v = e.attributes?.[key]?.value;
  if (v && typeof v === "object") {
    const rel = v as { attributes?: { name?: string; first_name?: string; last_name?: string } };
    if (rel.attributes?.name) return str(rel.attributes.name);
    return "";
  }
  return str(v);
}

export function personioDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

export const personioAdapter: NangoAdapter = {
  id: "personio",
  provider: "personio",
  sourceHint: "personio:org",
  async fetchChanges({ client, connectionId, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats = { employees: 0, time_off: 0 };
    const pageSize = 200;
    let offset = 0;
    for (let page = 0; page < 5 && signals.length < limit; page += 1) {
      const res = await client.proxy<PersonioList<PersonioEmployee>>({
        method: "GET",
        providerConfigKey: "personio",
        connectionId,
        path: "/company/employees",
        query: { updated_since: since.toISOString(), limit: pageSize, offset },
      });
      if (!res.ok) throw new Error(`personio employees failed (${res.status})`);
      const rows = res.data?.data ?? [];
      for (const e of rows) {
        if (signals.length >= limit) break;
        const id = personioValue(e, "id");
        if (!id) continue;
        const position = personioValue(e, "position");
        const department = personioValue(e, "department");
        const office = personioValue(e, "office");
        const status = personioValue(e, "status");
        const team = personioValue(e, "team");
        const updated = personioValue(e, "last_modified_at");
        stats.employees += 1;
        signals.push({
          external_id: `employee:${id}`,
          title: `Org change · ${position || "role"} in ${department || "?"}`,
          text: [
            `Employee ref: ${id}`,
            `Position: ${position || "?"} · Department: ${department || "?"}${team ? ` · Team: ${team}` : ""}`,
            `Office: ${office || "?"} · Status: ${status || "?"}`,
            personioValue(e, "hire_date") ? `Hire date: ${personioValue(e, "hire_date")}` : null,
            personioValue(e, "supervisor") ? `Reports to: ${personioValue(e, "supervisor")}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          at: updated || undefined,
          kind_hint: "org-change",
        });
      }
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    if (signals.length < limit) {
      const end = new Date(Date.now() + 30 * 86_400_000);
      const res = await client.proxy<PersonioList<PersonioTimeOff>>({
        method: "GET",
        providerConfigKey: "personio",
        connectionId,
        path: "/company/time-offs",
        query: { start_date: personioDate(since), end_date: personioDate(end), limit: 200, offset: 0 },
      });
      if (res.ok && res.data?.data?.length) {
        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        let days = 0;
        for (const t of res.data.data) {
          const a = t.attributes ?? {};
          byType[a.time_off_type?.attributes?.name ?? "time off"] = (byType[a.time_off_type?.attributes?.name ?? "time off"] ?? 0) + 1;
          byStatus[a.status ?? "unknown"] = (byStatus[a.status ?? "unknown"] ?? 0) + 1;
          days += Number(a.days_count ?? 0) || 0;
        }
        stats.time_off = res.data.data.length;
        signals.push({
          external_id: `timeoff:${personioDate(since)}:${personioDate(end)}`,
          title: `Time off · ${personioDate(since)} → ${personioDate(end)}`,
          text: [
            `Requests: ${res.data.data.length}${days ? ` · ${days} days` : ""}`,
            `By type: ${counts(byType)}`,
            `By status: ${counts(byStatus)}`,
          ].join("\n"),
          at: new Date().toISOString(),
          kind_hint: "absence-summary",
        });
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

/**
 * Gusto — `gusto` → Nango `gusto` (OAuth2; proxy https://api.gusto.com,
 * header `X-Gusto-API-Version: 2024-04-01`).
 *
 * Company id from `config.company_id`, else the token's resource
 * (`GET /v1/token` → `resource.uuid`). Then:
 *   - employees → one org snapshot per department (headcount, titles,
 *     onboarding/terminated counts), stamped `at = since`;
 *   - processed payrolls whose check date falls in the window → one signal
 *     per payroll with company-level totals only (gross, net, employer
 *     taxes, benefits). Never per-employee pay, never names or emails.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { configString, str, type NangoAdapter } from "./shared";

const API_VERSION = "2024-04-01";
const HEADERS = { "X-Gusto-API-Version": API_VERSION };

interface GustoEmployee {
  uuid: string;
  department?: string | null;
  terminated?: boolean;
  onboarded?: boolean;
  current_employment_status?: string;
  jobs?: Array<{ title?: string; primary?: boolean; location?: { city?: string; state?: string } }>;
}

interface GustoPayroll {
  payroll_uuid?: string;
  uuid?: string;
  processed?: boolean;
  check_date?: string;
  processed_date?: string;
  pay_period?: { start_date?: string; end_date?: string };
  totals?: Record<string, string | number | null | undefined>;
  employee_compensations?: unknown[];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function money(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : null;
}

const TOTAL_KEYS: Array<[string, string]> = [
  ["gross_pay", "Gross pay"],
  ["net_pay", "Net pay"],
  ["employer_taxes", "Employer taxes"],
  ["employee_taxes", "Employee taxes"],
  ["benefits", "Benefits"],
  ["reimbursements", "Reimbursements"],
  ["company_debit", "Company debit"],
];

export const gustoAdapter: NangoAdapter = {
  id: "gusto",
  provider: "gusto",
  sourceHint: "gusto:payroll",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const stats: Record<string, number> = { employees: 0, payrolls: 0 };
    const signals: IngestSignal[] = [];

    let companyId = configString(config, "company_id");
    if (!companyId) {
      const token = await client.proxy<{ resource?: { type?: string; uuid?: string } }>({
        method: "GET",
        providerConfigKey: "gusto",
        connectionId,
        path: "/v1/token",
        headers: HEADERS,
      });
      if (!token.ok) throw new Error(`gusto token lookup failed (${token.status})`);
      companyId = str(token.data?.resource?.uuid) || null;
    }
    if (!companyId) {
      stats.missing_company_id = 1;
      return { signals, stats };
    }

    // -- org snapshot per department ------------------------------------------
    const byDept = new Map<string, { count: number; active: number; onboarding: number; terminated: number; titles: Map<string, number> }>();
    for (let page = 1; page <= 5; page++) {
      const res = await client.proxy<GustoEmployee[]>({
        method: "GET",
        providerConfigKey: "gusto",
        connectionId,
        path: `/v1/companies/${companyId}/employees`,
        query: { per: 100, page },
        headers: HEADERS,
      });
      if (!res.ok) throw new Error(`gusto employees failed (${res.status})`);
      const rows = Array.isArray(res.data) ? res.data : [];
      for (const e of rows) {
        stats.employees = (stats.employees ?? 0) + 1;
        const dept = str(e.department) || "no department";
        const b = byDept.get(dept) ?? { count: 0, active: 0, onboarding: 0, terminated: 0, titles: new Map() };
        b.count++;
        if (e.terminated) b.terminated++;
        else if (e.onboarded === false) b.onboarding++;
        else b.active++;
        const job = e.jobs?.find((j) => j.primary) ?? e.jobs?.[0];
        if (job?.title) b.titles.set(job.title, (b.titles.get(job.title) ?? 0) + 1);
        byDept.set(dept, b);
      }
      if (rows.length < 100) break;
    }
    for (const [dept, b] of byDept) {
      if (signals.length >= limit) break;
      const titles = [...b.titles.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 12)
        .map(([t, n]) => `${t} ×${n}`)
        .join(", ");
      signals.push({
        external_id: `department:${dept}`,
        title: `Department ${dept} · ${b.count} people`,
        text: [
          `Headcount: ${b.count} · active ${b.active} · onboarding ${b.onboarding} · terminated ${b.terminated}`,
          titles ? `Roles: ${titles}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: "https://app.gusto.com/",
        at: since.toISOString(),
        kind_hint: "org_snapshot",
      });
    }

    // -- processed payrolls in the window --------------------------------------
    const payrolls = await client.proxy<GustoPayroll[]>({
      method: "GET",
      providerConfigKey: "gusto",
      connectionId,
      path: `/v1/companies/${companyId}/payrolls`,
      query: { processed: true, start_date: isoDate(since), end_date: isoDate(new Date()), per: 50 },
      headers: HEADERS,
    });
    if (payrolls.ok) {
      for (const p of Array.isArray(payrolls.data) ? payrolls.data : []) {
        if (signals.length >= limit) break;
        const id = p.payroll_uuid ?? p.uuid;
        if (!id) continue;
        const when = p.processed_date ?? p.check_date;
        if (when && new Date(when) <= since) continue;
        stats.payrolls = (stats.payrolls ?? 0) + 1;
        const totals = TOTAL_KEYS.map(([k, label]) => {
          const m = money(p.totals?.[k]);
          return m ? `${label}: ${m}` : null;
        }).filter(Boolean);
        signals.push({
          external_id: `payroll:${id}`,
          title: `Payroll ${p.pay_period?.start_date ?? "?"} → ${p.pay_period?.end_date ?? "?"}`,
          text: [
            `Check date: ${p.check_date ?? "?"} · Employees paid: ${p.employee_compensations?.length ?? "?"}`,
            ...totals,
          ].join("\n"),
          url: "https://app.gusto.com/payroll",
          at: when ? new Date(when).toISOString() : since.toISOString(),
          kind_hint: "payroll",
        });
      }
    } else {
      stats.payrolls_unavailable = 1;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};

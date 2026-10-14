/**
 * Batch 10b adapters — request shape + mapping against a fake proxy client.
 * Deel, Gusto, Rippling, Ramp, Brex. HR/finance rule: no personal data or
 * per-person pay in any signal text.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { brexAdapter } from "./brex";
import { deelAdapter } from "./deel";
import { gustoAdapter } from "./gusto";
import { rampAdapter } from "./ramp";
import { ripplingAdapter } from "./rippling";

type Reply = unknown | { status: number; data: unknown; headers?: Record<string, string> };

function fakeClient(handler: (req: ProxyRequest) => Reply) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      const out = handler(req) as { status?: number; data?: unknown; headers?: Record<string, string> };
      const envelope = !!out && typeof out === "object" && typeof out.status === "number";
      const status = envelope ? out.status! : 200;
      const data = envelope ? out.data : out;
      return { status, ok: status < 400, data, headers: new Headers(envelope ? (out.headers ?? {}) : {}) };
    },
  } as unknown as NangoClient;
  return { client, calls };
}

const since = new Date("2026-09-01T00:00:00Z");
const base = { connectionId: "c1", connectionConfig: {}, config: {}, since, limit: 50 };

describe("deel adapter", () => {
  it("lists contracts newest-first, stops at the cursor and snapshots teams without PII", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/rest/v2/contracts") {
        return {
          data: [
            { id: "k1", title: "Senior engineer", type: "eor", status: "in_progress", created_at: "2026-09-03T10:00:00Z", team: { name: "Platform" }, worker: { country: "ES" }, job_title: "Engineer" },
            { id: "k0", title: "Old", type: "eor", status: "completed", created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-02T10:00:00Z", team: { name: "Platform" } },
          ],
          page: { cursor: "c2" },
        };
      }
      if (req.path === "/rest/v2/people") {
        return {
          data: [
            { id: "p1", first_name: "Ann", country: "ES", employments: [{ team: { name: "Platform" }, job_title: "Engineer", hiring_status: "active" }] },
            { id: "p2", first_name: "Bo", country: "PT", employments: [{ team: { name: "Platform" }, job_title: "Engineer", hiring_status: "active" }] },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await deelAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.sort_by).toBe("created_at");
    expect(calls.filter((c) => c.path === "/rest/v2/contracts")).toHaveLength(1); // stopped at the older contract
    expect(signals.map((s) => s.external_id)).toEqual(["contract:k1", "team:Platform"]);
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00.000Z");
    expect(signals[1]?.text).toContain("Headcount: 2 (2 active)");
    expect(signals[1]?.text).toContain("Engineer ×2");
    expect(JSON.stringify(signals)).not.toContain("Ann");
    expect(stats).toMatchObject({ contracts: 1, people: 2 });
  });
});

describe("gusto adapter", () => {
  it("resolves the company from the token, aggregates departments and lists payrolls with totals only", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/token") return { resource: { type: "Company", uuid: "co1" } };
      if (req.path === "/v1/companies/co1/employees") {
        return [
          { uuid: "e1", first_name: "Ann", department: "Sales", jobs: [{ title: "AE", primary: true, rate: "90000" }], terminated: false, onboarded: true },
          { uuid: "e2", first_name: "Bo", department: "Sales", jobs: [{ title: "AE", primary: true }], terminated: true },
        ];
      }
      if (req.path === "/v1/companies/co1/payrolls") {
        return [
          { payroll_uuid: "pr1", processed: true, check_date: "2026-09-05", processed_date: "2026-09-03T12:00:00Z", pay_period: { start_date: "2026-08-16", end_date: "2026-08-31" }, totals: { gross_pay: "12345.67", net_pay: "9000.10", employer_taxes: "1200" }, employee_compensations: [{ gross_pay: "1" }, { gross_pay: "2" }] },
          { payroll_uuid: "pr0", processed: true, check_date: "2026-08-20", processed_date: "2026-08-18T12:00:00Z", pay_period: {}, totals: {} },
        ];
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await gustoAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.headers?.["X-Gusto-API-Version"]).toBe("2024-04-01");
    expect(calls[2]?.query?.processed).toBe(true);
    expect(signals.map((s) => s.external_id)).toEqual(["department:Sales", "payroll:pr1"]);
    expect(signals[0]?.text).toContain("active 1");
    expect(signals[0]?.text).toContain("terminated 1");
    expect(signals[1]?.text).toContain("Gross pay: 12,346");
    expect(signals[1]?.text).toContain("Employees paid: 2");
    expect(JSON.stringify(signals)).not.toContain("90000");
    expect(JSON.stringify(signals)).not.toContain("Ann");
    expect(stats).toMatchObject({ employees: 2, payrolls: 1 });
  });

  it("reports a missing company id instead of failing", async () => {
    const { client } = fakeClient((req) => (req.path === "/v1/token" ? { resource: {} } : { status: 500, data: {} }));
    const { signals, stats } = await gustoAdapter.fetchChanges({ client, ...base });
    expect(signals).toEqual([]);
    expect(stats?.missing_company_id).toBe(1);
  });
});

describe("rippling adapter", () => {
  it("snapshots workers per department with leave counts and follows next_link cursors", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/departments") return { results: [{ id: "d1", name: "Engineering" }] };
      if (req.path === "/teams") return { results: [{ id: "t1", name: "Core" }] };
      if (req.path === "/workers") {
        if (!req.query?.cursor) {
          return { results: [{ id: "w1", status: "ACTIVE", title: "Engineer", department_id: "d1", team_id: "t1", manager_id: "m1" }], next_link: "https://rest.ripplingapis.com/workers?cursor=abc&limit=100" };
        }
        return { results: [{ id: "w2", status: "TERMINATED", title: "Engineer", department_id: "d1" }] };
      }
      if (req.path === "/leave-requests") {
        return { results: [
          { id: "l1", status: "APPROVED", leave_type: { name: "Vacation" }, department_id: "d1", created_at: "2026-09-02T00:00:00Z" },
          { id: "l0", status: "APPROVED", leave_type: { name: "Vacation" }, department_id: "d1", created_at: "2026-08-02T00:00:00Z" },
        ] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await ripplingAdapter.fetchChanges({ client, ...base });
    const workerCalls = calls.filter((c) => c.path === "/workers");
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]?.query?.cursor).toBe("abc");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("department:Engineering");
    expect(signals[0]?.text).toContain("Headcount: 2 (1 active)");
    expect(signals[0]?.text).toContain("Teams: Core");
    expect(signals[0]?.text).toContain("Vacation (APPROVED) ×1");
    expect(signals[0]?.at).toBe(since.toISOString());
    expect(stats).toMatchObject({ workers: 2, leave_requests: 1 });
  });
});

describe("ramp adapter", () => {
  it("aggregates spend per department, pages via page.next and singles out large transactions", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/developer/v1/transactions") {
        if (!req.query?.start) {
          return {
            data: [
              { id: "t1", amount: 1500.4, currency_code: "USD", merchant_name: "AWS", memo: "Prod hosting", state: "CLEARED", user_transaction_time: "2026-09-04T10:00:00Z", card_holder: { department_name: "Engineering", email: "x@y.z" }, receipts: ["r1"] },
              { id: "t2", amount: 40, currency_code: "USD", merchant_name: "Coffee", user_transaction_time: "2026-09-02T10:00:00Z", card_holder: { department_name: "Engineering" }, receipts: [] },
            ],
            page: { next: "https://api.ramp.com/developer/v1/transactions?start=t2&page_size=100" },
          };
        }
        return { data: [{ id: "t3", amount: 10, currency_code: "USD", merchant_name: "Coffee", user_transaction_time: "2026-09-01T10:00:00Z", card_holder: { department_name: "Sales" } }], page: { next: null } };
      }
      if (req.path === "/developer/v1/reimbursements") {
        return { data: [{ id: "r1", amount: 120, created_at: "2026-09-03T00:00:00Z", department_id: "dep-1" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await rampAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.from_date).toBe(since.toISOString());
    expect(calls[1]?.query?.start).toBe("t2");
    const ids = signals.map((s) => s.external_id);
    expect(ids).toEqual(["spend:Engineering:2026-09-01", "spend:Sales:2026-09-01", "reimbursements:dep-1:2026-09-01", "transaction:t1"]);
    expect(signals[0]?.title).toContain("1,540 USD across 2 transactions");
    expect(signals[0]?.text).toContain("Missing receipts: 1");
    expect(signals[0]?.at).toBe("2026-09-04T10:00:00Z");
    expect(signals[3]?.text).toContain("Memo: Prod hosting");
    expect(JSON.stringify(signals)).not.toContain("x@y.z");
    expect(stats).toMatchObject({ transactions: 3, reimbursements: 1 });
  });
});

describe("brex adapter", () => {
  it("aggregates expenses per department from minor units, cross-checks posted transactions and flags large expenses", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/expenses/card") {
        return {
          items: [
            { id: "e1", updated_at: "2026-09-03T10:00:00Z", status: "APPROVED", memo: "Conference tickets", merchant: { raw_descriptor: "EVENTBRITE" }, department: { name: "Marketing" }, billing_amount: { amount: 250000, currency: "USD" }, receipts: [] },
            { id: "e2", updated_at: "2026-09-02T10:00:00Z", status: "DRAFT", merchant: { raw_descriptor: "UBER" }, department: { name: "Marketing" }, billing_amount: { amount: 2599, currency: "USD" }, receipts: ["x"] },
          ],
          next_cursor: null,
        };
      }
      if (req.path === "/v2/transactions/card/primary") {
        return { items: [{ id: "tx1", merchant: { raw_descriptor: "EVENTBRITE" }, amount: { amount: 250000, currency: "USD" }, posted_at_date: "2026-09-04" }], next_cursor: null };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await brexAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.updated_at_start).toBe(since.toISOString());
    expect(calls[0]?.query?.["expand[]"]).toBe("merchant");
    expect(calls[1]?.query?.posted_at_start).toBe(since.toISOString());
    expect(signals.map((s) => s.external_id)).toEqual(["spend:Marketing:2026-09-01", "posted:2026-09-01", "expense:e1"]);
    expect(signals[0]?.title).toContain("2,526 USD across 2 expenses");
    expect(signals[0]?.text).toContain("Statuses: APPROVED ×1, DRAFT ×1");
    expect(signals[1]?.text).toContain("EVENTBRITE: 2,500 USD (1)");
    expect(signals[2]?.text).toContain("Memo: Conference tickets");
    expect(signals[2]?.text).toContain("Receipt: missing");
    expect(stats).toMatchObject({ expenses: 2, transactions: 1 });
  });
});

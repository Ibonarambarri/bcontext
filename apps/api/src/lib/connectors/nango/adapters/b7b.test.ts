/**
 * Batch 7b adapters — request shape + mapping against a fake proxy client.
 * Mailchimp, Greenhouse, Workable, BambooHR, Personio.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { bamboohrAdapter, bamboohrDate } from "./bamboohr";
import { greenhouseAdapter } from "./greenhouse";
import { mailchimpAdapter, mailchimpPercent } from "./mailchimp";
import { personioAdapter, personioValue } from "./personio";
import { workableAdapter, workableSinceId } from "./workable";

type Reply = unknown | { status: number; data: unknown };

function fakeClient(handler: (req: ProxyRequest) => Reply) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      const out = handler(req) as { status?: number; data?: unknown };
      const envelope = !!out && typeof out === "object" && typeof out.status === "number";
      const status = envelope ? out.status! : 200;
      const data = envelope ? out.data : out;
      return { status, ok: status < 400, data, headers: new Headers() };
    },
  } as unknown as NangoClient;
  return { client, calls };
}

const since = new Date("2026-09-01T00:00:00Z");
const base = { connectionId: "c1", connectionConfig: {}, config: {}, since, limit: 50 };

describe("mailchimp adapter", () => {
  it("lists sent campaigns since the cursor with their report and automations created since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/3.0/campaigns") {
        return {
          campaigns: [
            {
              id: "abc",
              web_id: 77,
              send_time: "2026-09-03T10:00:00+00:00",
              archive_url: "https://eepurl.com/x",
              settings: { subject_line: "Pricing v2 is live", title: "Sept launch", from_name: "Ana" },
              recipients: { list_name: "Customers", recipient_count: 1200 },
            },
          ],
          total_items: 1,
        };
      }
      if (req.path === "/3.0/reports/abc") {
        return { opens: { open_rate: 0.412, unique_opens: 494 }, clicks: { click_rate: 0.05, unique_clicks: 60 }, unsubscribed: 3, bounces: { hard_bounces: 1, soft_bounces: 2 } };
      }
      if (req.path === "/3.0/automations") {
        return {
          automations: [
            { id: "auto1", status: "sending", create_time: "2026-09-02T00:00:00+00:00", settings: { title: "Onboarding" }, recipients: { list_name: "Trials" }, trigger_settings: { workflow_type: "welcomeSeries" } },
            { id: "old", status: "paused", create_time: "2026-01-02T00:00:00+00:00", settings: { title: "Old" } },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const out = await mailchimpAdapter.fetchChanges({ ...base, client, connectionConfig: { dc: "us6" } });
    expect(calls[0]?.query).toMatchObject({ since_send_time: since.toISOString(), status: "sent", sort_field: "send_time", sort_dir: "DESC", count: 50 });
    expect(out.signals.map((s) => s.external_id)).toEqual(["campaign:abc", "automation:auto1"]);
    expect(out.signals[0]).toMatchObject({ title: "Campaign · Sept launch", url: "https://eepurl.com/x", author: "Ana", at: "2026-09-03T10:00:00+00:00", kind_hint: "campaign" });
    expect(out.signals[0]?.text).toContain("opens 41.2% (494 unique)");
    expect(out.signals[0]?.text).toContain("unsubscribes 3 · bounces 3");
    expect(out.signals[1]?.text).toContain("Audience: Trials");
    expect(out.stats).toEqual({ campaigns: 1, automations: 1 });
    expect(mailchimpPercent(undefined)).toBe("?");
  });
});

describe("greenhouse adapter", () => {
  it("emits job changes and per-job pipeline summaries without candidate data", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/jobs") {
        return [{ id: 10, name: "Backend Engineer", status: "open", updated_at: "2026-09-02T00:00:00Z", departments: [{ name: "Engineering" }], offices: [{ name: "Bilbao" }], openings: [{ status: "open" }, { status: "closed" }], hiring_team: { hiring_managers: [{ name: "Ana" }] } }];
      }
      if (req.path === "/v1/applications") {
        return [
          { id: 1, candidate_id: 501, status: "active", current_stage: { name: "Onsite" }, jobs: [{ id: 10, name: "Backend Engineer" }], last_activity_at: "2026-09-03T00:00:00Z" },
          { id: 2, candidate_id: 502, status: "rejected", rejection_reason: { name: "Compensation" }, jobs: [{ id: 10, name: "Backend Engineer" }], last_activity_at: "2026-09-02T00:00:00Z" },
          { id: 3, candidate_id: 503, status: "hired", jobs: [{ id: 10, name: "Backend Engineer" }], last_activity_at: "2026-09-04T00:00:00Z" },
        ];
      }
      if (req.path === "/v1/scorecards") {
        return [{ id: 9, application_id: 1, overall_recommendation: "strong_yes" }, { id: 8, application_id: 999, overall_recommendation: "no" }];
      }
      return { status: 500, data: {} };
    });
    const out = await greenhouseAdapter.fetchChanges({ ...base, client });
    expect(calls[0]).toMatchObject({ path: "/v1/jobs", query: { updated_after: since.toISOString(), per_page: 100, page: 1 } });
    expect(calls[1]?.query).toMatchObject({ last_activity_after: since.toISOString() });
    expect(out.signals.map((s) => s.external_id)).toEqual(["job:10", "pipeline:10"]);
    expect(out.signals[0]?.text).toContain("Openings: 1 open of 2");
    expect(out.signals[0]?.text).toContain("Hiring managers: Ana");
    expect(out.signals[1]).toMatchObject({ title: "Hiring pipeline · Backend Engineer", at: "2026-09-04T00:00:00Z" });
    expect(out.signals[1]?.text).toContain("Applications with activity: 3 · hired 1 · rejected 1");
    expect(out.signals[1]?.text).toContain("Current stages: Onsite 1");
    expect(out.signals[1]?.text).toContain("Rejection reasons: Compensation 1");
    expect(out.signals[1]?.text).toContain("Scorecard recommendations: strong_yes 1");
    expect(JSON.stringify(out.signals)).not.toContain("501");
    expect(out.stats).toEqual({ jobs: 1, applications: 3, scorecards: 2 });
  });

  it("honours the jobs allow-list", async () => {
    const { client } = fakeClient((req) =>
      req.path === "/v1/jobs" ? [{ id: 1, name: "A" }, { id: 2, name: "B" }] : [],
    );
    const out = await greenhouseAdapter.fetchChanges({ ...base, client, config: { jobs: ["B"] } });
    expect(out.signals.map((s) => s.external_id)).toEqual(["job:2"]);
  });
});

describe("workable adapter", () => {
  it("follows since_id paging and aggregates candidates per job", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/spi/v3/jobs") {
        return { jobs: [{ shortcode: "AB12", title: "Designer", state: "published", department: "Product", created_at: "2026-09-02T00:00:00Z", url: "https://acme.workable.com/jobs/AB12", location: { city: "Madrid", country: "Spain", workplace_type: "hybrid" } }] };
      }
      if (req.path === "/spi/v3/candidates" && !req.query?.since_id) {
        return { candidates: [{ id: "c1", stage: "Interview", job: { shortcode: "AB12", title: "Designer" }, updated_at: "2026-09-03T00:00:00Z" }], paging: { next: "https://acme.workable.com/spi/v3/candidates?limit=100&since_id=c1&updated_after=x" } };
      }
      if (req.path === "/spi/v3/candidates") {
        return { candidates: [{ id: "c2", disqualified: true, disqualification_reason: "Location", job: { shortcode: "AB12", title: "Designer" }, updated_at: "2026-09-04T00:00:00Z" }] };
      }
      return { status: 500, data: {} };
    });
    const out = await workableAdapter.fetchChanges({ ...base, client, connectionConfig: { subdomain: "acme" } });
    expect(calls[0]?.query).toMatchObject({ updated_after: since.toISOString(), limit: 100 });
    expect(calls[2]?.query).toMatchObject({ since_id: "c1" });
    expect(out.signals.map((s) => s.external_id)).toEqual(["job:AB12", "pipeline:AB12"]);
    expect(out.signals[0]?.text).toContain("Location: Madrid, Spain (hybrid)");
    expect(out.signals[1]?.text).toContain("Candidates with activity: 2 · disqualified 1");
    expect(out.signals[1]?.text).toContain("Disqualification reasons: Location 1");
    expect(out.signals[1]?.url).toBe("https://acme.workable.com/backend/jobs/AB12");
    expect(workableSinceId(undefined)).toBeNull();
    expect(out.stats).toEqual({ jobs: 1, candidates: 2 });
  });
});

describe("bamboohr adapter", () => {
  it("reads changed employees with a safe field list and summarises approved time off", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/employees/changed") {
        return { latest: "2026-09-05T00:00:00+00:00", employees: { "42": { id: "42", action: "Updated", lastChanged: "2026-09-05T00:00:00+00:00" } } };
      }
      if (req.path === "/v1/employees/42") {
        return { id: "42", jobTitle: "Staff Engineer", department: "Engineering", division: "Product", location: "Bilbao", hireDate: "2024-01-15", status: "Active", supervisor: "Ana R" };
      }
      if (req.path === "/v1/time_off/requests/") {
        return [
          { id: 1, employeeId: 42, status: { status: "approved" }, type: { name: "Vacation" }, amount: { unit: "days", amount: "5" } },
          { id: 2, employeeId: 43, status: { status: "approved" }, type: { name: "Sick" }, amount: { unit: "days", amount: 1 } },
        ];
      }
      return { status: 500, data: {} };
    });
    const out = await bamboohrAdapter.fetchChanges({ ...base, client, connectionConfig: { subdomain: "acme" } });
    expect(calls[0]).toMatchObject({ path: "/v1/employees/changed", query: { since: since.toISOString(), type: "updated" }, headers: { Accept: "application/json" } });
    expect(calls[1]?.query).toMatchObject({ fields: "jobTitle,department,division,location,hireDate,status,employmentHistoryStatus,supervisor" });
    expect(calls[2]?.query).toMatchObject({ start: "2026-09-01", status: "approved" });
    expect(out.signals[0]).toMatchObject({ external_id: "employee:42", title: "Org change · Staff Engineer in Engineering", url: "https://acme.bamboohr.com/employees/employee.php?id=42", at: "2026-09-05T00:00:00+00:00" });
    expect(out.signals[0]?.text).toContain("Reports to: Ana R");
    expect(out.signals[1]?.external_id).toMatch(/^timeoff:2026-09-01:/);
    expect(out.signals[1]?.text).toContain("Requests: 2 across 2 people · 6 days");
    expect(out.signals[1]?.text).toContain("By type: Vacation 1, Sick 1");
    expect(out.stats).toEqual({ changed: 1, employees: 1, time_off: 2 });
    expect(bamboohrDate(since)).toBe("2026-09-01");
  });
});

describe("personio adapter", () => {
  it("maps attribute values, pages employees and summarises time off", async () => {
    const employee = {
      type: "Employee",
      attributes: {
        id: { label: "ID", value: 7 },
        position: { label: "Position", value: "Head of Sales" },
        department: { label: "Department", value: { type: "Department", attributes: { name: "Sales" } } },
        office: { label: "Office", value: { type: "Office", attributes: { name: "Berlin" } } },
        status: { label: "Status", value: "active" },
        last_modified_at: { label: "Last modified", value: "2026-09-03T08:00:00+02:00" },
        first_name: { label: "First name", value: "Secret" },
      },
    };
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/company/employees") return { success: true, data: [employee] };
      if (req.path === "/company/time-offs") {
        return { success: true, data: [{ attributes: { status: "approved", days_count: 3, time_off_type: { attributes: { name: "Paid vacation" } } } }] };
      }
      return { status: 500, data: {} };
    });
    const out = await personioAdapter.fetchChanges({ ...base, client });
    expect(calls[0]).toMatchObject({ path: "/company/employees", query: { updated_since: since.toISOString(), limit: 200, offset: 0 } });
    expect(calls[1]?.query).toMatchObject({ start_date: "2026-09-01" });
    expect(out.signals[0]).toMatchObject({ external_id: "employee:7", title: "Org change · Head of Sales in Sales", at: "2026-09-03T08:00:00+02:00" });
    expect(out.signals[0]?.text).toContain("Office: Berlin · Status: active");
    expect(out.signals[0]?.text).not.toContain("Secret");
    expect(out.signals[1]?.text).toContain("Requests: 1 · 3 days");
    expect(out.signals[1]?.text).toContain("By status: approved 1");
    expect(personioValue(employee, "department")).toBe("Sales");
    expect(personioValue(employee, "missing")).toBe("");
    expect(out.stats).toEqual({ employees: 1, time_off: 1 });
  });
});

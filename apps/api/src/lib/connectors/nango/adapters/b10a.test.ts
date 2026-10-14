/**
 * Batch 10a adapters — request shape + mapping against a fake proxy client.
 * Vimeo, Dropbox Sign, Lever, Ashby, HiBob.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { ashbyAdapter } from "./ashby";
import { dropboxSignAdapter, latestEventAt, requestStatus } from "./dropbox-sign";
import { HIBOB_FIELDS, hibobAdapter } from "./hibob";
import { leverAdapter } from "./lever";
import { VIMEO_FIELDS, vimeoAdapter } from "./vimeo";

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

describe("vimeo adapter", () => {
  it("lists videos newest-modified first, stops at the cursor and attaches comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/me/videos") {
        return {
          data: [
            { uri: "/videos/111", name: "Q3 all-hands", description: "Recording", link: "https://vimeo.com/111", modified_time: "2026-09-03T10:00:00+00:00", created_time: "2026-09-02T10:00:00+00:00", duration: 3725, stats: { plays: 42 }, privacy: { view: "unlisted" }, user: { name: "Acme" } },
            { uri: "/videos/100", name: "Old", modified_time: "2026-08-01T10:00:00+00:00" },
          ],
          paging: { next: "/me/videos?page=2" },
        };
      }
      if (req.path === "/videos/111/comments") {
        return { data: [{ text: "Great session", created_on: "2026-09-03T11:00:00+00:00", user: { name: "Bo" } }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await vimeoAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ sort: "modified_time", direction: "desc", per_page: 50, page: 1, fields: VIMEO_FIELDS });
    expect(calls.map((c) => c.path)).toEqual(["/me/videos", "/videos/111/comments"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ external_id: "video:111", title: "Q3 all-hands", url: "https://vimeo.com/111", author: "Acme", at: "2026-09-03T10:00:00.000Z", kind_hint: "video" });
    expect(signals[0]?.text).toContain("Duration: 62:05 · Privacy: unlisted · Plays: 42");
    expect(signals[0]?.text).toContain("- Bo (2026-09-03T11:00:00+00:00): Great session");
    expect(stats).toMatchObject({ pages: 1, videos: 1, comments: 1 });
  });
});

describe("dropbox-sign adapter", () => {
  it("keeps requests whose latest event is after the cursor and lists signers without emails", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v3/signature_request/list") {
        return {
          signature_requests: [
            { signature_request_id: "sr1", title: "MSA — Acme", created_at: 1788200000, is_complete: true, details_url: "https://app.hellosign.com/sr1", signatures: [{ signer_name: "Ana Ruiz", signer_role: "Client", status_code: "signed", signed_at: 1788400000 }] },
            { signature_request_id: "sr2", title: "NDA", created_at: 1788200000, is_declined: true, signatures: [{ signer_name: "Bo", status_code: "declined", decline_reason: "Wrong entity" }] },
          ],
          list_info: { page: 1, num_pages: 1 },
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await dropboxSignAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ page: 1, page_size: 100 });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ external_id: "signature_request:sr1:completed", title: "MSA — Acme", url: "https://app.hellosign.com/sr1", at: new Date(1788400000 * 1000).toISOString(), kind_hint: "signature_request" });
    expect(signals[0]?.text).toContain("Status: completed");
    expect(signals[0]?.text).toContain("- Ana Ruiz: signed");
    expect(signals[0]?.text).not.toContain("@");
    expect(stats).toMatchObject({ pages: 1, scanned: 2 });
    expect(requestStatus({ signature_request_id: "x", is_declined: true })).toBe("declined");
    expect(latestEventAt({ signature_request_id: "x", created_at: 1, signatures: [{ signed_at: 5 }] })).toBe(5);
  });
});

describe("lever adapter", () => {
  it("aggregates opportunities per posting with stage counts and archive reasons, no candidate data", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/postings") {
        return { data: [{ id: "p1", text: "Backend Engineer", state: "published", updatedAt: 1756800000000, urls: { show: "https://jobs.lever.co/acme/p1" }, categories: { team: "Engineering", location: "Madrid", commitment: "Full-time" }, owner: { name: "Ana" }, hiringManager: { name: "Bo" } }], hasNext: false };
      }
      if (req.path === "/v1/opportunities") {
        return {
          data: [
            { id: "o1", updatedAt: 1756900000000, stage: { id: "s1", text: "Phone screen" }, origin: "applied", postings: ["p1"] },
            { id: "o2", updatedAt: 1756850000000, stage: { id: "s2", text: "Onsite" }, origin: "sourced", postings: ["p1"] },
            { id: "o3", updatedAt: 1756860000000, archivedAt: 1756860000000, archived: { archivedAt: 1756860000000, reason: { text: "Underqualified" } }, origin: "applied", postings: ["p1"] },
          ],
          hasNext: false,
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await leverAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ updated_at_start: since.getTime(), limit: 100 });
    expect(calls[1]?.query).toMatchObject({ updated_at_start: since.getTime(), limit: 100, expand: "stage" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ external_id: "posting:p1", title: "Hiring · Backend Engineer", url: "https://jobs.lever.co/acme/p1", author: "Ana", at: new Date(1756900000000).toISOString(), kind_hint: "hiring_pipeline" });
    expect(signals[0]?.text).toContain("Posting state: published · Team: Engineering · Location: Madrid · Full-time");
    expect(signals[0]?.text).toContain("Hiring manager: Bo");
    expect(signals[0]?.text).toContain("Opportunities updated in the period: 3");
    expect(signals[0]?.text).toContain("Active by stage: Phone screen 1, Onsite 1");
    expect(signals[0]?.text).toContain("Archived: 1 (Underqualified 1)");
    expect(signals[0]?.text).toContain("Origins: applied 2, sourced 1");
    expect(signals[0]?.text).not.toContain("o1");
    expect(stats).toMatchObject({ postings: 1, opportunities: 3 });
  });
});

describe("ashby adapter", () => {
  it("POSTs the RPC endpoints, filters jobs by updatedAt and aggregates applications per job", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/job.list") {
        return { success: true, results: [
          { id: "j1", title: "Designer", status: "Open", updatedAt: "2026-09-02T00:00:00Z", department: { name: "Product" }, location: { name: "Remote" }, employmentType: "FullTime", hiringTeam: [{ role: "Hiring Manager", firstName: "Ana", lastName: "Ruiz" }] },
          { id: "j0", title: "Old", status: "Closed", updatedAt: "2026-07-01T00:00:00Z" },
        ], moreDataAvailable: false };
      }
      if (req.path === "/application.list") {
        return { success: true, results: [
          { id: "a1", createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z", status: "Active", currentInterviewStage: { title: "Portfolio review" }, source: { title: "LinkedIn" }, job: { id: "j1", title: "Designer" } },
          { id: "a2", createdAt: "2026-09-03T00:00:00Z", status: "Archived", archiveReason: { text: "Not a fit" }, currentInterviewStage: { title: "Application" }, job: { id: "j1" } },
        ], moreDataAvailable: false };
      }
      if (req.path === "/jobPosting.list") {
        return { success: true, results: [{ id: "jp1", jobId: "j1", externalLink: "https://jobs.ashbyhq.com/acme/jp1" }], moreDataAvailable: false };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await ashbyAdapter.fetchChanges({ client, ...base });
    expect(calls.map((c) => [c.method, c.path])).toEqual([["POST", "/job.list"], ["POST", "/application.list"], ["POST", "/jobPosting.list"]]);
    expect(calls[0]?.body).toEqual({ status: ["Open", "Closed"] });
    expect(calls[1]?.body).toEqual({ createdAfter: since.getTime() });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ external_id: "job:j1", title: "Hiring · Designer", url: "https://jobs.ashbyhq.com/acme/jp1", at: "2026-09-04T00:00:00.000Z", kind_hint: "hiring_pipeline" });
    expect(signals[0]?.text).toContain("Job status: Open · Department: Product · Location: Remote · FullTime");
    expect(signals[0]?.text).toContain("Hiring team: Ana Ruiz (Hiring Manager)");
    expect(signals[0]?.text).toContain("Applications created in the period: 2");
    expect(signals[0]?.text).toContain("By stage: Portfolio review 1, Application 1");
    expect(signals[0]?.text).toContain("Archive reasons: Not a fit 1");
    expect(signals[0]?.text).not.toContain("a1");
    expect(stats).toMatchObject({ jobs: 1, applications: 2 });
  });
});

describe("hibob adapter", () => {
  it("requests work fields only and emits one snapshot per department with absences", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/people/search") {
        return { employees: [
          { id: "e1", displayName: "Ana Ruiz", work: { title: "Engineer", department: "Engineering", site: "Madrid", startDate: "2026-09-02", reportsTo: { id: "e9", displayName: "Bo Chen", email: "bo@acme.test" } }, internal: { status: "active" } },
          { id: "e2", displayName: "Cy Lee", work: { title: "Engineer", department: "Engineering", site: "Remote", startDate: "2024-01-10", reportsTo: { id: "e9", displayName: "Bo Chen" } } },
          { id: "e3", displayName: "Di Park", work: { title: "AE", department: "Sales", site: "Madrid", startDate: "2025-05-01" } },
        ] };
      }
      if (req.path === "/v1/timeoff/whosout") {
        return { outs: [{ employeeId: "e2", employeeDisplayName: "Cy Lee", policyTypeDisplayName: "Holiday", startDate: "2026-09-05", endDate: "2026-09-06" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await hibobAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ fields: HIBOB_FIELDS, showInactive: false });
    expect(calls[1]?.query).toMatchObject({ from: "2026-09-01" });
    expect(signals.map((s) => s.title)).toEqual(["Org · Engineering", "Org · Sales"]);
    expect(signals[0]).toMatchObject({ external_id: "department:Engineering:2:1", at: since.toISOString(), kind_hint: "org_snapshot" });
    expect(signals[0]?.text).toContain("Headcount: 2 · Joined since 2026-09-01: 1");
    expect(signals[0]?.text).toContain("Titles: Engineer 2");
    expect(signals[0]?.text).toContain("Managers: Bo Chen 2");
    expect(signals[0]?.text).toContain("Out of office (2026-09-01 → ");
    expect(signals[0]?.text).toContain("Holiday 1");
    expect(signals[0]?.text).not.toContain("bo@acme.test");
    expect(signals[0]?.text).not.toContain("Ana Ruiz");
    expect(stats).toMatchObject({ employees: 3, departments: 2, out: 1 });
  });
});

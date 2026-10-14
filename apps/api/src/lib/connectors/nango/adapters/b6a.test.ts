/**
 * Batch 6a adapters — request shape + mapping against a fake proxy client.
 * Zapier, Make, n8n, DocuSign, PandaDoc.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { docusignAdapter, docusignEnvelopeUrl } from "./docusign";
import { makeAdapter, makeScenarioUrl } from "./make";
import { n8nAdapter, n8nWorkflowUrl } from "./n8n";
import { pandadocAdapter } from "./pandadoc";
import { zapierAdapter, zapierPage } from "./zapier";

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

describe("zapier adapter", () => {
  it("cuts zaps at the cursor client-side and lists failed runs from the cursor", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/zaps")
        return [
          {
            links: { next: null },
            data: [
              {
                id: "z1",
                title: "Lead to CRM",
                is_enabled: true,
                updated_at: "2026-09-02T10:00:00Z",
                last_successful_run_date: "2026-09-02T11:00:00Z",
                links: { html_editor: "https://zapier.com/editor/1" },
                steps: [{ title: null, action: { title: "New lead", app: { title: "Typeform" } } }, { title: "Create deal", action: "uag:1" }],
              },
              { id: "z0", title: "Old", is_enabled: false, updated_at: "2026-08-01T00:00:00Z", last_successful_run_date: null, links: {}, steps: [] },
            ],
          },
        ];
      if (req.path === "/v2/zap-runs")
        return [
          {
            links: { next: null },
            data: [
              {
                id: "r1",
                zap_id: 42,
                zap_title: "Lead to CRM",
                status: "error",
                start_time: "2026-09-03T08:00:00Z",
                end_time: "2026-09-03T08:00:05Z",
                steps: [{ status: "success" }, { status: "error" }],
                data_in: "{}",
                data_out: "",
              },
            ],
          },
        ];
      return { status: 404, data: {} };
    });
    const { signals, stats } = await zapierAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ limit: 100, expand: "steps.action" });
    expect(calls[1]?.query).toMatchObject({ from_date: since.toISOString(), statuses: "error,error_handled,halted" });
    expect(signals.map((s) => s.external_id)).toEqual(["zap:z1", "run:r1"]);
    expect(signals[0]?.text).toContain("1. Typeform: New lead");
    expect(signals[0]?.url).toBe("https://zapier.com/editor/1");
    expect(signals[1]?.text).toContain("Failed at step 2 of 2");
    expect(signals[1]?.at).toBe("2026-09-03T08:00:05Z");
    expect(stats).toMatchObject({ zaps: 1, runs: 1 });
  });

  it("unwraps the one-element array envelope or a bare object", () => {
    expect(zapierPage([{ data: [1] }]).data).toEqual([1]);
    expect(zapierPage({ data: [2] }).data).toEqual([2]);
    expect(zapierPage(null).data).toBeUndefined();
  });
});

describe("make adapter", () => {
  it("discovers teams, reports edited scenarios and failed runs with the error detail", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/organizations") return { organizations: [{ id: 7 }] };
      if (req.path === "/teams") return { teams: [{ id: 3 }] };
      if (req.path === "/scenarios")
        return {
          scenarios: [
            { id: 10, name: "Invoice sync", isActive: true, lastEdit: "2026-09-02T09:00:00Z", scheduling: { type: "interval", interval: 15 } },
            { id: 11, name: "Untouched", isActive: true, lastEdit: "2026-08-01T09:00:00Z" },
          ],
        };
      if (req.path === "/scenarios/10/logs") return { scenarioLogs: [{ imtId: "e1", timestamp: "2026-09-03T01:00:00Z", status: 3, duration: 120, operations: 4 }] };
      if (req.path === "/scenarios/11/logs") return { scenarioLogs: [] };
      if (req.path === "/scenarios/10/executions/e1")
        return { status: "ERROR", error: { name: "RuntimeError", message: "401 from Stripe", causeModule: { name: "HTTP" } } };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await makeAdapter.fetchChanges({ client, ...base, connectionConfig: { environmentUrl: "eu1.make.com" } });
    expect(calls[1]?.query).toMatchObject({ organizationId: 7 });
    expect(calls[2]?.query).toMatchObject({ teamId: "3", "pg[limit]": 100 });
    expect(calls.find((c) => c.path === "/scenarios/10/logs")?.query).toMatchObject({ from: since.getTime(), status: 3 });
    expect(signals.map((s) => s.external_id)).toEqual(["scenario:10", "run:10:e1"]);
    expect(signals[0]?.url).toBe("https://eu1.make.com/scenarios/10");
    expect(signals[0]?.text).toContain("every 15 min");
    expect(signals[1]?.text).toContain("RuntimeError — 401 from Stripe — in module HTTP");
    expect(stats).toMatchObject({ teams: 1, scenarios: 2, edited: 1, failures: 1 });
    expect(makeScenarioUrl("https://eu1.make.com", 5)).toBe("https://eu1.make.com/scenarios/5");
  });

  it("uses config.team_id without discovery", async () => {
    const { client, calls } = fakeClient((req) => (req.path === "/scenarios" ? { scenarios: [] } : { status: 404, data: {} }));
    await makeAdapter.fetchChanges({ client, ...base, config: { team_id: "9" } });
    expect(calls[0]?.path).toBe("/scenarios");
    expect(calls[0]?.query).toMatchObject({ teamId: "9" });
  });
});

describe("n8n adapter", () => {
  it("lists workflows edited since and errored executions with the failing node", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/workflows")
        return {
          data: [
            { id: "w1", name: "Invoice sync", active: true, updatedAt: "2026-09-02T12:00:00Z", tags: [{ name: "finance" }], nodes: [{ name: "Cron" }, { name: "HTTP Request" }] },
            { id: "w2", name: "Old", active: false, updatedAt: "2026-07-01T12:00:00Z" },
          ],
          nextCursor: null,
        };
      if (req.path === "/v1/executions")
        return {
          data: [
            {
              id: 501,
              status: "error",
              mode: "trigger",
              startedAt: "2026-09-03T02:00:00Z",
              stoppedAt: "2026-09-03T02:00:01Z",
              workflowId: "w1",
              data: { resultData: { error: { message: "ECONNREFUSED", node: { name: "HTTP Request", type: "n8n-nodes-base.httpRequest" } } } },
            },
            { id: 400, status: "error", startedAt: "2026-08-01T00:00:00Z", stoppedAt: "2026-08-01T00:00:01Z", workflowId: "w1" },
          ],
          nextCursor: "abc",
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await n8nAdapter.fetchChanges({ client, ...base, connectionConfig: { baseUrl: "https://n8n.acme.io" } });
    expect(calls[0]?.query).toMatchObject({ limit: 100 });
    expect(calls[1]?.query).toMatchObject({ status: "error", includeData: true });
    // reached an execution older than the cursor → no second executions page
    expect(calls.filter((c) => c.path === "/v1/executions")).toHaveLength(1);
    expect(signals.map((s) => s.external_id)).toEqual(["workflow:w1", "execution:501"]);
    expect(signals[0]?.url).toBe("https://n8n.acme.io/workflow/w1");
    expect(signals[0]?.text).toContain("Cron → HTTP Request");
    expect(signals[1]?.title).toBe("Workflow run failed · Invoice sync");
    expect(signals[1]?.text).toContain("Failed node: HTTP Request (n8n-nodes-base.httpRequest)");
    expect(signals[1]?.url).toBe("https://n8n.acme.io/workflow/w1/executions/501");
    expect(stats).toMatchObject({ workflows: 2, edited: 1, failures: 1 });
    expect(n8nWorkflowUrl("https://x.io/", "a")).toBe("https://x.io/workflow/a");
  });
});

describe("docusign adapter", () => {
  it("needs an account id and then lists status changes with recipients", async () => {
    const none = fakeClient(() => ({ status: 500, data: {} }));
    expect(await docusignAdapter.fetchChanges({ client: none.client, ...base })).toEqual({ signals: [], stats: { envelopes: 0, missing_account_id: 1 } });
    expect(none.calls).toHaveLength(0);

    const { client, calls } = fakeClient((req) => {
      if (req.path === "/restapi/v2.1/accounts/acc-1/envelopes")
        return {
          envelopes: [
            {
              envelopeId: "E1",
              emailSubject: "MSA — Acme",
              status: "completed",
              statusChangedDateTime: "2026-09-03T10:00:00Z",
              sentDateTime: "2026-09-01T10:00:00Z",
              completedDateTime: "2026-09-03T10:00:00Z",
              sender: { userName: "Ana", email: "ana@bx.dev" },
              recipients: { signers: [{ name: "Bo", email: "bo@acme.com", status: "completed", signedDateTime: "2026-09-03T09:59:00Z", roleName: "Customer" }] },
            },
          ],
          totalSetSize: "1",
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await docusignAdapter.fetchChanges({ client, ...base, config: { account_id: "acc-1", base_path: "https://eu.docusign.net" } });
    expect(calls[0]?.query).toMatchObject({ from_date: since.toISOString(), status: "completed,declined,voided,sent", include: "recipients,custom_fields", count: 50, start_position: 0 });
    expect(calls[0]?.baseUrlOverride).toBe("https://eu.docusign.net");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("envelope:E1");
    expect(signals[0]?.title).toBe("completed · MSA — Acme");
    expect(signals[0]?.text).toContain("- Bo (Customer): completed at 2026-09-03T09:59:00Z");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.url).toBe(docusignEnvelopeUrl("acc-1", "E1"));
    expect(stats).toMatchObject({ envelopes: 1, pages: 1 });
  });
});

describe("pandadoc adapter", () => {
  it("lists documents modified since, filters by status and enriches with details", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/public/v1/documents")
        return {
          results: [
            { id: "d1", name: "Proposal 50 seats", status: "document.completed", date_modified: "2026-09-02T15:00:00Z", date_created: "2026-09-01T15:00:00Z" },
            { id: "d2", name: "Draft", status: "document.draft", date_modified: "2026-09-02T16:00:00Z" },
          ],
        };
      if (req.path === "/public/v1/documents/d1/details")
        return {
          id: "d1",
          recipients: [{ first_name: "Bo", last_name: "Lee", email: "bo@acme.com", role: "Signer", has_completed: true }],
          grand_total: { amount: "12000.00", currency: "EUR" },
          fields: [{ name: "seats", title: "Seats", value: 50 }, { name: "empty", value: "" }],
          metadata: { deal_id: "D-9" },
          created_by: { first_name: "Ana", last_name: "R" },
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await pandadocAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ modified_from: since.toISOString(), order_by: "-date_modified", count: 100, page: 1 });
    expect(calls[1]?.path).toBe("/public/v1/documents/d1/details");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("document:d1");
    expect(signals[0]?.title).toBe("completed · Proposal 50 seats");
    expect(signals[0]?.text).toContain("Total: 12000.00 EUR");
    expect(signals[0]?.text).toContain("- Bo Lee (Signer): completed");
    expect(signals[0]?.text).toContain("Seats: 50");
    expect(signals[0]?.text).not.toContain("empty");
    expect(signals[0]?.author).toBe("Ana R");
    expect(stats).toMatchObject({ listed: 2, details: 1, pages: 1 });
  });
});

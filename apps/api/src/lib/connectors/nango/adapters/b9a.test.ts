/**
 * Batch 9a adapters — request shape + mapping against a fake proxy client.
 * ServiceNow, Zoho CRM, Wrike, Google Tasks, Google Forms.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { googleFormsAdapter, questionTitles } from "./google-forms";
import { googleTasksAdapter } from "./google-tasks";
import { nowDate, servicenowAdapter, servicenowBase } from "./servicenow";
import { wrikeAdapter } from "./wrike";
import { zohoApiBase, zohoCrmAdapter } from "./zoho-crm";

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

describe("servicenow adapter", () => {
  it("queries the three default tables with sysparm_query and maps records", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/now/table/incident") {
        return {
          result: [
            {
              sys_id: "abc", number: "INC0001", short_description: "DB down", description: "<p>Primary failed over</p>",
              state: "Resolved", priority: "1 - Critical", assignment_group: "SRE", assigned_to: "Ana",
              close_notes: "Failover completed", comments_and_work_notes: "2026-09-02 - Ana (Work notes)\nRestarted replica",
              sys_updated_on: "2026-09-02 10:00:00", sys_updated_by: "ana",
            },
          ],
        };
      }
      if (req.path === "/api/now/table/change_request") return { result: [] };
      if (req.path === "/api/now/table/kb_knowledge") {
        return { result: [{ sys_id: "kb1", number: "KB0007", short_description: "Runbook", text: "<h1>Steps</h1><p>Do X</p>", workflow_state: "Published", sys_updated_on: "2026-09-03 08:00:00", author: "Bo" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await servicenowAdapter.fetchChanges({ client, ...base, connectionConfig: { subdomain: "acme" } });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.query?.sysparm_query).toBe("sys_updated_on>=2026-09-01 00:00:00^ORDERBYDESCsys_updated_on");
    expect(calls[2]?.query?.sysparm_query).toContain("workflow_state=published");
    expect(calls[0]?.query?.sysparm_display_value).toBe(true);
    const inc = signals.find((s) => s.external_id === "incident:abc");
    expect(inc?.title).toBe("INC0001 · DB down");
    expect(inc?.text).toContain("Priority: 1 - Critical");
    expect(inc?.text).toContain("Primary failed over");
    expect(inc?.text).toContain("Restarted replica");
    expect(inc?.url).toBe("https://acme.service-now.com/incident.do?sys_id=abc");
    expect(inc?.at).toBe("2026-09-02T10:00:00.000Z");
    const kb = signals.find((s) => s.external_id === "article:kb1");
    expect(kb?.text).toContain("Do X");
    expect(kb?.author).toBe("Bo");
    expect(stats).toEqual({ incident: 1, change_request: 0, kb_knowledge: 1 });
  });

  it("honours the tables allow-list and hostname base", async () => {
    const { client, calls } = fakeClient(() => ({ result: [] }));
    await servicenowAdapter.fetchChanges({ client, ...base, connectionConfig: { hostname: "now.acme.com" }, config: { tables: ["change_request"] } });
    expect(calls.map((c) => c.path)).toEqual(["/api/now/table/change_request"]);
    expect(servicenowBase({ hostname: "now.acme.com" })).toBe("https://now.acme.com");
    expect(nowDate(since)).toBe("2026-09-01 00:00:00");
  });
});

describe("zoho crm adapter", () => {
  it("reads Deals/Notes/Tasks with If-Modified-Since on the regional API host and stops at the cursor", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/crm/v6/Deals") {
        return {
          data: [
            { id: "d1", Deal_Name: "Acme renewal", Stage: "Negotiation", Amount: 12000.4, Closing_Date: "2026-09-30", Account_Name: { name: "Acme" }, Owner: { name: "Ana" }, Modified_Time: "2026-09-02T10:00:00+02:00", Modified_By: { name: "Ana" }, Description: "Pushed to Q4" },
            { id: "d0", Deal_Name: "Old", Modified_Time: "2026-08-01T10:00:00+02:00" },
          ],
          info: { more_records: true },
        };
      }
      if (req.path === "/crm/v6/Notes") {
        return { data: [{ id: "n1", Note_Title: "Call notes", Note_Content: "They want SSO", Parent_Id: { name: "Acme renewal" }, $se_module: "Deals", Modified_Time: "2026-09-03T09:00:00+02:00" }], info: { more_records: false } };
      }
      if (req.path === "/crm/v6/Tasks") return { status: 304, data: null };
      return { status: 500, data: {} };
    });
    const { signals } = await zohoCrmAdapter.fetchChanges({ client, ...base, connectionConfig: { extension: "eu" } });
    expect(calls[0]?.baseUrlOverride).toBe("https://www.zohoapis.eu");
    expect(calls[0]?.headers?.["If-Modified-Since"]).toBe("2026-09-01T00:00:00+00:00");
    expect(calls[0]?.query?.sort_by).toBe("Modified_Time");
    // The older deal stops paging even though more_records is true.
    expect(calls.filter((c) => c.path === "/crm/v6/Deals")).toHaveLength(1);
    const deal = signals.find((s) => s.external_id === "deals:d1");
    expect(deal?.title).toBe("Acme renewal");
    expect(deal?.text).toContain("Stage: Negotiation");
    expect(deal?.text).toContain("Amount: 12000");
    expect(deal?.url).toBe("https://crm.zoho.eu/crm/tab/Deals/d1");
    expect(deal?.at).toBe("2026-09-02T08:00:00.000Z");
    expect(signals.some((s) => s.external_id === "deals:d0")).toBe(false);
    const note = signals.find((s) => s.external_id === "notes:n1");
    expect(note?.text).toContain("On: Acme renewal (Deals)");
    expect(note?.text).toContain("They want SSO");
    expect(signals.some((s) => s.external_id.startsWith("tasks:"))).toBe(false);
    expect(zohoApiBase({ api_domain: "https://www.zohoapis.com.au/" })).toBe("https://www.zohoapis.com.au");
  });
});

describe("wrike adapter", () => {
  it("lists tasks updated since, resolves names and attaches comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/tasks") {
        return { data: [{ id: "T1", title: "Ship v2", status: "Active", importance: "High", permalink: "https://www.wrike.com/open.htm?id=1", updatedDate: "2026-09-02T10:00:00Z", dates: { due: "2026-09-10" }, responsibleIds: ["U1"], authorIds: ["U2"], description: "<p>Plan</p>" }] };
      }
      if (req.path === "/contacts/U1,U2") return { data: [{ id: "U1", firstName: "Ana", lastName: "Ruiz" }, { id: "U2", firstName: "Bo" }] };
      if (req.path === "/tasks/T1/comments") return { data: [{ id: "c1", authorId: "U2", text: "Blocked on <b>QA</b>", createdDate: "2026-09-02T11:00:00Z" }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await wrikeAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.updatedDate).toBe(JSON.stringify({ start: "2026-09-01T00:00:00Z" }));
    expect(calls[0]?.query?.sortField).toBe("UpdatedDate");
    const t = signals[0];
    expect(t?.external_id).toBe("task:T1");
    expect(t?.text).toContain("Responsible: Ana Ruiz");
    expect(t?.text).toContain("Bo (2026-09-02T11:00:00Z): Blocked on QA");
    expect(t?.author).toBe("Bo");
    expect(t?.url).toBe("https://www.wrike.com/open.htm?id=1");
    expect(stats?.tasks).toBe(1);
  });

  it("scopes to folders from config", async () => {
    const { client, calls } = fakeClient(() => ({ data: [] }));
    await wrikeAdapter.fetchChanges({ client, ...base, config: { folders: ["F1"] } });
    expect(calls[0]?.path).toBe("/folders/F1/tasks");
  });
});

describe("google tasks adapter", () => {
  it("walks every list with updatedMin and includes completed tasks", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/tasks/v1/users/@me/lists") return { items: [{ id: "L1", title: "Work" }] };
      if (req.path === "/tasks/v1/lists/L1/tasks") {
        return { items: [{ id: "t1", title: "Write ADR", notes: "About auth", status: "completed", completed: "2026-09-02T10:00:00Z", updated: "2026-09-02T10:00:00Z", webViewLink: "https://tasks.google.com/task/t1" }, { id: "t2" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await googleTasksAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.query?.updatedMin).toBe(since.toISOString());
    expect(calls[1]?.query?.showCompleted).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("task:L1:t1");
    expect(signals[0]?.text).toContain("List: Work · Status: completed");
    expect(signals[0]?.text).toContain("About auth");
    expect(stats?.lists).toBe(1);
  });
});

describe("google forms adapter", () => {
  it("requires form_ids, then maps responses to question titles", async () => {
    const { client } = fakeClient(() => ({}));
    expect(await googleFormsAdapter.fetchChanges({ client, ...base })).toEqual({ signals: [], stats: { missing_form_ids: 1 } });

    const { client: c2, calls } = fakeClient((req) => {
      if (req.path === "/v1/forms/F1") {
        return { formId: "F1", info: { title: "Retro" }, responderUri: "https://docs.google.com/forms/d/e/F1/viewform", items: [{ itemId: "i1", title: "What went well?", questionItem: { question: { questionId: "q1" } } }] };
      }
      if (req.path === "/v1/forms/F1/responses") {
        return { responses: [{ responseId: "r1", lastSubmittedTime: "2026-09-02T10:00:00Z", respondentEmail: "ana@acme.com", answers: { q1: { questionId: "q1", textAnswers: { answers: [{ value: "Shipping on time" }] } } } }] };
      }
      return { status: 500, data: {} };
    });
    const { signals } = await googleFormsAdapter.fetchChanges({ client: c2, ...base, config: { form_ids: ["F1"] } });
    expect(calls[1]?.query?.filter).toBe(`timestamp >= ${since.toISOString()}`);
    expect(signals[0]?.external_id).toBe("response:F1:r1");
    expect(signals[0]?.text).toContain("What went well?: Shipping on time");
    expect(signals[0]?.author).toBe("ana@acme.com");
    expect(questionTitles({ items: [{ title: "Grid", questionGroupItem: { questions: [{ questionId: "g1", rowQuestion: { title: "Row A" } }] } }] }).get("g1")).toBe("Grid — Row A");
  });
});

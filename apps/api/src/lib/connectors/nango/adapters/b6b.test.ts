/**
 * Batch 6b adapters — request shape + mapping against a fake proxy client.
 * Typeform, Jotform, Tally, Smartsheet, Basecamp.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { BASECAMP_TYPES, basecampAdapter } from "./basecamp";
import { jotformAdapter, jotformAnswerText, jotformDate, jotformToIso } from "./jotform";
import { smartsheetAdapter } from "./smartsheet";
import { tallyAdapter, tallyValueText } from "./tally";
import { typeformAdapter, typeformAnswerText } from "./typeform";

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

describe("typeform adapter", () => {
  it("lists forms, labels answers with field titles and passes `since` to the responses endpoint", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/forms") return { items: [{ id: "F1", title: "NPS", _links: { display: "https://x.typeform.com/to/F1" } }] };
      if (req.path === "/forms/F1")
        return { fields: [{ id: "q1", ref: "score", title: "How likely?" }, { id: "g", type: "group", properties: { fields: [{ id: "q2", title: "Why?" }] } }] };
      if (req.path === "/forms/F1/responses")
        return {
          items: [
            {
              response_id: "R1",
              submitted_at: "2026-09-02T09:00:00Z",
              hidden: { plan: "pro" },
              metadata: { referer: "https://acme.com/pricing" },
              answers: [
                { field: { id: "q1", ref: "score" }, type: "number", number: 9 },
                { field: { id: "q2" }, type: "text", text: "Fast support" },
                { field: { id: "q3" }, type: "choices", choices: { labels: ["A", "B"] } },
              ],
            },
          ],
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await typeformAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/forms");
    expect(calls[2]?.path).toBe("/forms/F1/responses");
    expect(calls[2]?.query).toMatchObject({ since: since.toISOString(), completed: true, page_size: 50, sort: "submitted_at,desc" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("response:R1");
    expect(signals[0]?.title).toBe("NPS · response 2026-09-02T09:00:00Z");
    expect(signals[0]?.text).toContain("- How likely?: 9");
    expect(signals[0]?.text).toContain("- Why?: Fast support");
    expect(signals[0]?.text).toContain("- q3: A, B");
    expect(signals[0]?.text).toContain("- plan: pro");
    expect(signals[0]?.url).toBe("https://x.typeform.com/to/F1");
    expect(signals[0]?.at).toBe("2026-09-02T09:00:00Z");
    expect(stats).toEqual({ forms: 1, responses: 1 });
  });

  it("honours the form_ids allow-list and flattens every answer type", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/forms") return { items: [{ id: "F1" }, { id: "F2" }] };
      if (req.path === "/forms/F2") return { fields: [] };
      if (req.path === "/forms/F2/responses") return { items: [] };
      return { status: 404, data: {} };
    });
    const { signals } = await typeformAdapter.fetchChanges({ client, ...base, config: { form_ids: ["F2"] } });
    expect(signals).toHaveLength(0);
    expect(calls.map((c) => c.path)).toEqual(["/forms", "/forms/F2", "/forms/F2/responses"]);
    expect(typeformAnswerText({ boolean: true })).toBe("yes");
    expect(typeformAnswerText({ choice: { label: "Blue" } })).toBe("Blue");
    expect(typeformAnswerText({ email: "a@b.c" })).toBe("a@b.c");
    expect(typeformAnswerText({ payment: { amount: "10", name: "Ana" } })).toBe("10 Ana");
  });
});

describe("jotform adapter", () => {
  it("filters submissions after the cursor, resolves form titles and maps answers", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/user/forms") return { content: [{ id: "100", title: "Contact us" }] };
      if (req.path === "/user/submissions")
        return {
          content: [
            {
              id: "S1",
              form_id: "100",
              created_at: "2026-09-03 10:15:00",
              status: "ACTIVE",
              answers: {
                "1": { name: "name", text: "Name", answer: { first: "Ana", last: "Ruiz" }, prettyFormat: "Ana Ruiz" },
                "2": { name: "msg", text: "Message", answer: "Need SSO" },
                "3": { name: "empty", text: "Empty", answer: "" },
              },
            },
          ],
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await jotformAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.path).toBe("/user/submissions");
    expect(calls[1]?.query).toMatchObject({ limit: 100, offset: 0, orderby: "created_at", direction: "DESC" });
    expect(JSON.parse(String(calls[1]?.query?.filter))).toEqual({ "created_at:gt": "2026-09-01 00:00:00" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("submission:S1");
    expect(signals[0]?.title).toBe("Contact us · submission 2026-09-03 10:15:00");
    expect(signals[0]?.text).toContain("- Name: Ana Ruiz");
    expect(signals[0]?.text).toContain("- Message: Need SSO");
    expect(signals[0]?.text).not.toContain("Empty");
    expect(signals[0]?.url).toBe("https://www.jotform.com/inbox/100/S1");
    expect(signals[0]?.at).toBe("2026-09-03T10:15:00Z");
    expect(stats).toEqual({ submissions: 1, skipped: 0 });
  });

  it("skips submissions outside form_ids and formats dates", async () => {
    const { client } = fakeClient((req) => {
      if (req.path === "/user/forms") return { content: [] };
      if (req.path === "/user/submissions") return { content: [{ id: "S2", form_id: "999", created_at: "2026-09-03 10:15:00", answers: {} }] };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await jotformAdapter.fetchChanges({ client, ...base, config: { form_ids: ["100"] } });
    expect(signals).toHaveLength(0);
    expect(stats).toEqual({ submissions: 0, skipped: 1 });
    expect(jotformDate(since)).toBe("2026-09-01 00:00:00");
    expect(jotformToIso("2026-09-03 10:15:00")).toBe("2026-09-03T10:15:00Z");
    expect(jotformAnswerText({ answer: ["a", "b"] })).toBe("a, b");
  });
});

describe("tally adapter", () => {
  it("reads completed submissions newest first and stops at the first one older than the cursor", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/forms") return { items: [{ id: "T1", name: "Beta signup", updatedAt: "2026-09-04T00:00:00Z" }] };
      if (req.path === "/forms/T1/submissions")
        return {
          hasMore: true,
          questions: [{ id: "q1", title: "Company" }, { id: "q2", title: "Use case" }],
          submissions: [
            { id: "s1", isCompleted: true, submittedAt: "2026-09-04T08:00:00Z", responses: [{ questionId: "q1", value: "Acme" }, { questionId: "q2", value: ["Docs", "Agents"] }] },
            { id: "s0", isCompleted: true, submittedAt: "2026-08-20T08:00:00Z", responses: [{ questionId: "q1", value: "Old" }] },
          ],
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await tallyAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.path).toBe("/forms/T1/submissions");
    expect(calls[1]?.query).toMatchObject({ page: 1, filter: "completed" });
    expect(calls).toHaveLength(2);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("submission:s1");
    expect(signals[0]?.text).toContain("- Company: Acme");
    expect(signals[0]?.text).toContain("- Use case: Docs, Agents");
    expect(signals[0]?.url).toBe("https://tally.so/forms/T1/submissions");
    expect(signals[0]?.at).toBe("2026-09-04T08:00:00Z");
    expect(stats).toEqual({ forms: 1, submissions: 1 });
    expect(tallyValueText([{ name: "file.pdf", url: "u" }])).toBe("file.pdf");
  });
});

describe("smartsheet adapter", () => {
  it("lists sheets modified since, reads changed rows with column titles and new comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/2.0/sheets") return { data: [{ id: 11, name: "Roadmap", permalink: "https://app.smartsheet.com/sheets/11", modifiedAt: "2026-09-05T10:00:00Z" }] };
      if (req.path === "/2.0/sheets/11")
        return {
          id: 11,
          name: "Roadmap",
          permalink: "https://app.smartsheet.com/sheets/11",
          columns: [{ id: 1, title: "Task" }, { id: 2, title: "Status" }],
          rows: [
            { id: 500, rowNumber: 3, modifiedAt: "2026-09-05T10:00:00Z", modifiedBy: { name: "Ana" }, cells: [{ columnId: 1, displayValue: "Ship v2" }, { columnId: 2, displayValue: "Done" }] },
            { id: 501, rowNumber: 4, modifiedAt: "2026-08-01T10:00:00Z", cells: [{ columnId: 1, displayValue: "Old" }] },
          ],
          discussions: [
            { title: "Ship v2", comments: [{ text: "Blocked on legal", createdAt: "2026-09-05T11:00:00Z", createdBy: { name: "Bo" } }, { text: "old", createdAt: "2026-07-01T00:00:00Z" }] },
          ],
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await smartsheetAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ modifiedSince: since.toISOString(), includeAll: true });
    expect(calls[1]?.path).toBe("/2.0/sheets/11");
    expect(calls[1]?.query).toMatchObject({ rowsModifiedSince: since.toISOString(), include: "discussions" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("sheet:11");
    expect(signals[0]?.title).toBe("Roadmap · 1 rows changed");
    expect(signals[0]?.text).toContain("- Row 3 (Ana): Task: Ship v2 · Status: Done");
    expect(signals[0]?.text).not.toContain("Old");
    expect(signals[0]?.text).toContain('- Bo (2026-09-05T11:00:00Z) on "Ship v2": Blocked on legal');
    expect(signals[0]?.text).not.toContain("old");
    expect(signals[0]?.at).toBe("2026-09-05T11:00:00Z");
    expect(signals[0]?.author).toBe("Ana");
    expect(stats).toEqual({ sheets: 1, rows: 1, comments: 1 });
  });

  it("uses sheet_ids directly without listing", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/2.0/sheets/7") return { id: 7, name: "Pinned", rows: [], discussions: [] };
      return { status: 404, data: {} };
    });
    const { signals } = await smartsheetAdapter.fetchChanges({ client, ...base, config: { sheet_ids: ["7"] } });
    expect(calls.map((c) => c.path)).toEqual(["/2.0/sheets/7"]);
    expect(signals).toHaveLength(0);
  });
});

describe("basecamp adapter", () => {
  it("queries recordings per type across the projects and stops at the cursor", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/projects.json") return [{ id: 1, name: "Launch" }, { id: 2, name: "Ops" }];
      if (req.path === "/projects/recordings.json" && req.query?.type === "Message")
        return [
          {
            id: 900,
            type: "Message",
            status: "active",
            title: "Pricing decision",
            content: "<div>We go with <strong>flat</strong> pricing.</div>",
            app_url: "https://3.basecamp.com/1/buckets/1/messages/900",
            updated_at: "2026-09-06T12:00:00Z",
            creator: { name: "Ana" },
            bucket: { id: 1, name: "Launch" },
          },
          { id: 800, type: "Message", title: "Old", content: "x", updated_at: "2026-08-01T00:00:00Z" },
        ];
      if (req.path === "/projects/recordings.json" && req.query?.type === "Todo")
        return [
          {
            id: 901,
            type: "Todo",
            title: "Update pricing page",
            description: "<p>Reflect flat pricing</p>",
            completed: false,
            due_on: "2026-09-10",
            assignees: [{ name: "Bo" }],
            app_url: "https://3.basecamp.com/1/buckets/1/todos/901",
            updated_at: "2026-09-06T13:00:00Z",
            creator: { name: "Ana" },
            bucket: { id: 1 },
            parent: { title: "Website", type: "Todolist" },
          },
        ];
      if (req.path === "/projects/recordings.json") return [];
      return { status: 404, data: {} };
    });
    const { signals, stats } = await basecampAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/projects.json");
    expect(calls.slice(1).map((c) => c.query?.type)).toEqual([...BASECAMP_TYPES]);
    expect(calls[1]?.query).toMatchObject({ bucket: "1,2", sort: "updated_at", direction: "desc" });
    expect(signals).toHaveLength(2);
    expect(signals[0]?.external_id).toBe("message:900");
    expect(signals[0]?.title).toBe("Pricing decision · Launch");
    expect(signals[0]?.text).toContain("We go with flat pricing.");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[1]?.external_id).toBe("todo:901");
    expect(signals[1]?.title).toBe("Update pricing page · Launch");
    expect(signals[1]?.text).toContain("Type: Todo · open · due 2026-09-10");
    expect(signals[1]?.text).toContain("Assignees: Bo");
    expect(signals[1]?.text).toContain("In: Website (Todolist)");
    expect(stats).toMatchObject({ projects: 2, recordings: 2, message: 1, todo: 1 });
  });

  it("filters projects by id or name and returns nothing when none match", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/projects.json") return [{ id: 1, name: "Launch" }];
      return [];
    });
    const { signals, stats } = await basecampAdapter.fetchChanges({ client, ...base, config: { projects: ["Nope"] } });
    expect(signals).toHaveLength(0);
    expect(stats).toEqual({ projects: 0, recordings: 0 });
    expect(calls).toHaveLength(1);
  });
});

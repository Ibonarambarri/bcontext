import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { airtableAdapter } from "./airtable";
import { confluenceAdapter } from "./confluence";
import { freshdeskAdapter } from "./freshdesk";
import { jiraAdapter } from "./jira";
import { adfToText, htmlToText, jqlDate } from "./shared";

function fakeClient(handler: (req: ProxyRequest) => unknown | { status: number; data: unknown }) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      const out = handler(req) as { status?: number; data?: unknown };
      const status = typeof out?.status === "number" ? out.status : 200;
      const data = out && "data" in out ? out.data : out;
      return { status, ok: status < 400, data, headers: new Headers() };
    },
  } as unknown as NangoClient;
  return { client, calls };
}

const since = new Date("2026-09-01T00:00:00Z");
const base = { connectionId: "c1", connectionConfig: { subdomain: "acme" }, config: {}, since, limit: 50 };

describe("text helpers", () => {
  it("flattens ADF and HTML", () => {
    const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] }] };
    expect(adfToText(adf).trim()).toBe("Hello world");
    expect(htmlToText("<p>One</p><p>Two &amp; three</p>")).toBe("One\nTwo & three");
    expect(jqlDate(since)).toBe("2026/09/01 00:00");
  });
});

describe("jira adapter", () => {
  it("searches by updated date, follows nextPageToken and maps issues", async () => {
    const { client, calls } = fakeClient((req) => {
      const token = req.query?.nextPageToken;
      return token
        ? { issues: [{ id: "2", key: "ACME-2", fields: { summary: "Second", updated: "2026-09-02T00:00:00Z" } }] }
        : {
            issues: [{ id: "1", key: "ACME-1", fields: { summary: "First", status: { name: "Done" }, reporter: { displayName: "Ana" }, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] } } }],
            nextPageToken: "p2",
          };
    });
    const { signals } = await jiraAdapter.fetchChanges({ client, ...base, config: { projects: ["ACME"] } });
    expect(calls[0]?.path).toBe("/rest/api/3/search/jql");
    expect(String(calls[0]?.query?.jql)).toContain('project in ("ACME")');
    expect(String(calls[0]?.query?.jql)).toContain('updated >= "2026/09/01 00:00"');
    expect(signals.map((s) => s.external_id)).toEqual(["issue:ACME-1", "issue:ACME-2"]);
    expect(signals[0]?.url).toBe("https://acme.atlassian.net/browse/ACME-1");
    expect(signals[0]?.text).toContain("Status: Done");
    expect(signals[0]?.text).toContain("Body");
    expect(signals[0]?.author).toBe("Ana");
  });

  it("throws on a non-2xx so the job retries", async () => {
    const { client } = fakeClient(() => ({ status: 401, data: {} }));
    await expect(jiraAdapter.fetchChanges({ client, ...base })).rejects.toThrow(/401/);
  });
});

describe("confluence adapter", () => {
  it("stops at the first page older than `since` and maps pages", async () => {
    const { client } = fakeClient(() => ({
      results: [
        { id: "10", title: "New", version: { createdAt: "2026-09-03T00:00:00Z" }, body: { storage: { value: "<p>Fresh</p>" } }, _links: { webui: "/spaces/X/pages/10" } },
        { id: "9", title: "Old", version: { createdAt: "2026-08-01T00:00:00Z" }, body: { storage: { value: "<p>Stale</p>" } } },
      ],
      _links: { next: "/wiki/api/v2/pages?cursor=abc" },
    }));
    const { signals } = await confluenceAdapter.fetchChanges({ client, ...base });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.url).toBe("https://acme.atlassian.net/wiki/spaces/X/pages/10");
    expect(signals[0]?.text).toBe("Fresh");
  });
});

describe("airtable adapter", () => {
  it("walks bases → tables → changed records", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v0/meta/bases") return { bases: [{ id: "appA", name: "Ops" }] };
      if (req.path === "/v0/meta/bases/appA/tables") return { tables: [{ id: "tblT", name: "Decisions" }] };
      return { records: [{ id: "rec1", createdTime: "2026-09-02T00:00:00Z", fields: { Title: "Ship it", Owner: ["Ana"] } }] };
    });
    const { signals } = await airtableAdapter.fetchChanges({ client, ...base });
    expect(signals[0]?.external_id).toBe("record:appA:tblT:rec1");
    expect(signals[0]?.text).toContain("Title: Ship it");
    expect(String(calls[2]?.query?.filterByFormula)).toContain("IS_AFTER(LAST_MODIFIED_TIME()");
  });
});

describe("freshdesk adapter", () => {
  it("lists tickets updated since and maps status names", async () => {
    const { client, calls } = fakeClient(() => [{ id: 7, subject: "Login broken", status: 4, priority: 2, description_text: "Cannot log in", updated_at: "2026-09-02T00:00:00Z" }]);
    const { signals } = await freshdeskAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.updated_since).toBe(since.toISOString());
    expect(signals[0]?.external_id).toBe("ticket:7");
    expect(signals[0]?.text).toContain("Status: Resolved");
    expect(signals[0]?.url).toBe("https://acme.freshdesk.com/a/tickets/7");
  });
});

/**
 * Batch 1 adapters — request shape + mapping against a fake proxy client.
 * Google Drive, Gmail, Google Calendar, Google Docs, Asana, ClickUp,
 * HubSpot, Zendesk, GitLab, Sentry.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { asanaAdapter } from "./asana";
import { clickupAdapter } from "./clickup";
import { gitlabAdapter } from "./gitlab";
import { gmailAdapter, gmailBodyText, gmailQuery } from "./gmail";
import { googleCalendarAdapter } from "./google-calendar";
import { docsToText, googleDocsAdapter } from "./google-docs";
import { driveQuery, googleDriveAdapter } from "./google-drive";
import { hubspotAdapter } from "./hubspot";
import { sentryAdapter, sentryNextCursor, sentrySince } from "./sentry";
import { zendeskAdapter } from "./zendesk";

type Reply = unknown | { status: number; data: unknown; headers?: Record<string, string> };

function fakeClient(handler: (req: ProxyRequest) => Reply) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      // A reply is an envelope only when it carries a numeric `status`;
      // otherwise it is the provider body verbatim (Asana wraps in `data`).
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
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("google drive adapter", () => {
  it("lists files modified since, exports Google Docs as text and maps binaries by name", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/drive/v3/files") {
        return {
          files: [
            { id: "d1", name: "Roadmap", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-02T10:00:00Z", webViewLink: "https://docs.google.com/document/d/d1", lastModifyingUser: { displayName: "Ana" } },
            { id: "p1", name: "deck.pdf", mimeType: "application/pdf", modifiedTime: "2026-09-02T11:00:00Z", description: "Board deck" },
          ],
        };
      }
      if (req.path === "/drive/v3/files/d1/export") return "We decided to ship in October.";
      return { status: 500, data: {} };
    });
    const { signals } = await googleDriveAdapter.fetchChanges({ client, ...base, config: { folder_ids: ["f1"] } });
    expect(String(calls[0]?.query?.q)).toBe(driveQuery(since, ["f1"]));
    expect(String(calls[0]?.query?.q)).toContain("'f1' in parents");
    expect(calls[0]?.query?.includeItemsFromAllDrives).toBe(true);
    expect(calls[1]?.query?.mimeType).toBe("text/plain");
    expect(signals.map((s) => s.external_id)).toEqual(["file:d1", "file:p1"]);
    expect(signals[0]?.text).toContain("We decided to ship in October.");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.kind_hint).toBe("document");
    expect(signals[1]?.text).toContain("Board deck");
    expect(signals[1]?.kind_hint).toBe("file");
  });
});

describe("gmail adapter", () => {
  it("builds the query and decodes the text/plain part of each message", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/gmail/v1/users/me/messages") return { messages: [{ id: "m1", threadId: "t1" }] };
      return {
        id: "m1",
        threadId: "t1",
        internalDate: "1788400000000",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "Subject", value: "Contract renewal" }, { name: "From", value: "Ana <ana@acme.com>" }],
          parts: [
            { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
            { mimeType: "text/plain", body: { data: b64url("We agreed on a 12-month renewal.") } },
          ],
        },
      };
    });
    const { signals } = await gmailAdapter.fetchChanges({ client, ...base, config: { labels: ["NEXO"] } });
    expect(String(calls[0]?.query?.q)).toBe(gmailQuery(since, ["NEXO"]));
    expect(String(calls[0]?.query?.q)).toContain("label:NEXO");
    expect(gmailQuery(since, null)).toContain("-category:promotions");
    expect(calls[1]?.path).toBe("/gmail/v1/users/me/messages/m1");
    expect(calls[1]?.query?.format).toBe("full");
    expect(signals[0]?.title).toBe("Contract renewal");
    expect(signals[0]?.text).toContain("We agreed on a 12-month renewal.");
    expect(signals[0]?.author).toBe("Ana <ana@acme.com>");
    expect(signals[0]?.url).toBe("https://mail.google.com/mail/u/0/#all/t1");
    expect(gmailBodyText({ id: "x", snippet: "fallback" })).toBe("fallback");
  });
});

describe("google calendar adapter", () => {
  it("lists events updated since and keeps only those with a description or attendees", async () => {
    const { client, calls } = fakeClient(() => ({
      items: [
        { id: "e1", summary: "Pricing review", description: "<p>Decide new tiers</p>", updated: "2026-09-02T00:00:00Z", htmlLink: "https://cal/e1", start: { dateTime: "2026-09-03T09:00:00Z" }, end: { dateTime: "2026-09-03T10:00:00Z" }, organizer: { displayName: "Ana" }, attendees: [{ email: "bo@acme.com" }] },
        { id: "e2", summary: "Lunch", updated: "2026-09-02T00:00:00Z" },
        { id: "e3", summary: "Cancelled", status: "cancelled", description: "x" },
      ],
    }));
    const { signals, stats } = await googleCalendarAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/calendar/v3/calendars/primary/events");
    expect(calls[0]?.query?.updatedMin).toBe(since.toISOString());
    expect(calls[0]?.query?.singleEvents).toBe(true);
    expect(signals.map((s) => s.external_id)).toEqual(["event:primary:e1"]);
    expect(signals[0]?.text).toContain("Attendees: bo@acme.com");
    expect(signals[0]?.text).toContain("Decide new tiers");
    expect(stats?.skipped).toBe(1);
  });
});

describe("google docs adapter", () => {
  it("reads pinned documents and keys signals by revision", async () => {
    const { client, calls } = fakeClient(() => ({
      documentId: "doc1",
      title: "Handbook",
      revisionId: "r9",
      body: { content: [{ paragraph: { elements: [{ textRun: { content: "Rule one.\n" } }] } }, { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "a" } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: "b" } }] } }] }] }] } }] },
    }));
    const { signals } = await googleDocsAdapter.fetchChanges({ client, ...base, config: { document_ids: ["doc1"] } });
    expect(calls[0]?.path).toBe("/v1/documents/doc1");
    expect(signals[0]?.external_id).toBe("document:doc1:r9");
    expect(signals[0]?.text).toBe("Rule one.\na | b");
    expect(docsToText(undefined)).toBe("");
    const empty = await googleDocsAdapter.fetchChanges({ client, ...base });
    expect(empty.signals).toHaveLength(0);
  });
});

describe("asana adapter", () => {
  it("walks workspaces → projects → tasks modified since, plus status updates", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/1.0/workspaces") return { data: [{ gid: "w1" }] };
      if (req.path === "/api/1.0/projects") return { data: [{ gid: "p1", name: "Launch" }, { gid: "p2", name: "Other" }] };
      if (req.path === "/api/1.0/tasks") return { data: [{ gid: "t1", name: "Write announcement", notes: "Draft by Friday", modified_at: "2026-09-02T00:00:00Z", permalink_url: "https://app.asana.com/0/p1/t1", assignee: { name: "Ana" }, completed: false }] };
      if (req.path === "/api/1.0/status_updates") return { data: [{ gid: "s1", title: "On track", text: "Shipping Oct 1", status_type: "on_track", created_at: "2026-09-03T00:00:00Z", created_by: { name: "Bo" } }, { gid: "s0", title: "Old", created_at: "2026-08-01T00:00:00Z" }] };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await asanaAdapter.fetchChanges({ client, ...base, config: { projects: ["Launch"] } });
    expect(calls.find((c) => c.path === "/api/1.0/tasks")?.query?.modified_since).toBe(since.toISOString());
    expect(calls.find((c) => c.path === "/api/1.0/tasks")?.query?.project).toBe("p1");
    expect(signals.map((s) => s.external_id)).toEqual(["task:t1", "status_update:s1"]);
    expect(signals[0]?.title).toBe("Launch · Write announcement");
    expect(signals[1]?.text).toContain("Shipping Oct 1");
    expect(stats?.projects).toBe(1);
  });
});

describe("clickup adapter", () => {
  it("lists tasks updated since per team in milliseconds", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/v2/team") return { teams: [{ id: "9", name: "Acme" }] };
      return { tasks: [{ id: "abc", name: "Fix login", status: { status: "in progress" }, url: "https://app.clickup.com/t/abc", date_updated: "1788400000000", text_content: "Users cannot log in", list: { name: "Bugs" }, assignees: [{ username: "ana" }] }], last_page: true };
    });
    const { signals } = await clickupAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.path).toBe("/api/v2/team/9/task");
    expect(calls[1]?.query?.date_updated_gt).toBe(since.getTime());
    expect(calls[1]?.query?.include_closed).toBe(true);
    expect(signals[0]?.external_id).toBe("task:abc");
    expect(signals[0]?.text).toContain("Status: in progress");
    expect(signals[0]?.text).toContain("Assignees: ana");
    expect(signals[0]?.at).toBe(new Date(1788400000000).toISOString());
  });
});

describe("hubspot adapter", () => {
  it("searches deals, notes, calls and meetings by last modified", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/crm/v3/objects/deals/search") return { results: [{ id: "d1", properties: { dealname: "Acme renewal", dealstage: "closedwon", amount: "1200", hs_lastmodifieddate: "2026-09-02T00:00:00Z" } }] };
      if (req.path === "/crm/v3/objects/notes/search") return { results: [{ id: "n1", properties: { hs_note_body: "<p>Client wants SSO</p>", hs_lastmodifieddate: "2026-09-02T00:00:00Z" } }, { id: "n2", properties: { hs_note_body: "" } }] };
      return { results: [] };
    });
    const { signals } = await hubspotAdapter.fetchChanges({ client, ...base, config: { portal_id: "123" } });
    expect(calls.map((c) => c.path)).toEqual(["/crm/v3/objects/deals/search", "/crm/v3/objects/notes/search", "/crm/v3/objects/calls/search", "/crm/v3/objects/meetings/search"]);
    const body = calls[0]?.body as { filterGroups: Array<{ filters: Array<{ propertyName: string; value: string }> }> };
    expect(body.filterGroups[0]?.filters[0]).toEqual({ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since.getTime()) });
    expect(signals.map((s) => s.external_id)).toEqual(["deals:d1", "notes:n1"]);
    expect(signals[0]?.url).toBe("https://app.hubspot.com/contacts/123/deal/d1");
    expect(signals[1]?.text).toBe("Client wants SSO");
  });
});

describe("zendesk adapter", () => {
  it("uses the incremental cursor export and pulls comments for solved tickets", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/v2/incremental/tickets/cursor.json") {
        return { tickets: [{ id: 7, subject: "Login broken", status: "solved", description: "Cannot log in", updated_at: "2026-09-02T00:00:00Z" }, { id: 8, subject: "Question", status: "open" }], after_cursor: "c2", end_of_stream: true };
      }
      return { comments: [{ id: 1, plain_body: "Reset your password", public: true, created_at: "2026-09-02T01:00:00Z" }, { id: 2, plain_body: "internal", public: false }] };
    });
    const { signals } = await zendeskAdapter.fetchChanges({ client, ...base, connectionConfig: { subdomain: "acme" } });
    expect(calls[0]?.query?.start_time).toBe(Math.floor(since.getTime() / 1000));
    expect(calls[1]?.path).toBe("/api/v2/tickets/7/comments.json");
    expect(signals[0]?.url).toBe("https://acme.zendesk.com/agent/tickets/7");
    expect(signals[0]?.text).toContain("Reset your password");
    expect(signals[0]?.text).not.toContain("internal");
    expect(signals[1]?.external_id).toBe("ticket:8");
    expect(calls).toHaveLength(2);
  });
});

describe("gitlab adapter", () => {
  it("lists merge requests and issues updated after the cursor, per project when configured", async () => {
    const { client, calls } = fakeClient((req) =>
      req.path.endsWith("/merge_requests")
        ? [{ id: 1, iid: 4, title: "Add SSO", state: "opened", merged_at: null, web_url: "https://gitlab.com/acme/app/-/merge_requests/4", updated_at: "2026-09-02T00:00:00Z", author: { name: "Ana" }, references: { full: "acme/app!4" }, labels: ["auth"] }]
        : [{ id: 2, iid: 9, title: "Login bug", state: "closed", web_url: "https://gitlab.com/acme/app/-/issues/9", updated_at: "2026-09-02T00:00:00Z", description: "500 on login" }],
    );
    const { signals } = await gitlabAdapter.fetchChanges({ client, ...base, config: { projects: ["acme/app"] } });
    expect(calls[0]?.path).toBe("/api/v4/projects/acme%2Fapp/merge_requests");
    expect(calls[0]?.query?.updated_after).toBe(since.toISOString());
    expect(calls[1]?.path).toBe("/api/v4/projects/acme%2Fapp/issues");
    expect(signals.map((s) => s.external_id)).toEqual(["merge_request:1", "issue:2"]);
    expect(signals[0]?.title).toBe("acme/app!4 · Add SSO");
    expect(signals[0]?.text).toContain("Labels: auth");
    expect(signals[1]?.text).toContain("500 on login");
    const all = fakeClient(() => []);
    await gitlabAdapter.fetchChanges({ client: all.client, ...base });
    expect(all.calls[0]?.path).toBe("/api/v4/merge_requests");
    expect(all.calls[0]?.query?.scope).toBe("all");
  });
});

describe("sentry adapter", () => {
  it("resolves the organization, searches issues by lastSeen and follows the Link cursor", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/0/organizations/") return [{ slug: "acme" }];
      if (req.query?.cursor) return [{ id: "2", shortId: "APP-2", title: "TypeError", level: "error", status: "unresolved", count: "12", userCount: 3, lastSeen: "2026-09-02T00:00:00Z", permalink: "https://sentry.io/acme/app/issues/2/" }];
      return { status: 200, data: [{ id: "1", shortId: "APP-1", title: "Timeout", level: "warning", isRegression: true, lastSeen: "2026-09-03T00:00:00Z", project: { slug: "app" } }], headers: { link: '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/organizations/acme/issues/?cursor=0:50:0>; rel="next"; results="true"; cursor="0:50:0"' } };
    });
    const { signals } = await sentryAdapter.fetchChanges({ client, ...base, config: { projects: ["11"] } });
    expect(calls[1]?.path).toBe("/0/organizations/acme/issues/");
    expect(calls[1]?.query?.query).toBe(`lastSeen:>${sentrySince(since)}`);
    expect(calls[1]?.query?.project).toBe("11");
    expect(calls[2]?.query?.cursor).toBe("0:50:0");
    expect(signals.map((s) => s.external_id)).toEqual(["issue:1", "issue:2"]);
    expect(signals[0]?.text).toContain("REGRESSION");
    expect(signals[1]?.text).toContain("Events: 12 · Users: 3");
    expect(sentrySince(since)).toBe("2026-09-01T00:00:00");
    expect(sentryNextCursor(null)).toBeNull();
    expect(sentryNextCursor('<u>; rel="next"; results="false"; cursor="x"')).toBeNull();
  });
});

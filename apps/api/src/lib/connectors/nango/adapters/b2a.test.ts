/**
 * Batch 2a adapters — request shape + mapping against a fake proxy client.
 * Microsoft Teams, Outlook, OneDrive, SharePoint, Trello.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { graphNextPath } from "./graph";
import { messageText, microsoftTeamsAdapter } from "./microsoft-teams";
import { driveItemPath, isTextLike, onedriveAdapter } from "./onedrive";
import { outlookAdapter, outlookBodyText, recipient } from "./outlook";
import { sharepointAdapter } from "./sharepoint";
import { describeAction, trelloAdapter } from "./trello";

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

describe("graph helpers", () => {
  it("turns an absolute nextLink into a proxy path and keeps the query", () => {
    expect(graphNextPath("https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc")).toBe("/v1.0/me/messages?$skiptoken=abc");
    expect(graphNextPath(undefined)).toBeNull();
  });
});

describe("microsoft teams adapter", () => {
  it("walks joined teams → channels → delta messages since, flattens html and appends replies", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/me/joinedTeams") return { value: [{ id: "t1", displayName: "Product" }, { id: "t2", displayName: "Sales" }] };
      if (req.path === "/v1.0/teams/t1/channels") return { value: [{ id: "ch1", displayName: "General", webUrl: "https://teams/ch1" }, { id: "ch2", displayName: "Random" }] };
      if (req.path === "/v1.0/teams/t1/channels/ch1/messages/delta") {
        return {
          value: [
            { id: "m1", messageType: "message", createdDateTime: "2026-09-02T09:00:00Z", lastModifiedDateTime: "2026-09-02T09:05:00Z", webUrl: "https://teams/m1", from: { user: { displayName: "Ana" } }, body: { contentType: "html", content: "<p>We <b>decided</b> to ship in October.</p>" } },
            { id: "sys", messageType: "systemEventMessage", body: { contentType: "text", content: "x joined" } },
          ],
        };
      }
      if (req.path === "/v1.0/teams/t1/channels/ch1/messages/m1/replies") {
        return { value: [{ id: "r1", createdDateTime: "2026-09-02T09:10:00Z", from: { user: { displayName: "Bo" } }, body: { contentType: "text", content: "Agreed." } }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await microsoftTeamsAdapter.fetchChanges({ client, ...base, config: { teams: ["Product"], channels: ["ch1"] } });
    expect(calls[2]?.path).toBe("/v1.0/teams/t1/channels/ch1/messages/delta");
    expect(String(calls[2]?.query?.$filter)).toBe("lastModifiedDateTime gt 2026-09-01T00:00:00.000Z");
    expect(calls.some((c) => c.path === "/v1.0/teams/t2/channels")).toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("message:ch1:m1");
    expect(signals[0]?.title).toBe("Product / #General · We decided to ship in October.");
    expect(signals[0]?.text).toContain("We decided to ship in October.");
    expect(signals[0]?.text).toContain("- Bo (2026-09-02T09:10:00Z): Agreed.");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-02T09:05:00Z");
    expect(stats?.skipped).toBe(1);
    expect(messageText({ id: "x", body: { contentType: "text", content: " plain " } })).toBe("plain");
  });
});

describe("outlook adapter", () => {
  it("filters by receivedDateTime per folder, asks for text bodies and skips drafts", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/me/mailFolders/inbox/messages") {
        return {
          value: [
            { id: "e1", subject: "Renewal", body: { contentType: "html", content: "<p>12-month renewal agreed.</p>" }, from: { emailAddress: { name: "Ana", address: "ana@acme.com" } }, toRecipients: [{ emailAddress: { address: "bo@acme.com" } }], receivedDateTime: "2026-09-02T08:00:00Z", webLink: "https://outlook/e1", hasAttachments: true },
            { id: "d1", subject: "Draft", isDraft: true, body: { contentType: "text", content: "x" } },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=next",
        };
      }
      if (req.path === "/v1.0/me/mailFolders/inbox/messages?$skiptoken=next") return { value: [] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await outlookAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/v1.0/me/mailFolders/inbox/messages");
    expect(String(calls[0]?.query?.$filter)).toBe("receivedDateTime ge 2026-09-01T00:00:00.000Z");
    expect(calls[0]?.headers?.Prefer).toBe('outlook.body-content-type="text"');
    expect(calls[1]?.path).toBe("/v1.0/me/mailFolders/inbox/messages?$skiptoken=next");
    expect(calls[1]?.query).toBeUndefined();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("message:e1");
    expect(signals[0]?.title).toBe("Renewal");
    expect(signals[0]?.text).toContain("From: Ana <ana@acme.com>");
    expect(signals[0]?.text).toContain("To: bo@acme.com");
    expect(signals[0]?.text).toContain("12-month renewal agreed.");
    expect(signals[0]?.url).toBe("https://outlook/e1");
    expect(signals[0]?.at).toBe("2026-09-02T08:00:00Z");
    expect(stats?.skipped).toBe(1);
    expect(recipient({ emailAddress: { name: "Ana" } })).toBe("Ana");
    expect(outlookBodyText({ id: "x", bodyPreview: "preview" })).toBe("preview");
  });

  it("honours the folders allow-list", async () => {
    const { client, calls } = fakeClient(() => ({ value: [] }));
    await outlookAdapter.fetchChanges({ client, ...base, config: { folders: ["archive", "AAMk123"] } });
    expect(calls.map((c) => c.path)).toEqual(["/v1.0/me/mailFolders/archive/messages", "/v1.0/me/mailFolders/AAMk123/messages"]);
  });
});

describe("onedrive adapter", () => {
  it("reads recent items, keeps only those modified after since, downloads text-like files", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/me/drive/recent") {
        return {
          value: [
            { id: "f1", name: "notes.md", size: 120, file: { mimeType: "text/markdown" }, lastModifiedDateTime: "2026-09-02T10:00:00Z", webUrl: "https://od/f1", lastModifiedBy: { user: { displayName: "Ana" } }, parentReference: { path: "/drive/root:/Team", driveId: "d1" } },
            { id: "f2", name: "deck.pptx", size: 5_000_000, file: { mimeType: "application/vnd.ms-powerpoint" }, lastModifiedDateTime: "2026-09-02T11:00:00Z", parentReference: { path: "/drive/root:/Team" } },
            { id: "old", name: "old.txt", size: 10, file: {}, lastModifiedDateTime: "2026-08-01T00:00:00Z" },
            { id: "dir", name: "Folder", folder: { childCount: 2 }, lastModifiedDateTime: "2026-09-03T00:00:00Z" },
          ],
        };
      }
      if (req.path === "/v1.0/drives/d1/items/f1/content") return "Decision: freeze scope for Q4.";
      return { status: 500, data: {} };
    });
    const { signals, stats } = await onedriveAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/v1.0/me/drive/recent");
    expect(calls[1]?.path).toBe("/v1.0/drives/d1/items/f1/content");
    expect(signals.map((s) => s.external_id)).toEqual(["item:f1", "item:f2"]);
    expect(signals[0]?.text).toContain("Path: /Team/notes.md");
    expect(signals[0]?.text).toContain("Decision: freeze scope for Q4.");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.kind_hint).toBe("document");
    expect(signals[1]?.kind_hint).toBe("file");
    expect(stats?.skipped).toBe(1);
    expect(isTextLike({ id: "x", name: "a.docx", size: 10, file: {} })).toBe(false);
    expect(driveItemPath({ id: "x", name: "a.txt", parentReference: { path: "/drives/d/root:/A/B" } })).toBe("/A/B/a.txt");
  });

  it("lists folder children newest-first when folder_ids is set", async () => {
    const { client, calls } = fakeClient(() => ({ value: [] }));
    await onedriveAdapter.fetchChanges({ client, ...base, config: { folder_ids: ["F1"] } });
    expect(calls[0]?.path).toBe("/v1.0/me/drive/items/F1/children");
    expect(calls[0]?.query?.$orderby).toBe("lastModifiedDateTime desc");
  });
});

describe("sharepoint adapter", () => {
  it("discovers sites, lists documents per site and site pages modified since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/sites") return { value: [{ id: "s1", displayName: "Intranet" }] };
      if (req.path === "/v1.0/sites/s1/drive/root/search(q='')") {
        return { value: [{ id: "doc1", name: "policy.txt", size: 50, file: { mimeType: "text/plain" }, lastModifiedDateTime: "2026-09-02T00:00:00Z", webUrl: "https://sp/doc1", parentReference: { path: "/drives/x/root:/Shared", driveId: "x" } }] };
      }
      if (req.path === "/v1.0/drives/x/items/doc1/content") return "Remote work policy v2.";
      if (req.path === "/v1.0/sites/s1/pages/microsoft.graph.sitePage") {
        return { value: [{ id: "p1", title: "Onboarding", description: "How we onboard", webUrl: "https://sp/p1", lastModifiedDateTime: "2026-09-03T00:00:00Z" }, { id: "p0", title: "Old", lastModifiedDateTime: "2026-01-01T00:00:00Z" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await sharepointAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/v1.0/sites");
    expect(calls[0]?.query?.search).toBe("*");
    expect(signals.map((s) => s.external_id)).toEqual(["item:doc1", "page:s1:p1"]);
    expect(signals[0]?.text).toContain("Site Intranet · Path: /Shared/policy.txt");
    expect(signals[0]?.text).toContain("Remote work policy v2.");
    expect(signals[1]?.title).toBe("Onboarding");
    expect(signals[1]?.kind_hint).toBe("page");
    expect(stats?.sites).toBe(1);
  });

  it("uses site_ids when configured", async () => {
    const { client, calls } = fakeClient(() => ({ value: [] }));
    await sharepointAdapter.fetchChanges({ client, ...base, config: { site_ids: ["contoso.sharepoint.com,guid1,guid2"] } });
    expect(calls[0]?.path).toBe("/v1.0/sites/contoso.sharepoint.com%2Cguid1%2Cguid2/drive/root/search(q='')");
  });
});

describe("trello adapter", () => {
  it("lists open boards, pulls actions since per board and groups them per card", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/1/members/me/boards") return [{ id: "b1", name: "Roadmap", url: "https://trello.com/b/b1" }, { id: "b2", name: "Personal" }];
      if (req.path === "/1/boards/b1/actions") {
        return [
          { id: "a2", type: "commentCard", date: "2026-09-02T12:00:00Z", memberCreator: { fullName: "Bo" }, data: { text: "Let's ship it", card: { id: "c1", name: "Launch", shortLink: "abc" } } },
          { id: "a1", type: "updateCard", date: "2026-09-02T10:00:00Z", memberCreator: { fullName: "Ana" }, data: { card: { id: "c1", name: "Launch", shortLink: "abc" }, listBefore: { name: "Doing" }, listAfter: { name: "Done" }, old: { idList: "l1" } } },
          { id: "a3", type: "createCard", date: "2026-09-02T09:00:00Z", memberCreator: { fullName: "Ana" }, data: { card: { id: "c2", name: "Hire" }, list: { name: "Backlog" } } },
        ];
      }
      if (req.path === "/1/cards/c1") return { id: "c1", name: "Launch v2", desc: "Ship the new pricing.", shortUrl: "https://trello.com/c/abc", closed: false };
      if (req.path === "/1/cards/c2") return { status: 404, data: {} };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await trelloAdapter.fetchChanges({ client, ...base, config: { boards: ["Roadmap"] } });
    expect(calls[0]?.path).toBe("/1/members/me/boards");
    expect(calls[1]?.path).toBe("/1/boards/b1/actions");
    expect(calls[1]?.query?.since).toBe(since.toISOString());
    expect(calls[1]?.query?.filter).toBe("commentCard,updateCard,createCard");
    expect(calls.some((c) => c.path === "/1/boards/b2/actions")).toBe(false);
    expect(signals.map((s) => s.external_id)).toEqual(["card:c1", "card:c2"]);
    expect(signals[0]?.title).toBe("Roadmap · Launch v2");
    expect(signals[0]?.text).toContain("Ship the new pricing.");
    expect(signals[0]?.text).toContain('- Ana (2026-09-02T10:00:00Z): moved from "Doing" to "Done"');
    expect(signals[0]?.text).toContain("- Bo (2026-09-02T12:00:00Z): commented: Let's ship it");
    expect(signals[0]?.url).toBe("https://trello.com/c/abc");
    expect(signals[0]?.at).toBe("2026-09-02T12:00:00Z");
    expect(signals[0]?.author).toBe("Bo");
    expect(signals[1]?.title).toBe("Roadmap · Hire");
    expect(signals[1]?.url).toBe("https://trello.com/b/b1");
    expect(stats).toMatchObject({ boards: 1, actions: 3, cards: 2 });
    expect(describeAction({ id: "x", type: "updateCard", memberCreator: { fullName: "A" }, data: { old: { closed: false } } })).toContain("archived the card");
  });
});

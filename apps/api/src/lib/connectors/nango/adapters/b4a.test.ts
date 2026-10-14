/**
 * Batch 4a adapters — request shape + mapping against a fake proxy client.
 * Todoist, Coda, Miro, Dropbox, Box.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { BOX_FILE_FIELDS, boxAdapter, boxSinceRange } from "./box";
import { codaAdapter } from "./coda";
import { dropboxAdapter } from "./dropbox";
import { MIRO_ITEM_TYPES, miroAdapter } from "./miro";
import { todoistAdapter, todoistSince } from "./todoist";

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

describe("todoist adapter", () => {
  it("emits tasks created after the cursor with comments, then completed tasks, honouring the project allow-list", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/rest/v2/projects") return [{ id: "p1", name: "Launch" }, { id: "p2", name: "Other" }];
      if (req.path === "/rest/v2/tasks") {
        return [
          { id: "t1", project_id: "p1", content: "Write pricing page", description: "Use the new tiers.", priority: 4, labels: ["web"], url: "https://app.todoist.com/app/task/t1", created_at: "2026-09-02T08:00:00Z", due: { string: "Sep 10" }, creator_id: "u1" },
          { id: "t0", project_id: "p1", content: "Old", created_at: "2026-08-01T08:00:00Z" },
          { id: "t9", project_id: "p2", content: "Not allowed", created_at: "2026-09-03T08:00:00Z" },
        ];
      }
      if (req.path === "/rest/v2/comments") return [{ id: "c1", content: "Draft ready", posted_at: "2026-09-02T09:00:00Z" }];
      if (req.path === "/sync/v9/completed/get_all") {
        return { items: [{ task_id: "t5", project_id: "p1", content: "Ship v1", completed_at: "2026-09-02T12:00:00Z" }, { task_id: "t6", project_id: "p2", content: "Elsewhere", completed_at: "2026-09-02T12:00:00Z" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await todoistAdapter.fetchChanges({ client, ...base, config: { projects: ["Launch"] } });
    expect(calls[0]?.path).toBe("/rest/v2/projects");
    expect(calls[1]?.path).toBe("/rest/v2/tasks");
    expect(calls[1]?.query).toEqual({ project_id: "p1" });
    expect(calls[2]?.path).toBe("/rest/v2/comments");
    expect(calls[2]?.query).toEqual({ task_id: "t1" });
    expect(calls[3]?.path).toBe("/sync/v9/completed/get_all");
    expect(calls[3]?.query).toMatchObject({ since: todoistSince(since), project_id: "p1" });
    expect(todoistSince(since)).toBe("2026-09-01T00:00:00");
    expect(signals.map((s) => s.external_id)).toEqual(["task:t1", "task:t5:completed"]);
    expect(signals[0]?.title).toBe("Launch · Write pricing page");
    expect(signals[0]?.text).toContain("Priority: p1 · Labels: web");
    expect(signals[0]?.text).toContain("Due: Sep 10");
    expect(signals[0]?.text).toContain("Draft ready");
    expect(signals[0]?.url).toBe("https://app.todoist.com/app/task/t1");
    expect(signals[0]?.at).toBe("2026-09-02T08:00:00Z");
    expect(signals[1]?.text).toContain("Status: completed at 2026-09-02T12:00:00Z");
    expect(signals[1]?.url).toBe("https://app.todoist.com/app/task/t5");
    expect(stats).toEqual({ created: 1, completed: 1, comments: 1 });
  });

  it("fails loudly when the task listing fails", async () => {
    const { client } = fakeClient((req) => (req.path === "/rest/v2/projects" ? [] : { status: 401, data: {} }));
    await expect(todoistAdapter.fetchChanges({ client, ...base })).rejects.toThrow(/todoist tasks failed \(401\)/);
  });
});

describe("coda adapter", () => {
  it("lists docs updated after the cursor and emits one signal per changed page", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/docs") {
        return {
          items: [
            { id: "d1", name: "Product notes", browserLink: "https://coda.io/d/d1", updatedAt: "2026-09-02T10:00:00Z", ownerName: "Ana", workspace: { name: "Acme" }, folder: { name: "Product" } },
            { id: "d0", name: "Stale", updatedAt: "2026-08-01T10:00:00Z" },
          ],
        };
      }
      if (req.path === "/docs/d1/pages") {
        return {
          items: [
            { id: "pg1", name: "Pricing decision", subtitle: "Why tiers", browserLink: "https://coda.io/d/d1/pg1", updatedAt: "2026-09-02T10:00:00Z", contentType: "canvas", parent: { name: "Decisions" } },
            { id: "pg0", name: "Old", updatedAt: "2026-07-01T00:00:00Z" },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await codaAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/docs");
    expect(calls[0]?.query).toMatchObject({ isOwner: false, limit: 100 });
    expect(calls[1]?.path).toBe("/docs/d1/pages");
    expect(calls).toHaveLength(2);
    expect(signals.map((s) => s.external_id)).toEqual(["page:d1:pg1"]);
    expect(signals[0]?.title).toBe("Product notes · Pricing decision");
    expect(signals[0]?.text).toContain("Doc: Product notes (Acme / Product)");
    expect(signals[0]?.text).toContain("Parent page: Decisions");
    expect(signals[0]?.text).toContain("Subtitle: Why tiers");
    expect(signals[0]?.url).toBe("https://coda.io/d/d1/pg1");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00Z");
    expect(stats).toEqual({ docs: 1, pages: 1 });
  });

  it("fetches pinned docs directly and falls back to a doc-level signal when no page changed", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/docs/d7") return { id: "d7", name: "Pinned", browserLink: "https://coda.io/d/d7", updatedAt: "2026-09-05T00:00:00Z", owner: "bo@acme.com" };
      if (req.path === "/docs/d7/pages") return { items: [] };
      return { status: 500, data: {} };
    });
    const { signals } = await codaAdapter.fetchChanges({ client, ...base, config: { doc_ids: ["d7"] } });
    expect(calls[0]?.path).toBe("/docs/d7");
    expect(signals.map((s) => s.external_id)).toEqual(["doc:d7"]);
    expect(signals[0]?.author).toBe("bo@acme.com");
    expect(signals[0]?.at).toBe("2026-09-05T00:00:00Z");
  });
});

describe("miro adapter", () => {
  it("keeps boards modified after the cursor and folds their sticky notes, text and cards into one signal", async () => {
    let boardPages = 0;
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/boards") {
        boardPages++;
        if (boardPages > 1) return { data: [{ id: "b0", name: "Older", modifiedAt: "2026-08-01T09:00:00Z" }] };
        return {
          data: [
            { id: "b1", name: "Q4 planning", viewLink: "https://miro.com/app/board/b1", modifiedAt: "2026-09-03T09:00:00Z", modifiedBy: { name: "Ana" } },
            { id: "b2", name: "Excluded", modifiedAt: "2026-09-03T09:00:00Z" },
            { id: "b0", name: "Old", modifiedAt: "2026-08-01T09:00:00Z" },
          ],
          cursor: "next",
        };
      }
      if (req.path === "/v2/boards/b1/items") {
        const type = String(req.query?.type);
        if (type === "sticky_note") return { data: [{ id: "i1", type, data: { content: "<p>Cut scope to 3 features</p>" }, createdBy: { name: "Bo" } }] };
        if (type === "text") return { data: [{ id: "i2", type, data: { content: "" } }] };
        if (type === "card") return { data: [{ id: "i3", type, data: { title: "Hire SRE", description: "Before Nov" } }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await miroAdapter.fetchChanges({ client, ...base, config: { boards: ["b1"] } });
    expect(calls[0]?.path).toBe("/v2/boards");
    expect(calls[0]?.query).toMatchObject({ sort: "last_modified", limit: 50 });
    // Allow-list excludes b2, time excludes b0; page 2 is fetched because page 1 had a recent board, then stops.
    expect(calls.filter((c) => c.path === "/v2/boards")).toHaveLength(2);
    const itemCalls = calls.filter((c) => c.path === "/v2/boards/b1/items");
    expect(itemCalls.map((c) => c.query?.type)).toEqual([...MIRO_ITEM_TYPES]);
    expect(signals.map((s) => s.external_id)).toEqual(["board:b1"]);
    expect(signals[0]?.title).toBe("Q4 planning");
    expect(signals[0]?.text).toContain("[sticky_note · Bo] Cut scope to 3 features");
    expect(signals[0]?.text).toContain("[card] Hire SRE — Before Nov");
    expect(signals[0]?.text).not.toContain("[text]");
    expect(signals[0]?.url).toBe("https://miro.com/app/board/b1");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-03T09:00:00Z");
    expect(stats).toEqual({ boards: 1, items: 2 });
  });
});

describe("dropbox adapter", () => {
  it("walks list_folder recursively with continue and keeps files modified after the cursor", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/2/files/list_folder") {
        return {
          entries: [
            { ".tag": "file", id: "id:1", name: "Roadmap.md", path_display: "/Docs/Roadmap.md", path_lower: "/docs/roadmap.md", server_modified: "2026-09-02T10:00:00Z", size: 1200, rev: "r1", sharing_info: { modified_by: "dbid:ana" } },
            { ".tag": "folder", id: "id:f", name: "Docs", path_lower: "/docs" },
            { ".tag": "file", id: "id:0", name: "Old.txt", path_lower: "/old.txt", server_modified: "2026-01-01T00:00:00Z" },
          ],
          cursor: "cur1",
          has_more: true,
        };
      }
      if (req.path === "/2/files/list_folder/continue") {
        return { entries: [{ ".tag": "file", id: "id:2", name: "Notes.txt", path_display: "/Notes.txt", path_lower: "/notes.txt", server_modified: "2026-09-04T10:00:00Z" }], cursor: "cur2", has_more: false };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await dropboxAdapter.fetchChanges({ client, ...base, config: { folders: ["/Docs"] } });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ path: "/Docs", recursive: true });
    expect(calls[1]?.path).toBe("/2/files/list_folder/continue");
    expect(calls[1]?.body).toEqual({ cursor: "cur1" });
    expect(signals.map((s) => s.external_id)).toEqual(["file:id:2", "file:id:1"]);
    expect(signals[1]?.title).toBe("Roadmap.md");
    expect(signals[1]?.text).toContain("Path: /Docs/Roadmap.md");
    expect(signals[1]?.text).toContain("Modified: 2026-09-02T10:00:00Z by dbid:ana");
    expect(signals[1]?.url).toBe("https://www.dropbox.com/home/docs/roadmap.md");
    expect(signals[1]?.at).toBe("2026-09-02T10:00:00Z");
    expect(stats).toEqual({ entries: 4, files: 2 });
  });

  it("defaults to the root folder", async () => {
    const { client, calls } = fakeClient(() => ({ entries: [], has_more: false }));
    await dropboxAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.body).toMatchObject({ path: "" });
  });
});

describe("box adapter", () => {
  it("searches files updated after the cursor under the allow-listed folders and adds comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/2.0/search") {
        return {
          entries: [
            { id: "f1", type: "file", name: "Contract.docx", description: "Acme MSA", size: 5000, modified_at: "2026-09-02T10:00:00Z", modified_by: { name: "Ana" }, shared_link: { url: "https://acme.box.com/s/abc" }, path_collection: { entries: [{ name: "All Files" }, { name: "Legal" }] } },
            { id: "f0", type: "file", name: "Old.pdf", modified_at: "2026-08-01T10:00:00Z" },
          ],
          total_count: 2,
          offset: 0,
          limit: 50,
        };
      }
      if (req.path === "/2.0/files/f1/comments") return { entries: [{ id: "c1", message: "Signed version attached", created_at: "2026-09-02T11:00:00Z", created_by: { name: "Bo" } }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await boxAdapter.fetchChanges({ client, ...base, config: { folders: ["123"] } });
    expect(calls[0]?.path).toBe("/2.0/search");
    expect(calls[0]?.query).toMatchObject({ type: "file", updated_at_range: boxSinceRange(since), sort: "modified_at", direction: "DESC", fields: BOX_FILE_FIELDS, ancestor_folder_ids: "123", limit: 50, offset: 0 });
    expect(boxSinceRange(since)).toBe("2026-09-01T00:00:00Z,");
    expect(calls[1]?.path).toBe("/2.0/files/f1/comments");
    expect(calls).toHaveLength(2);
    expect(signals.map((s) => s.external_id)).toEqual(["file:f1"]);
    expect(signals[0]?.title).toBe("Contract.docx");
    expect(signals[0]?.text).toContain("Folder: All Files / Legal");
    expect(signals[0]?.text).toContain("Acme MSA");
    expect(signals[0]?.text).toContain("Bo (2026-09-02T11:00:00Z): Signed version attached");
    expect(signals[0]?.url).toBe("https://acme.box.com/s/abc");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00Z");
    expect(stats).toEqual({ files: 1, comments: 1 });
  });

  it("fails loudly when search fails", async () => {
    const { client } = fakeClient(() => ({ status: 403, data: {} }));
    await expect(boxAdapter.fetchChanges({ client, ...base })).rejects.toThrow(/box search failed \(403\)/);
  });
});

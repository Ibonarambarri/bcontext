/**
 * Batch 9b adapters — request shape + mapping against a fake proxy client.
 * Google Slides, Microsoft Planner, Word, Excel, Power BI.
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { NangoClient as RealNangoClient } from "@/lib/nango/client";
import { googleSlidesAdapter, presentationToText } from "./google-slides";
import { microsoftExcelAdapter } from "./microsoft-excel";
import { microsoftPlannerAdapter, priorityLabel, taskChangedSince } from "./microsoft-planner";
import { microsoftPowerBiAdapter, refreshError } from "./microsoft-power-bi";
import { microsoftWordAdapter } from "./microsoft-word";
import { docxToText, documentXmlToText, zipEntry } from "./ms-office";

type Reply = unknown | { status: number; data: unknown };

function fakeClient(handler: (req: ProxyRequest) => Reply) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      const out = handler(req) as { status?: number; data?: unknown };
      const envelope = !!out && typeof out === "object" && !Buffer.isBuffer(out) && typeof out.status === "number";
      const status = envelope ? out.status! : 200;
      const data = envelope ? out.data : out;
      return { status, ok: status < 400, data, headers: new Headers() };
    },
  } as unknown as NangoClient;
  return { client, calls };
}

const since = new Date("2026-09-01T00:00:00Z");
const base = { connectionId: "c1", connectionConfig: {}, config: {}, since, limit: 50 };

/** A minimal stored/deflated zip with one entry, enough for zipEntry(). */
function makeZip(name: string, content: Buffer, deflate = true): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const data = deflate ? deflateRawSync(content) : content;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localOffset = 0;
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(deflate ? 8 : 0, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(localOffset, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, cd, nameBuf, eocd]);
}

const DOC_XML = `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Decision:</w:t></w:r><w:r><w:t xml:space="preserve"> ship in Q4 &amp; freeze scope</w:t></w:r></w:p><w:p><w:r><w:t>Owner</w:t></w:r><w:tab/><w:r><w:t>Ana</w:t></w:r></w:p></w:body></w:document>`;

describe("ms-office helpers", () => {
  it("reads word/document.xml out of a deflated docx and flattens it", () => {
    const zip = makeZip("word/document.xml", Buffer.from(DOC_XML));
    expect(zipEntry(zip, "word/document.xml")?.toString("utf8")).toBe(DOC_XML);
    expect(zipEntry(zip, "word/other.xml")).toBeNull();
    expect(docxToText(zip)).toBe("Decision: ship in Q4 & freeze scope\nOwner\tAna");
    const stored = makeZip("word/document.xml", Buffer.from(DOC_XML), false);
    expect(docxToText(stored)).toContain("Decision:");
    expect(docxToText(Buffer.from("not a zip"))).toBe("");
    expect(documentXmlToText("<w:p><w:tc><w:t>a</w:t></w:tc><w:tc><w:t>b</w:t></w:tc></w:p>")).toBe("a | b |");
  });
});

describe("nango client responseType", () => {
  it("returns the raw body as a Buffer when asked", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    const client = new RealNangoClient({ serverUrl: "https://n.test", secretKey: "k" }, async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const res = await client.proxy<Buffer>({ method: "GET", providerConfigKey: "microsoft-word", connectionId: "c", path: "/x", responseType: "buffer" });
    expect(Buffer.isBuffer(res.data)).toBe(true);
    expect(Buffer.compare(res.data, bytes)).toBe(0);
  });
});

describe("google slides adapter", () => {
  it("does nothing without presentation_ids", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const { signals, stats } = await googleSlidesAdapter.fetchChanges({ client, ...base });
    expect(signals).toEqual([]);
    expect(stats?.note_no_presentation_ids).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("reads each pinned deck with a fields mask and flattens slides + notes", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/presentations/p1") {
        return {
          title: "Q4 plan",
          slides: [
            {
              objectId: "s1",
              pageElements: [
                { shape: { text: { textElements: [{ textRun: { content: "RoadmapQ4" } }] } } },
                { table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: "Item" } }] } }, { text: { textElements: [{ textRun: { content: "Owner" } }] } }] }] } },
              ],
              slideProperties: {
                notesPage: {
                  pageElements: [
                    { shape: { placeholder: { type: "SLIDE_IMAGE" }, text: { textElements: [{ textRun: { content: "ignored" } }] } } },
                    { shape: { placeholder: { type: "BODY" }, text: { textElements: [{ textRun: { content: "Say why we chose Q4" } }] } } },
                  ],
                },
              },
            },
            { objectId: "s2", pageElements: [] },
          ],
        };
      }
      return { status: 404, data: {} };
    });
    const { signals, stats } = await googleSlidesAdapter.fetchChanges({ client, ...base, config: { presentation_ids: ["p1", "missing"] } });
    expect(calls[0]?.path).toBe("/v1/presentations/p1");
    expect(String(calls[0]?.query?.fields)).toContain("notesPage");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("presentation:p1");
    expect(signals[0]?.title).toBe("Q4 plan");
    expect(signals[0]?.text).toContain("Slide 1:\nRoadmap\nQ4\nItem | Owner\nNotes: Say why we chose Q4");
    expect(signals[0]?.text).not.toContain("ignored");
    expect(signals[0]?.url).toBe("https://docs.google.com/presentation/d/p1/edit");
    expect(signals[0]?.at).toBe(since.toISOString());
    expect(stats?.skipped).toBe(1);
    expect(presentationToText({ slides: [] })).toBe("");
  });
});

describe("microsoft planner adapter", () => {
  it("lists my plans, keeps tasks created or completed since, resolves buckets and reads details", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/me/planner/plans") return { value: [{ id: "pl1", title: "Launch" }] };
      if (req.path === "/v1.0/planner/plans/pl1/buckets") return { value: [{ id: "b1", name: "Doing" }] };
      if (req.path === "/v1.0/planner/plans/pl1/tasks") {
        return {
          value: [
            { id: "t1", title: "Write launch post", bucketId: "b1", percentComplete: 100, priority: 1, createdDateTime: "2026-08-20T00:00:00Z", completedDateTime: "2026-09-03T10:00:00Z", completedBy: { user: { displayName: "Ana" } }, assignments: { u1: {} } },
            { id: "t2", title: "Old task", createdDateTime: "2026-08-01T00:00:00Z", completedDateTime: null },
            { id: "t3", title: "New task", createdDateTime: "2026-09-05T00:00:00Z", createdBy: { user: { displayName: "Bo" } } },
          ],
        };
      }
      if (req.path === "/v1.0/planner/tasks/t1/details") return { description: "Draft in Notion", checklist: { c1: { title: "Review", isChecked: true }, c2: { title: "Publish", isChecked: false } } };
      if (req.path === "/v1.0/planner/tasks/t3/details") return { description: "" };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await microsoftPlannerAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/v1.0/me/planner/plans");
    expect(signals.map((s) => s.external_id)).toEqual(["task:t1", "task:t3"]);
    expect(signals[0]?.title).toBe("Launch · Write launch post");
    expect(signals[0]?.text).toContain("Bucket: Doing");
    expect(signals[0]?.text).toContain("Priority: urgent");
    expect(signals[0]?.text).toContain("- [x] Review");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00Z");
    expect(signals[1]?.author).toBe("Bo");
    expect(signals[1]?.at).toBe("2026-09-05T00:00:00Z");
    expect(stats?.skipped).toBe(1);
    expect(priorityLabel(9)).toBe("low");
    expect(taskChangedSince({ id: "x", createdDateTime: "2026-08-01T00:00:00Z" }, since)).toBeNull();
  });

  it("reads configured plan ids directly", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/planner/plans/pl9") return { id: "pl9", title: "Ops" };
      if (req.path === "/v1.0/planner/plans/pl9/buckets") return { value: [] };
      if (req.path === "/v1.0/planner/plans/pl9/tasks") return { value: [] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await microsoftPlannerAdapter.fetchChanges({ client, ...base, config: { plan_ids: ["pl9"] } });
    expect(calls.some((c) => c.path === "/v1.0/me/planner/plans")).toBe(false);
    expect(signals).toEqual([]);
    expect(stats?.plans).toBe(1);
  });
});

describe("microsoft word adapter", () => {
  it("searches .docx modified since, downloads as buffer and extracts the text", async () => {
    const zip = makeZip("word/document.xml", Buffer.from(DOC_XML));
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/me/drive/root/search(q='.docx')") {
        return {
          value: [
            { id: "d1", name: "Launch plan.docx", size: 1200, webUrl: "https://onedrive/d1", lastModifiedDateTime: "2026-09-02T00:00:00Z", lastModifiedBy: { user: { displayName: "Ana" } }, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, parentReference: { path: "/drive/root:/Plans" } },
            { id: "old", name: "Old.docx", size: 10, lastModifiedDateTime: "2026-08-01T00:00:00Z", file: {} },
            { id: "big", name: "Huge.docx", size: 5_000_000, lastModifiedDateTime: "2026-09-03T00:00:00Z", file: {}, parentReference: { driveId: "drv2", path: "/drives/drv2/root:/Shared" } },
            { id: "notdoc", name: "notes.txt", size: 5, lastModifiedDateTime: "2026-09-03T00:00:00Z", file: {} },
          ],
        };
      }
      if (req.path === "/v1.0/me/drive/items/d1/content") return zip;
      return { status: 500, data: {} };
    });
    const { signals, stats } = await microsoftWordAdapter.fetchChanges({ client, ...base });
    const download = calls.find((c) => c.path === "/v1.0/me/drive/items/d1/content");
    expect(download?.responseType).toBe("buffer");
    expect(signals.map((s) => s.external_id)).toEqual(["doc:big", "doc:d1"]);
    const d1 = signals.find((s) => s.external_id === "doc:d1");
    expect(d1?.text).toContain("Document: /Plans/Launch plan.docx · Last edited by: Ana");
    expect(d1?.text).toContain("Decision: ship in Q4 & freeze scope");
    expect(d1?.url).toBe("https://onedrive/d1");
    expect(d1?.at).toBe("2026-09-02T00:00:00Z");
    expect(signals.find((s) => s.external_id === "doc:big")?.text).toContain("content not extracted");
    expect(calls.some((c) => c.path.includes("/drives/drv2/items/big/content"))).toBe(false);
    expect(stats?.downloads).toBe(1);
    expect(stats?.skipped).toBe(1);
  });
});

describe("microsoft excel adapter", () => {
  it("lists .xlsx modified since and renders the first sheets through the workbook API", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/me/drive/items/f1/children") {
        return { value: [{ id: "x1", name: "KPIs.xlsx", size: 100, webUrl: "https://onedrive/x1", lastModifiedDateTime: "2026-09-04T00:00:00Z", file: {}, parentReference: { path: "/drive/root:/Finance" } }] };
      }
      if (req.path === "/v1.0/me/drive/items/x1/workbook/worksheets") return { value: [{ id: "{1}", name: "Summary" }, { id: "{2}", name: "Hidden", visibility: "Hidden" }, { id: "{3}", name: "Empty" }] };
      if (req.path === "/v1.0/me/drive/items/x1/workbook/worksheets/%7B1%7D/usedRange") return { address: "Summary!A1:B3", values: [["Metric", "Value"], ["MRR", 1200], ["", ""]] };
      if (req.path === "/v1.0/me/drive/items/x1/workbook/worksheets/%7B3%7D/usedRange") return { values: [] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await microsoftExcelAdapter.fetchChanges({ client, ...base, config: { folder_ids: ["f1"] } });
    expect(calls[0]?.path).toBe("/v1.0/me/drive/items/f1/children");
    expect(calls[0]?.query?.$orderby).toBe("lastModifiedDateTime desc");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("sheet:x1:{1}");
    expect(signals[0]?.title).toBe("KPIs.xlsx · Summary");
    expect(signals[0]?.text).toContain("Workbook: /Finance/KPIs.xlsx · Sheet: Summary (Summary!A1:B3)");
    expect(signals[0]?.text).toContain("Metric | Value\nMRR | 1200");
    expect(signals[0]?.at).toBe("2026-09-04T00:00:00Z");
    expect(calls.some((c) => c.path.includes("%7B2%7D"))).toBe(false);
    expect(stats?.sheets).toBe(1);
  });

  it("falls back to a name-only signal when the workbook cannot be opened", async () => {
    const { client } = fakeClient((req) => {
      if (req.path === "/v1.0/me/drive/root/search(q='.xlsx')") return { value: [{ id: "x2", name: "Locked.xlsx", size: 10, lastModifiedDateTime: "2026-09-04T00:00:00Z", file: {} }] };
      return { status: 423, data: {} };
    });
    const { signals } = await microsoftExcelAdapter.fetchChanges({ client, ...base });
    expect(signals[0]?.external_id).toBe("workbook:x2");
    expect(signals[0]?.text).toContain("could not be opened");
  });
});

describe("power bi adapter", () => {
  it("emits the inventory with the cursor instant and refreshes ended since, failures first", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1.0/myorg/reports") return { value: [{ id: "r1", name: "Sales", webUrl: "https://app.powerbi.com/r1", datasetId: "ds1" }] };
      if (req.path === "/v1.0/myorg/dashboards") return { value: [{ id: "db1", displayName: "Exec", webUrl: "https://app.powerbi.com/db1" }] };
      if (req.path === "/v1.0/myorg/datasets") return { value: [{ id: "ds1", name: "Sales model", configuredBy: "ana@acme.test", webUrl: "https://app.powerbi.com/ds1" }] };
      if (req.path === "/v1.0/myorg/datasets/ds1/refreshes") {
        return {
          value: [
            { requestId: "rq1", refreshType: "Scheduled", startTime: "2026-09-03T01:00:00Z", endTime: "2026-09-03T01:05:00Z", status: "Failed", serviceExceptionJson: '{"errorCode":"ModelRefresh_ShortMessage_ProcessingError","errorDescription":"Timeout"}' },
            { requestId: "rq0", refreshType: "Scheduled", startTime: "2026-08-20T01:00:00Z", endTime: "2026-08-20T01:05:00Z", status: "Completed" },
            { requestId: "rq2", refreshType: "OnDemand", startTime: "2026-09-04T01:00:00Z", endTime: "2026-09-04T01:02:00Z", status: "Completed" },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await microsoftPowerBiAdapter.fetchChanges({ client, ...base });
    expect(calls.find((c) => c.path === "/v1.0/myorg/datasets/ds1/refreshes")?.query?.$top).toBe(5);
    expect(signals[0]?.external_id).toBe("refresh:ds1:rq1");
    expect(signals[0]?.kind_hint).toBe("incident");
    expect(signals[0]?.text).toContain("Error: ModelRefresh_ShortMessage_ProcessingError: Timeout");
    expect(signals[0]?.at).toBe("2026-09-03T01:05:00Z");
    expect(signals.map((s) => s.external_id)).toEqual(["refresh:ds1:rq1", "report:r1", "dashboard:db1", "refresh:ds1:rq2"]);
    expect(signals.find((s) => s.external_id === "report:r1")?.at).toBe(since.toISOString());
    expect(stats).toMatchObject({ reports: 1, dashboards: 1, datasets: 1, refreshes: 2, failed: 1 });
    expect(refreshError({ serviceExceptionJson: "garbage" })).toBe("garbage");
  });

  it("scopes to configured workspaces", async () => {
    const { client, calls } = fakeClient(() => ({ value: [] }));
    await microsoftPowerBiAdapter.fetchChanges({ client, ...base, config: { workspace_ids: ["g1"] } });
    expect(calls[0]?.path).toBe("/v1.0/myorg/groups/g1/reports");
    expect(calls.some((c) => c.path === "/v1.0/myorg/reports")).toBe(false);
  });
});

/**
 * Batch 3a adapters — request shape + mapping against a fake proxy client.
 * Zoom, Google Meet, Google Sheets, Pipedrive, Attio.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { attioAdapter, attioRecordText, attioUpdatedAt, attioValueText } from "./attio";
import { googleMeetAdapter, meetFilter, participantName } from "./google-meet";
import { googleSheetsAdapter, sheetRange, valuesToText } from "./google-sheets";
import { pipedriveAdapter, pipedriveSince, pipedriveTime } from "./pipedrive";
import { summaryToText, vttToText, zoomAdapter, zoomMeetingPath, zoomWindow } from "./zoom";

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

describe("zoom adapter", () => {
  it("reads AI Companion summaries, then transcripts for uncovered recordings via Base-Url-Override", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/meetings/meeting_summaries") {
        return {
          summaries: [
            { meeting_uuid: "u1", meeting_topic: "Pricing", meeting_start_time: "2026-09-02T09:00:00Z", summary_last_modified_time: "2026-09-02T10:00:00Z", summary_title: "Pricing sync", meeting_host_email: "ana@acme.com" },
            { meeting_uuid: "old", meeting_topic: "Old", summary_last_modified_time: "2026-08-01T10:00:00Z" },
          ],
        };
      }
      if (req.path === "/meetings/u1/meeting_summary") {
        return { summary_overview: "We agreed to raise prices.", summary_details: [{ label: "Tiers", summary: "Three tiers." }], next_steps: ["Ana drafts the page"] };
      }
      if (req.path === "/users/me/recordings") {
        return {
          meetings: [
            { uuid: "u1", topic: "Pricing", start_time: "2026-09-02T09:00:00Z", recording_files: [{ file_type: "TRANSCRIPT", download_url: "https://acme.zoom.us/rec/download/aaa" }] },
            { uuid: "u2", topic: "Retro", start_time: "2026-09-03T09:00:00Z", share_url: "https://zoom.us/rec/share/u2", recording_files: [{ file_type: "MP4", download_url: "https://acme.zoom.us/rec/download/mp4" }, { file_type: "TRANSCRIPT", download_url: "https://acme.zoom.us/rec/download/bbb?x=1" }] },
          ],
        };
      }
      if (req.path === "/rec/download/bbb?x=1") return "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nAna: We ship Friday.\n\n2\n00:00:04.000 --> 00:00:05.000\nBo: Agreed.\n";
      return { status: 500, data: {} };
    });
    const { signals, stats } = await zoomAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.from).toBe(zoomWindow(since).from);
    expect(signals.map((s) => s.external_id)).toEqual(["summary:u1", "transcript:u2"]);
    expect(signals[0]?.text).toContain("We agreed to raise prices.");
    expect(signals[0]?.text).toContain("Next steps:\n- Ana drafts the page");
    expect(signals[0]?.author).toBe("ana@acme.com");
    const dl = calls.find((c) => c.path === "/rec/download/bbb?x=1");
    expect(dl?.baseUrlOverride).toBe("https://acme.zoom.us");
    expect(signals[1]?.text).toContain("Ana: We ship Friday.\nBo: Agreed.");
    expect(signals[1]?.url).toBe("https://zoom.us/rec/share/u2");
    expect(stats?.summaries).toBe(1);
    expect(stats?.transcripts).toBe(1);
  });

  it("helpers: 30-day window clamp, uuid double-encoding, vtt and summary flattening", () => {
    const now = new Date("2026-09-08T12:00:00Z");
    expect(zoomWindow(new Date("2026-01-01T00:00:00Z"), now)).toEqual({ from: "2026-08-09", to: "2026-09-08" });
    expect(zoomWindow(new Date("2026-09-05T00:00:00Z"), now)).toEqual({ from: "2026-09-05", to: "2026-09-08" });
    expect(zoomMeetingPath("abc+def")).toBe("abc%2Bdef");
    expect(zoomMeetingPath("/abc//d")).toBe(encodeURIComponent(encodeURIComponent("/abc//d")));
    expect(vttToText("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n")).toBe("Hi");
    expect(summaryToText({})).toBe("");
  });
});

describe("google meet adapter", () => {
  it("lists conferences since, resolves participants and joins transcript entries", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/conferenceRecords") return { conferenceRecords: [{ name: "conferenceRecords/c1", startTime: "2026-09-02T09:00:00Z", endTime: "2026-09-02T10:00:00Z" }] };
      if (req.path === "/v2/conferenceRecords/c1/transcripts") return { transcripts: [{ name: "conferenceRecords/c1/transcripts/t1", state: "FILE_GENERATED", endTime: "2026-09-02T10:00:00Z", docsDestination: { exportUri: "https://docs.google.com/document/d/x" } }] };
      if (req.path === "/v2/conferenceRecords/c1/participants") return { participants: [{ name: "conferenceRecords/c1/participants/p1", signedinUser: { displayName: "Ana" } }] };
      if (req.path === "/v2/conferenceRecords/c1/transcripts/t1/entries") {
        return { transcriptEntries: [{ participant: "conferenceRecords/c1/participants/p1", text: "We ship Friday." }, { participant: "conferenceRecords/c1/participants/p9", text: "Ok." }] };
      }
      return { status: 500, data: {} };
    });
    const { signals } = await googleMeetAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.filter).toBe(meetFilter(since));
    expect(String(calls[0]?.query?.filter)).toBe('start_time>="2026-09-01T00:00:00.000Z"');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("transcript:conferenceRecords/c1/transcripts/t1");
    expect(signals[0]?.text).toContain("Ana: We ship Friday.\nParticipant: Ok.");
    expect(signals[0]?.url).toBe("https://docs.google.com/document/d/x");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00Z");
    expect(participantName({ name: "x", phoneUser: { displayName: "+34" } })).toBe("+34");
  });
});

describe("google sheets adapter", () => {
  it("does nothing without spreadsheet_ids and reads every tab of pinned spreadsheets", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v4/spreadsheets/s1") return { properties: { title: "OKRs" }, sheets: [{ properties: { sheetId: 0, title: "Q3" } }, { properties: { sheetId: 7, title: "Team's list" } }] };
      if (req.path.startsWith("/v4/spreadsheets/s1/values/")) {
        return req.path.includes("Q3") ? { values: [["Objective", "Owner", ""], ["Ship v2", "Ana"], []] } : { values: [] };
      }
      return { status: 500, data: {} };
    });
    const none = await googleSheetsAdapter.fetchChanges({ client, ...base });
    expect(none.signals).toHaveLength(0);
    const { signals } = await googleSheetsAdapter.fetchChanges({ client, ...base, config: { spreadsheet_ids: ["s1"] } });
    expect(calls[1]?.path).toBe(`/v4/spreadsheets/s1/values/${encodeURIComponent(sheetRange("Q3"))}`);
    expect(sheetRange("Team's list")).toBe("'Team''s list'!A1:Z200");
    expect(signals.map((s) => s.external_id)).toEqual(["sheet:s1:0"]);
    expect(signals[0]?.title).toBe("OKRs · Q3");
    expect(signals[0]?.text).toBe("Objective | Owner\nShip v2 | Ana");
    expect(signals[0]?.url).toBe("https://docs.google.com/spreadsheets/d/s1/edit#gid=0");
    expect(valuesToText(undefined)).toBe("");
  });
});

describe("pipedrive adapter", () => {
  it("walks deals and notes newest-first until the cursor, and activities since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/deals") {
        return {
          data: [
            { id: 1, title: "Acme renewal", value: 1200, currency: "EUR", status: "won", won_time: "2026-09-02 10:00:00", pipeline_id: 1, update_time: "2026-09-02 10:00:00", owner_name: "Ana", org_name: "Acme" },
            { id: 2, title: "Other pipeline", status: "open", pipeline_id: 2, update_time: "2026-09-02 09:00:00" },
            { id: 3, title: "Stale", status: "open", pipeline_id: 1, update_time: "2026-08-20 09:00:00" },
          ],
          additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } },
        };
      }
      if (req.path === "/v1/notes") return { data: [{ id: 9, content: "<p>They want <b>SSO</b></p>", deal_id: 1, deal: { title: "Acme renewal" }, update_time: "2026-09-03 08:00:00", user: { name: "Bo" } }], additional_data: { pagination: { more_items_in_collection: false } } };
      if (req.path === "/v1/activities") return { data: [{ id: 5, subject: "Demo", type: "meeting", done: true, due_date: "2026-09-04", update_time: "2026-09-04 12:00:00", deal_id: 1, deal_title: "Acme renewal", note: "<p>Went well</p>", owner_name: "Ana" }], additional_data: { pagination: { more_items_in_collection: false } } };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await pipedriveAdapter.fetchChanges({ client, ...base, connectionConfig: { api_domain: "https://acme.pipedrive.com" }, config: { pipelines: ["1"] } });
    expect(calls[0]?.query?.sort).toBe("update_time DESC");
    expect(calls.filter((c) => c.path === "/v1/deals")).toHaveLength(1); // stopped at the stale deal
    expect(calls.find((c) => c.path === "/v1/activities")?.query?.since).toBe(pipedriveSince(since));
    expect(pipedriveSince(since)).toBe("2026-09-01 00:00:00");
    expect(signals.map((s) => s.external_id)).toEqual(["deal:1", "note:9", "activity:5"]);
    expect(signals[0]?.text).toContain("Won 2026-09-02 10:00:00 · 1200 EUR");
    expect(signals[0]?.url).toBe("https://acme.pipedrive.com/deal/1");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00.000Z");
    expect(signals[1]?.text).toBe("They want SSO");
    expect(signals[1]?.author).toBe("Bo");
    expect(signals[2]?.title).toBe("meeting · Demo");
    expect(stats?.deals).toBe(1);
    expect(pipedriveTime("nope")).toBeNull();
  });
});

describe("attio adapter", () => {
  it("queries records per object, derives the last change from active_from and lists notes", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/objects/deals/records/query") {
        return {
          data: [
            { id: { record_id: "r1" }, created_at: "2026-08-01T00:00:00Z", web_url: "https://app.attio.com/acme/deals/r1", values: { name: [{ value: "Acme", active_from: "2026-08-01T00:00:00Z" }], stage: [{ status: { title: "Won" }, active_from: "2026-09-02T10:00:00Z" }, { status: { title: "Open" }, active_from: "2026-08-01T00:00:00Z", active_until: "2026-09-02T10:00:00Z" }], value: [{ currency_value: 1200, currency_code: "EUR", active_from: "2026-08-01T00:00:00Z" }] } },
            { id: { record_id: "r2" }, created_at: "2026-07-01T00:00:00Z", values: { name: [{ value: "Stale", active_from: "2026-07-01T00:00:00Z" }] } },
          ],
        };
      }
      if (req.path === "/v2/objects/companies/records/query") return { data: [] };
      if (req.path === "/v2/notes") return { data: [{ id: { note_id: "n1" }, parent_object: "deals", parent_record_id: "r1", title: "Call", content_plaintext: "They asked for SSO.", created_at: "2026-09-03T00:00:00Z", created_by_actor: { name: "Bo" } }, { id: { note_id: "n0" }, content_plaintext: "old", created_at: "2026-08-01T00:00:00Z" }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await attioAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.method).toBe("POST");
    expect((calls[0]?.body as { limit: number }).limit).toBe(50);
    expect(signals.map((s) => s.external_id)).toEqual(["deals:r1", "note:n1"]);
    expect(signals[0]?.title).toBe("Acme");
    expect(signals[0]?.text).toBe("name: Acme\nstage: Won\nvalue: 1200 EUR");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00Z");
    expect(signals[0]?.url).toBe("https://app.attio.com/acme/deals/r1");
    expect(signals[1]?.text).toContain("They asked for SSO.");
    expect(signals[1]?.author).toBe("Bo");
    expect(stats?.deals).toBe(1);
    expect(stats?.notes).toBe(1);
    expect(attioValueText({ full_name: "Ana B" })).toBe("Ana B");
    expect(attioValueText({ target_object: "companies", target_record_id: "x" })).toBe("→ companies/x");
    expect(attioUpdatedAt({})).toBeUndefined();
    expect(attioRecordText({ values: { name: [{ value: "X" }] } })).toEqual({ title: "X", text: "name: X" });
  });
});

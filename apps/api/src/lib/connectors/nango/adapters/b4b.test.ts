/**
 * Batch 4b adapters — request shape + mapping against a fake proxy client.
 * Calendly, Cal.com, tl;dv, Gong, Grain.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { CAL_API_VERSION, calComAdapter } from "./cal-com";
import { calendlyAdapter, calendlyEventUuid } from "./calendly";
import { GONG_CONTENT_SELECTOR, gongAdapter } from "./gong";
import { grainAdapter } from "./grain";
import { tldvAdapter } from "./tldv";

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

describe("calendly adapter", () => {
  it("resolves the user, lists events after the cursor and attaches invitees with their answers", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/users/me") return { resource: { uri: "https://api.calendly.com/users/U1", name: "Ana" } };
      if (req.path === "/scheduled_events")
        return {
          collection: [
            {
              uri: "https://api.calendly.com/scheduled_events/EV1",
              name: "Discovery call",
              status: "active",
              start_time: "2026-09-02T10:00:00Z",
              end_time: "2026-09-02T10:30:00Z",
              updated_at: "2026-09-01T12:00:00Z",
              location: { type: "zoom", join_url: "https://zoom.us/j/1" },
              event_memberships: [{ user_name: "Ana" }],
            },
          ],
          pagination: { next_page_token: null },
        };
      if (req.path === "/scheduled_events/EV1/invitees")
        return {
          collection: [
            {
              name: "Bo",
              email: "bo@acme.com",
              status: "active",
              questions_and_answers: [{ question: "What do you want to cover?", answer: "Pricing for 50 seats" }],
            },
          ],
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await calendlyAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/users/me");
    expect(calls[1]?.path).toBe("/scheduled_events");
    expect(calls[1]?.query).toMatchObject({
      user: "https://api.calendly.com/users/U1",
      min_start_time: since.toISOString(),
      sort: "start_time:desc",
      count: 50,
    });
    expect(calls[2]?.path).toBe("/scheduled_events/EV1/invitees");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("event:EV1");
    expect(signals[0]?.title).toBe("Discovery call · 2026-09-02T10:00:00Z");
    expect(signals[0]?.text).toContain("Status: active");
    expect(signals[0]?.text).toContain("Location: https://zoom.us/j/1");
    expect(signals[0]?.text).toContain("- Bo <bo@acme.com> (active)");
    expect(signals[0]?.text).toContain("What do you want to cover?: Pricing for 50 seats");
    expect(signals[0]?.url).toBe("https://calendly.com/scheduled_events/EV1");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-01T12:00:00Z");
    expect(stats).toEqual({ events: 1, invitees: 1 });
    expect(calendlyEventUuid("https://api.calendly.com/scheduled_events/ABC")).toBe("ABC");
  });

  it("follows page tokens and records cancellations", async () => {
    let page = 0;
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/users/me") return { resource: { uri: "u" } };
      if (req.path === "/scheduled_events") {
        page++;
        return {
          collection: [
            {
              uri: `https://api.calendly.com/scheduled_events/E${page}`,
              name: "Sync",
              status: "canceled",
              start_time: "2026-09-03T10:00:00Z",
              cancellation: { canceled_by: "Bo", reason: "Conflict" },
            },
          ],
          pagination: { next_page_token: page === 1 ? "T2" : null },
        };
      }
      return { collection: [] };
    });
    const { signals } = await calendlyAdapter.fetchChanges({ client, ...base });
    expect(signals).toHaveLength(2);
    expect(calls.find((c) => c.query?.page_token === "T2")).toBeTruthy();
    expect(signals[0]?.text).toContain("Cancelled by Bo: Conflict");
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00Z");
  });

  it("fails loudly when users/me does not answer", async () => {
    const { client } = fakeClient(() => ({ status: 401, data: {} }));
    await expect(calendlyAdapter.fetchChanges({ client, ...base })).rejects.toThrow(/users\/me failed \(401\)/);
  });
});

describe("cal.com adapter", () => {
  it("lists bookings after the cursor with the API version header and maps attendees + responses", async () => {
    const { client, calls } = fakeClient(() => ({
      status: "success",
      data: [
        {
          uid: "bk1",
          title: "Onboarding with Bo",
          description: "Kickoff",
          status: "accepted",
          start: "2026-09-02T09:00:00Z",
          end: "2026-09-02T09:30:00Z",
          updatedAt: "2026-09-01T08:00:00Z",
          meetingUrl: "https://meet.example/1",
          hosts: [{ name: "Ana", email: "ana@acme.com" }],
          attendees: [{ name: "Bo", email: "bo@corp.com" }],
          bookingFieldsResponses: { name: "Bo", email: "bo@corp.com", notes: "Migrating from Zendesk", team_size: 12 },
        },
      ],
      pagination: { hasNextPage: false },
    }));
    const { signals, stats } = await calComAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/bookings");
    expect(calls[0]?.headers?.["cal-api-version"]).toBe(CAL_API_VERSION);
    expect(calls[0]?.query).toMatchObject({
      afterStart: since.toISOString(),
      status: "upcoming,past,cancelled",
      sortStart: "desc",
      take: 50,
      skip: 0,
    });
    expect(signals[0]?.external_id).toBe("booking:bk1");
    expect(signals[0]?.title).toBe("Onboarding with Bo · 2026-09-02T09:00:00Z");
    expect(signals[0]?.text).toContain("Status: accepted");
    expect(signals[0]?.text).toContain("Host: Ana");
    expect(signals[0]?.text).toContain("Location: https://meet.example/1");
    expect(signals[0]?.text).toContain("- Bo <bo@corp.com>");
    expect(signals[0]?.text).toContain("notes: Migrating from Zendesk");
    expect(signals[0]?.text).toContain("team_size: 12");
    expect(signals[0]?.text).not.toContain("email: bo@corp.com");
    expect(signals[0]?.url).toBe("https://app.cal.com/booking/bk1");
    expect(signals[0]?.at).toBe("2026-09-01T08:00:00Z");
    expect(stats).toEqual({ bookings: 1 });
  });

  it("pages with skip while hasNextPage and stops at the limit", async () => {
    const { client, calls } = fakeClient((req) => {
      const skip = Number(req.query?.skip ?? 0);
      return {
        data: [
          { uid: `b${skip}`, title: "A", status: "past", start: "2026-09-02T00:00:00Z" },
          { uid: `b${skip + 1}`, title: "B", status: "cancelled", start: "2026-09-02T00:00:00Z", cancellationReason: "No-show" },
        ],
        pagination: { hasNextPage: true },
      };
    });
    const { signals } = await calComAdapter.fetchChanges({ client, ...base, limit: 3 });
    expect(signals).toHaveLength(3);
    expect(calls.map((c) => c.query?.skip)).toEqual([0, 2]);
    expect(signals[1]?.text).toContain("Cancellation reason: No-show");
  });
});

describe("tldv adapter", () => {
  it("lists meetings from the cursor and combines highlights + transcript", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1alpha1/meetings")
        return {
          page: 1,
          pages: 1,
          results: [
            {
              id: "m1",
              name: "Weekly product sync",
              happenedAt: "2026-09-02T14:00:00Z",
              url: "https://tldv.io/app/meetings/m1",
              organizer: { name: "Ana", email: "ana@acme.com" },
              invitees: [{ name: "Bo" }, { email: "cy@acme.com" }],
            },
          ],
        };
      if (req.path === "/v1alpha1/meetings/m1/highlights")
        return { data: [{ text: "Decided to drop the free tier", topic: { title: "Pricing" } }, { text: "" }] };
      if (req.path === "/v1alpha1/meetings/m1/transcript")
        return { data: [{ speaker: "Ana", text: "Let's drop the free tier." }, { speaker: "Bo", text: "Agreed." }] };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await tldvAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/v1alpha1/meetings");
    expect(calls[0]?.query).toMatchObject({ from: since.toISOString(), page: 1, limit: 50 });
    expect(signals[0]?.external_id).toBe("meeting:m1");
    expect(signals[0]?.title).toBe("Weekly product sync");
    expect(signals[0]?.text).toContain("Participants: Bo, cy@acme.com");
    expect(signals[0]?.text).toContain("- [Pricing] Decided to drop the free tier");
    expect(signals[0]?.text).toContain("Ana: Let's drop the free tier.");
    expect(signals[0]?.url).toBe("https://tldv.io/app/meetings/m1");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-02T14:00:00Z");
    expect(stats).toEqual({ meetings: 1, transcripts: 1 });
  });

  it("keeps the meeting when the transcript is not ready and walks the pages", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1alpha1/meetings") {
        const page = Number(req.query?.page);
        return { page, pages: 2, results: [{ id: `m${page}`, name: `M${page}` }] };
      }
      if (req.path.endsWith("/transcript")) return { status: 404, data: {} };
      if (req.path.endsWith("/highlights")) return { data: [] };
      return {};
    });
    const { signals, stats } = await tldvAdapter.fetchChanges({ client, ...base });
    expect(signals.map((s) => s.external_id)).toEqual(["meeting:m1", "meeting:m2"]);
    expect(calls.filter((c) => c.path === "/v1alpha1/meetings").map((c) => c.query?.page)).toEqual([1, 2]);
    expect(stats).toEqual({ meetings: 2, transcripts: 0 });
  });
});

describe("gong adapter", () => {
  it("posts the extensive filter from the cursor, follows the record cursor and merges transcripts", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/calls/extensive") {
        const body = req.body as { cursor?: string };
        if (!body.cursor)
          return {
            calls: [
              {
                metaData: { id: "c1", title: "Acme renewal", started: "2026-09-02T15:00:00Z", duration: 1800, url: "https://app.gong.io/call?id=c1", direction: "Outbound" },
                parties: [
                  { name: "Ana", affiliation: "Internal", speakerId: "s1" },
                  { name: "Bo", emailAddress: "bo@acme.com", affiliation: "External", speakerId: "s2" },
                ],
                content: {
                  brief: "Renewal discussion.",
                  keyPoints: [{ text: "Bo wants annual billing" }],
                  outline: [{ section: "Next steps", items: [{ text: "Send proposal" }] }],
                  trackers: [{ name: "Pricing", count: 3 }, { name: "Competitor", count: 0 }],
                  topics: [{ name: "Renewal" }],
                },
              },
            ],
            records: { cursor: "CUR2" },
          };
        return { calls: [{ metaData: { id: "c2", title: "Intro", started: "2026-09-01T10:00:00Z" } }], records: {} };
      }
      if (req.path === "/v2/calls/transcript")
        return {
          callTranscripts: [
            { callId: "c1", transcript: [{ speakerId: "s1", topic: "Pricing", sentences: [{ text: "We can do annual." }] }, { speakerId: "s2", sentences: [{ text: "Great." }] }] },
          ],
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await gongAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/v2/calls/extensive");
    expect(calls[0]?.body).toEqual({ filter: { fromDateTime: since.toISOString() }, contentSelector: GONG_CONTENT_SELECTOR });
    expect((calls[1]?.body as { cursor?: string }).cursor).toBe("CUR2");
    expect(calls[2]?.path).toBe("/v2/calls/transcript");
    expect(calls[2]?.body).toEqual({ filter: { callIds: ["c1", "c2"] } });
    expect(signals).toHaveLength(2);
    expect(signals[0]?.external_id).toBe("call:c1");
    expect(signals[0]?.title).toBe("Acme renewal");
    expect(signals[0]?.text).toContain("30 min · Outbound");
    expect(signals[0]?.text).toContain("Participants: Ana (Internal), Bo (External)");
    expect(signals[0]?.text).toContain("Brief:\nRenewal discussion.");
    expect(signals[0]?.text).toContain("- Bo wants annual billing");
    expect(signals[0]?.text).toContain("Next steps\n  - Send proposal");
    expect(signals[0]?.text).toContain("Trackers: Pricing ×3");
    expect(signals[0]?.text).not.toContain("Competitor");
    expect(signals[0]?.text).toContain("Ana [Pricing]: We can do annual.");
    expect(signals[0]?.text).toContain("Bo: Great.");
    expect(signals[0]?.url).toBe("https://app.gong.io/call?id=c1");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-02T15:00:00Z");
    expect(signals[1]?.text).not.toContain("Transcript:");
    expect(stats).toEqual({ calls: 2, transcripts: 1 });
  });

  it("surfaces an extensive failure", async () => {
    const { client } = fakeClient(() => ({ status: 403, data: {} }));
    await expect(gongAdapter.fetchChanges({ client, ...base })).rejects.toThrow(/extensive failed \(403\)/);
  });
});

describe("grain adapter", () => {
  it("stops paging at the first recording older than the cursor and fetches details for the rest", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/_/public-api/recordings")
        return {
          recordings: [
            { id: "r1", title: "Design review", start_datetime: "2026-09-02T11:00:00Z" },
            { id: "r0", title: "Old", start_datetime: "2026-08-20T11:00:00Z" },
          ],
          cursor: "NEXT",
        };
      if (req.path === "/_/public-api/recordings/r1")
        return {
          id: "r1",
          title: "Design review",
          url: "https://grain.com/share/recording/r1",
          start_datetime: "2026-09-02T11:00:00Z",
          end_datetime: "2026-09-02T11:45:00Z",
          summary: "Agreed on the new onboarding flow.",
          owners: ["ana@acme.com"],
          participants: [{ name: "Ana", scope: "internal" }, { email: "bo@corp.com", scope: "external" }],
          highlights: [{ text: "Ship onboarding v2 in October", timestamp: 65000, transcript: "let's ship in October" }],
          transcript_json: { segments: [{ speaker: "Ana", text: "Let's ship in October." }, { speaker: "Bo", text: "" }] },
        };
      return { status: 404, data: {} };
    });
    const { signals, stats } = await grainAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/_/public-api/recordings");
    expect(calls.filter((c) => c.path === "/_/public-api/recordings")).toHaveLength(1);
    expect(calls[1]?.path).toBe("/_/public-api/recordings/r1");
    expect(calls[1]?.query).toMatchObject({ transcript_format: "json", include_participants: true, include_highlights: true });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("recording:r1");
    expect(signals[0]?.title).toBe("Design review");
    expect(signals[0]?.text).toContain("Participants: Ana (internal), bo@corp.com (external)");
    expect(signals[0]?.text).toContain("Summary:\nAgreed on the new onboarding flow.");
    expect(signals[0]?.text).toContain('- [01:05] Ship onboarding v2 in October — "let\'s ship in October"');
    expect(signals[0]?.text).toContain("Ana: Let's ship in October.");
    expect(signals[0]?.url).toBe("https://grain.com/share/recording/r1");
    expect(signals[0]?.author).toBe("ana@acme.com");
    expect(signals[0]?.at).toBe("2026-09-02T11:00:00Z");
    expect(stats).toEqual({ listed: 1, recordings: 1 });
  });

  it("follows the cursor while every recording is newer than since", async () => {
    let n = 0;
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/_/public-api/recordings") {
        n++;
        return { recordings: [{ id: `r${n}`, start_datetime: "2026-09-05T00:00:00Z" }], cursor: n < 2 ? "C" : null };
      }
      return { status: 500, data: {} };
    });
    const { signals } = await grainAdapter.fetchChanges({ client, ...base });
    expect(calls.filter((c) => c.path === "/_/public-api/recordings").map((c) => c.query?.cursor)).toEqual([undefined, "C"]);
    expect(signals.map((s) => s.external_id)).toEqual(["recording:r1", "recording:r2"]);
    expect(signals[0]?.title).toBe("Recording r1");
  });
});

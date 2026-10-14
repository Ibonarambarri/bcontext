/**
 * Batch 8b adapters — request shape + mapping against a fake proxy client.
 * YouTube, Canva, Chorus, Lattice, Workday.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { canvaAdapter } from "./canva";
import { chorusAdapter } from "./chorus";
import { latticeAdapter, latticeDate } from "./lattice";
import { workdayAdapter, workdayRestBase } from "./workday";
import { videoUrl, youtubeAdapter } from "./youtube";

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

describe("youtube adapter", () => {
  it("walks the uploads playlist newest-first, stops at the cursor and attaches comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/youtube/v3/channels") {
        return { items: [{ id: "ch1", snippet: { title: "Acme" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] };
      }
      if (req.path === "/youtube/v3/playlistItems") {
        return {
          items: [
            { snippet: { title: "Launch", description: "We shipped v2.", publishedAt: "2026-09-03T10:00:00Z", resourceId: { videoId: "v1" } }, contentDetails: { videoId: "v1", videoPublishedAt: "2026-09-03T10:00:00Z" } },
            { snippet: { title: "Old", publishedAt: "2026-08-01T10:00:00Z" }, contentDetails: { videoId: "v0", videoPublishedAt: "2026-08-01T10:00:00Z" } },
          ],
          nextPageToken: "p2",
        };
      }
      if (req.path === "/youtube/v3/commentThreads") {
        return { items: [{ snippet: { topLevelComment: { snippet: { textOriginal: "Great release", authorDisplayName: "Bo", likeCount: 3 } } } }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await youtubeAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.mine).toBe(true);
    expect(calls[1]?.query?.playlistId).toBe("UU1");
    expect(calls.filter((c) => c.path === "/youtube/v3/playlistItems")).toHaveLength(1); // stopped at the older item
    expect(calls[2]?.path).toBe("/youtube/v3/commentThreads");
    expect(calls[2]?.query?.videoId).toBe("v1");
    expect(signals.map((s) => s.external_id)).toEqual(["video:v1"]);
    expect(signals[0]?.url).toBe(videoUrl("v1"));
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00Z");
    expect(signals[0]?.text).toContain("We shipped v2.");
    expect(signals[0]?.text).toContain("Bo (+3): Great release");
    expect(stats?.videos).toBe(1);
  });

  it("uses config.channel_id instead of mine=true and tolerates disabled comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/youtube/v3/channels") return { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU9" } } }] };
      if (req.path === "/youtube/v3/playlistItems") return { items: [{ snippet: { title: "T" }, contentDetails: { videoId: "v9", videoPublishedAt: "2026-09-02T00:00:00Z" } }] };
      return { status: 403, data: { error: "commentsDisabled" } };
    });
    const { signals } = await youtubeAdapter.fetchChanges({ client, ...base, config: { channel_id: "UC42" } });
    expect(calls[0]?.query?.id).toBe("UC42");
    expect(calls[0]?.query?.mine).toBeUndefined();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.text).not.toContain("Comments:");
  });
});

describe("canva adapter", () => {
  it("lists designs modified-descending, stops at the cursor and reads details", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/rest/v1/designs") {
        return {
          items: [
            { id: "d1", title: "Pitch deck", updated_at: 1788400000, owner: { user_id: "u1", team_id: "t1" }, urls: { view_url: "https://www.canva.com/design/d1/view", edit_url: "https://www.canva.com/design/d1/edit" } },
            { id: "d0", title: "Old", updated_at: 1690000000 },
          ],
          continuation: "next",
        };
      }
      if (req.path === "/rest/v1/designs/d1") return { design: { id: "d1", page_count: 12, created_at: 1780000000 } };
      return { status: 500, data: {} };
    });
    const { signals } = await canvaAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ ownership: "any", sort_by: "modified_descending", limit: 50 });
    expect(calls.filter((c) => c.path === "/rest/v1/designs")).toHaveLength(1);
    expect(signals.map((s) => s.external_id)).toEqual(["design:d1"]);
    expect(signals[0]?.at).toBe(new Date(1788400000 * 1000).toISOString());
    expect(signals[0]?.url).toBe("https://www.canva.com/design/d1/view");
    expect(signals[0]?.text).toContain("Pages: 12");
    expect(signals[0]?.author).toBe("u1");
  });
});

describe("chorus adapter", () => {
  it("filters engagements client-side on date_time and processing_state and flattens the transcript", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/v1/engagements") {
        return {
          engagements: [
            { engagement_id: "e1", subject: "Acme renewal", date_time: "2026-09-02T15:00:00Z", duration: 1800, processing_state: "done", url: "https://chorus.ai/meeting/e1", owner: { name: "Ana" }, account: { name: "Acme" }, participants: [{ name: "Bo", title: "CTO", speaker_type: "external" }] },
            { engagement_id: "e2", subject: "Still processing", date_time: "2026-09-02T16:00:00Z", processing_state: "pending" },
            { engagement_id: "e0", subject: "Old", date_time: "2026-08-02T15:00:00Z", processing_state: "done" },
          ],
        };
      }
      if (req.path === "/api/v1/engagements/e1/transcript") {
        return { utterances: [{ speaker_name: "Ana", snippet: "Can we extend for two years?", start_time: 61 }, { speaker_name: "Bo", text: "Yes if the price holds.", start_time: 65 }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await chorusAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query).toMatchObject({ engagement_type: "MEETING", processing_state: "done", date_time_from: since.toISOString(), offset: 0 });
    expect(signals.map((s) => s.external_id)).toEqual(["engagement:e1"]);
    expect(signals[0]?.title).toBe("Acme renewal");
    expect(signals[0]?.text).toContain("Account: Acme");
    expect(signals[0]?.text).toContain("[01:01] Ana: Can we extend for two years?");
    expect(signals[0]?.text).toContain("Bo: Yes if the price holds.");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-02T15:00:00Z");
    expect(stats?.transcripts).toBe(1);
  });
});

describe("lattice adapter", () => {
  it("keeps goals updated after the cursor, attaches the latest update and resolves owners", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/goals") {
        return {
          data: [
            { id: "g1", name: "Ship v2", state: "Active", goalType: "Company", priority: "P1", currentAmount: 40, endingAmount: 100, dueDate: "2026-12-31", owners: [{ id: "u1" }], updatedAt: 1788400000, url: "https://acme.latticehq.com/goals/g1", description: "Launch the new platform." },
            { id: "g2", name: "Draft one", state: "Draft", updatedAt: 1788400000 },
            { id: "g0", name: "Old", state: "Active", updatedAt: "2026-07-01T00:00:00Z" },
          ],
          hasMore: false,
        };
      }
      if (req.path === "/v1/goals/updates") return { data: [{ id: 9, goalId: "g1", comment: "Beta is live", status: "green", increment: 10 }, { id: 8, goalId: "g1", comment: "older", status: "amber" }] };
      if (req.path === "/v1/users") return { data: [{ id: "u1", name: "Ana Pérez", title: "CTO", email: "ana@acme.com" }], hasMore: false };
      if (req.path === "/v1/reviewCycles") return { data: [{ id: "rc1", name: "H2 review", stage: "CollectingReviews", updatedAt: 1788500000 }, { id: "rc0", name: "Old", stage: "Ended", updatedAt: 1690000000 }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await latticeAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.limit).toBe(100);
    expect(signals.map((s) => s.external_id)).toEqual(["goal:g1", "review-cycle:rc1"]);
    expect(signals[0]?.text).toContain("Progress: 40 / 100");
    expect(signals[0]?.text).toContain("Owners: Ana Pérez (CTO)");
    expect(signals[0]?.text).not.toContain("ana@acme.com");
    expect(signals[0]?.text).toContain("Latest update [green]: Beta is live (+10)");
    expect(signals[0]?.at).toBe(new Date(1788400000 * 1000).toISOString());
    expect(signals[0]?.url).toBe("https://acme.latticehq.com/goals/g1");
    expect(signals[1]?.text).toContain("Stage: CollectingReviews");
    expect(stats?.goals_changed).toBe(1);
  });

  it("parses epoch seconds, epoch millis and ISO strings", () => {
    expect(latticeDate(1788400000)?.toISOString()).toBe("2026-09-03T01:46:40.000Z");
    expect(latticeDate(1788400000000)?.toISOString()).toBe("2026-09-03T01:46:40.000Z");
    expect(latticeDate("2026-09-03T01:46:40Z")?.toISOString()).toBe("2026-09-03T01:46:40.000Z");
    expect(latticeDate(null)).toBeNull();
  });
});

describe("workday adapter", () => {
  it("reads workers from the REST root via Base-Url-Override and emits one snapshot per organisation", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/workers") {
        return {
          total: 3,
          data: [
            { id: "w1", descriptor: "Ana Pérez", businessTitle: "CTO", isManager: true, primaryJob: { supervisoryOrganization: { id: "o1", descriptor: "Engineering" }, location: { descriptor: "Bilbao" } } },
            { id: "w2", descriptor: "Bo Li", businessTitle: "Engineer", primaryJob: { supervisoryOrganization: { id: "o1", descriptor: "Engineering" }, location: { descriptor: "Bilbao" } } },
            { id: "w3", descriptor: "Cy Ode", businessTitle: "AE", primarySupervisoryOrganization: { id: "o2", descriptor: "Sales" } },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const connectionConfig = { hostname: "wd3-impl-services1.workday.com", tenant: "acme" };
    const { signals, stats } = await workdayAdapter.fetchChanges({ client, ...base, connectionConfig });
    expect(calls[0]?.baseUrlOverride).toBe("https://wd3-impl-services1.workday.com/ccx/api/v1/acme");
    expect(calls[0]?.query).toMatchObject({ limit: 100, offset: 0 });
    expect(signals.map((s) => s.external_id)).toEqual(["org:o1", "org:o2"]);
    expect(signals[0]?.title).toBe("Engineering · 2 people");
    expect(signals[0]?.text).toContain("Managers: Ana Pérez");
    expect(signals[0]?.text).toContain("Locations: Bilbao ×2");
    expect(signals[0]?.at).toBe(since.toISOString());
    expect(stats?.workers).toBe(3);
  });

  it("returns nothing without hostname + tenant and honours the organisations allow-list", async () => {
    const { client, calls } = fakeClient(() => ({ data: [{ id: "w1", descriptor: "A", primaryJob: { supervisoryOrganization: { id: "o1", descriptor: "Eng" } } }, { id: "w2", descriptor: "B", primaryJob: { supervisoryOrganization: { id: "o2", descriptor: "Sales" } } }] }));
    expect(workdayRestBase({})).toBeNull();
    const empty = await workdayAdapter.fetchChanges({ client, ...base });
    expect(empty.signals).toEqual([]);
    expect(calls).toHaveLength(0);
    const { signals } = await workdayAdapter.fetchChanges({ client, ...base, connectionConfig: { hostname: "h", tenant: "t" }, config: { organizations: ["Sales"] } });
    expect(signals.map((s) => s.external_id)).toEqual(["org:o2"]);
  });
});

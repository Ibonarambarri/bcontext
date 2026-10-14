/**
 * Batch 11a adapters — request shape + mapping against a fake proxy client.
 * Google Chat, Google Analytics, Okta. Directory rule for Okta: group and
 * app names are the vocabulary, the actor is the only person, target users
 * are never named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { GA_ADMIN_BASE, GA_DATA_BASE, gaReportRequests, gaTotalsLine, googleAnalyticsAdapter } from "./google-analytics";
import { chatMessageFilter, chatPermalink, chatSpaceFilter, googleChatAdapter } from "./google-chat";
import { oktaAdapter, oktaAdminLogUrl, oktaHost, oktaLineKey, oktaLogFilter, oktaNextAfter } from "./okta";

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

describe("google-chat adapter", () => {
  it("builds the space and message filters", () => {
    expect(chatSpaceFilter(["SPACE"])).toBe('spaceType = "SPACE"');
    expect(chatSpaceFilter(["SPACE", "GROUP_CHAT"])).toBe('spaceType = "SPACE" OR spaceType = "GROUP_CHAT"');
    expect(chatMessageFilter(since)).toBe('createTime > "2026-09-01T00:00:00.000Z"');
    expect(chatPermalink({ name: "spaces/AAA" }, "spaces/AAA/threads/TTT")).toBe("https://chat.google.com/room/AAA/TTT");
    expect(chatPermalink({ name: "spaces/AAA", spaceUri: "https://chat.google.com/room/AAA?x" })).toBe("https://chat.google.com/room/AAA?x");
  });

  it("lists named spaces, reads messages since the cursor, and emits threads plus per-day digests without bots", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/spaces") {
        return {
          spaces: [
            { name: "spaces/AAA", displayName: "Platform", spaceType: "SPACE" },
            { name: "spaces/BBB", displayName: "Random", spaceType: "SPACE" },
          ],
        };
      }
      if (req.path === "/v1/spaces/AAA/messages") {
        if (!req.query?.pageToken) {
          return {
            messages: [
              { name: "spaces/AAA/messages/m3", sender: { name: "users/2", displayName: "Bo", type: "HUMAN" }, createTime: "2026-09-03T10:05:00Z", text: "Agreed, ship it", thread: { name: "spaces/AAA/threads/T1" }, threadReply: true },
              { name: "spaces/AAA/messages/m2", sender: { name: "users/9", type: "BOT" }, createTime: "2026-09-03T10:01:00Z", text: "Build passed", thread: { name: "spaces/AAA/threads/T9" } },
            ],
            nextPageToken: "p2",
          };
        }
        return {
          messages: [
            { name: "spaces/AAA/messages/m1", sender: { name: "users/1", displayName: "Ana", type: "HUMAN" }, createTime: "2026-09-03T10:00:00Z", text: "Should we ship Friday?", thread: { name: "spaces/AAA/threads/T1" }, emojiReactionSummaries: [{ emoji: { unicode: "👍" }, reactionCount: 2 }] },
            { name: "spaces/AAA/messages/m0", sender: { name: "users/1", type: "HUMAN" }, createTime: "2026-09-02T09:00:00Z", text: "Standup at 10", thread: { name: "spaces/AAA/threads/T0" } },
          ],
        };
      }
      if (req.path === "/v1/spaces/BBB/messages") return { status: 403, data: {} };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await googleChatAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.query?.filter).toBe('spaceType = "SPACE"');
    expect(calls[1]?.query?.filter).toBe('createTime > "2026-09-01T00:00:00.000Z"');
    expect(calls[1]?.query?.orderBy).toBe("createTime desc");
    expect(calls[2]?.query?.pageToken).toBe("p2");
    expect(signals.map((s) => s.external_id)).toEqual(["thread:AAA:T1", "space:AAA:2026-09-02"]);
    expect(signals[0]?.title).toBe("Platform · Should we ship Friday?");
    expect(signals[0]?.text).toBe("[10:00] Ana: Should we ship Friday? (👍 2)\n[10:05] Bo (reply): Agreed, ship it");
    expect(signals[0]?.url).toBe("https://chat.google.com/room/AAA/T1");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[0]?.at).toBe("2026-09-03T10:05:00Z");
    expect(signals[1]?.text).toBe("[09:00] users/1: Standup at 10");
    expect(JSON.stringify(signals)).not.toContain("Build passed");
    expect(stats).toMatchObject({ spaces: 2, messages: 3, threads: 1, forbidden: 1 });
  });

  it("narrows to the spaces listed in the install config and never reads direct messages", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/spaces") return { spaces: [{ name: "spaces/AAA", displayName: "Platform" }, { name: "spaces/BBB", displayName: "Random" }] };
      return { messages: [] };
    });
    const { stats } = await googleChatAdapter.fetchChanges({ client, ...base, config: { spaces: ["Random"], space_types: ["SPACE", "DIRECT_MESSAGE"] } });
    expect(calls[0]?.query?.filter).toBe('spaceType = "SPACE"');
    expect(calls.map((c) => c.path)).toEqual(["/v1/spaces", "/v1/spaces/BBB/messages"]);
    expect(stats).toMatchObject({ spaces: 1, messages: 0 });
  });
});

describe("google-analytics adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("asks for totals, top pages and channels over the window", () => {
    const requests = gaReportRequests("2026-09-01", "2026-09-05") as Array<{ dimensions?: unknown[]; metrics: Array<{ name: string }> }>;
    expect(requests).toHaveLength(3);
    expect(requests[0]?.metrics.map((m) => m.name)).toContain("keyEvents");
    expect(requests[1]?.dimensions).toEqual([{ name: "pagePath" }]);
    expect(gaTotalsLine({ metricHeaders: [{ name: "activeUsers" }, { name: "engagementRate" }], rows: [{ metricValues: [{ value: "1234" }, { value: "0.5678" }] }] })).toBe(
      "activeUsers 1,234 · engagementRate 56.8%",
    );
    expect(gaTotalsLine({ metricHeaders: [{ name: "activeUsers" }], rows: [] })).toBe("No traffic in the window");
  });

  it("routes Admin and Data calls with Base-Url-Override, snapshots each property and groups change history per day", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1beta/accountSummaries") {
        return {
          accountSummaries: [
            { account: "accounts/1", displayName: "Acme", propertySummaries: [{ property: "properties/123", displayName: "acme.com" }, { property: "properties/999", displayName: "staging" }] },
          ],
        };
      }
      if (req.path === "/v1beta/properties/123:batchRunReports") {
        return {
          reports: [
            { metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }, { name: "keyEvents" }], rows: [{ metricValues: [{ value: "4321" }, { value: "6000" }, { value: "45" }] }] },
            { dimensionHeaders: [{ name: "pagePath" }], metricHeaders: [{ name: "screenPageViews" }, { name: "activeUsers" }], rows: [{ dimensionValues: [{ value: "/pricing" }], metricValues: [{ value: "900" }, { value: "700" }] }] },
            { dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }], metricHeaders: [{ name: "sessions" }, { name: "keyEvents" }], rows: [{ dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "3000" }, { value: "20" }] }] },
          ],
        };
      }
      if (req.path === "/v1alpha/accounts/1:searchChangeHistoryEvents") {
        return {
          changeHistoryEvents: [
            { id: "e1", changeTime: "2026-09-03T08:00:00Z", actorType: "USER", userActorEmail: "ana@acme.com", changes: [{ resource: "properties/123/keyEvents/signup", action: "CREATED", resourceAfterChange: { keyEvent: { eventName: "signup" } } }] },
            { id: "e0", changeTime: "2026-08-20T08:00:00Z", actorType: "USER", userActorEmail: "old@acme.com", changes: [{ resource: "properties/123/dataStreams/1", action: "UPDATED" }] },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await googleAnalyticsAdapter.fetchChanges({ client, ...base, config: { property_ids: ["properties/123"] } });
    expect(calls[0]?.baseUrlOverride).toBe(GA_ADMIN_BASE);
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.baseUrlOverride).toBe(GA_DATA_BASE);
    expect((calls[1]?.body as { requests: Array<{ dateRanges: Array<{ startDate: string; endDate: string }> }> }).requests[0]?.dateRanges).toEqual([{ startDate: "2026-09-01", endDate: "2026-09-05" }]);
    expect((calls[2]?.body as { earliestChangeTime: string }).earliestChangeTime).toBe("2026-09-01T00:00:00.000Z");
    expect(calls.some((c) => c.path.includes("properties/999"))).toBe(false);
    expect(signals.map((s) => s.external_id)).toEqual(["traffic:123:2026-09-01:2026-09-05", "changes:1:2026-09-03"]);
    expect(signals[0]?.title).toBe("acme.com · traffic 2026-09-01 → 2026-09-05");
    expect(signals[0]?.text).toContain("Totals: activeUsers 4,321 · sessions 6,000 · keyEvents 45");
    expect(signals[0]?.text).toContain("- /pricing: screenPageViews 900, activeUsers 700");
    expect(signals[0]?.text).toContain("- Organic Search: sessions 3,000, keyEvents 20");
    expect(signals[0]?.url).toBe("https://analytics.google.com/analytics/web/#/p123/reports/intelligenthome");
    expect(signals[0]?.at).toBe("2026-09-05T12:00:00.000Z");
    expect(signals[1]?.author).toBe("ana@acme.com");
    expect(signals[1]?.text).toContain("CREATED properties/123/keyEvents/signup");
    expect(signals[1]?.text).not.toContain("old@acme.com");
    expect(stats).toMatchObject({ accounts: 1, properties: 1, change_events: 1 });
  });

  it("keeps the traffic snapshot when change history is not available", async () => {
    const { client } = fakeClient((req) => {
      if (req.path === "/v1beta/accountSummaries") return { accountSummaries: [{ account: "accounts/1", propertySummaries: [{ property: "properties/123" }] }] };
      if (req.path.endsWith(":batchRunReports")) return { reports: [{ metricHeaders: [{ name: "sessions" }], rows: [{ metricValues: [{ value: "10" }] }] }, {}, {}] };
      return { status: 403, data: {} };
    });
    const { signals, stats } = await googleAnalyticsAdapter.fetchChanges({ client, ...base });
    expect(signals.map((s) => s.external_id)).toEqual(["traffic:123:2026-09-01:2026-09-05"]);
    expect(signals[0]?.text).toContain("Totals: sessions 10");
    expect(stats?.change_history_unavailable).toBe(1);
  });
});

describe("okta adapter", () => {
  it("knows the filter, the Link cursor, the host and the admin console", () => {
    expect(oktaLogFilter()).toContain('eventType sw "user.lifecycle." or eventType sw "group.user_membership."');
    expect(oktaNextAfter('<https://acme.okta.com/api/v1/logs?since=x&limit=500>; rel="self", <https://acme.okta.com/api/v1/logs?after=abc&limit=500>; rel="next"')).toBe("abc");
    expect(oktaNextAfter('<https://acme.okta.com/api/v1/logs?since=x>; rel="self"')).toBeNull();
    expect(oktaHost({ hostname: "https://acme.okta.com/" })).toBe("acme.okta.com");
    expect(oktaHost({ subdomain: "acme" })).toBe("acme.okta.com");
    expect(oktaAdminLogUrl("acme.okta.com")).toBe("https://acme-admin.okta.com/report/system_log");
    expect(oktaAdminLogUrl("id.acme.com")).toBe("https://id.acme.com/report/system_log");
    expect(oktaLineKey({ eventType: "user.lifecycle.deactivate", target: [{ type: "User", displayName: "Ana" }] })).toBe("deactivate");
  });

  it("aggregates the System Log per family and day, follows the Link cursor and never names a user", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path !== "/api/v1/logs") return { status: 500, data: {} };
      if (!req.query?.after) {
        return {
          status: 200,
          data: Array.from({ length: 500 }, (_, i) =>
            i === 0
              ? { uuid: "u0", published: "2026-08-31T10:00:00.000Z", eventType: "group.user_membership.add", outcome: { result: "SUCCESS" }, actor: { displayName: "Ann Admin" }, target: [{ type: "User", displayName: "Old Person" }, { type: "UserGroup", displayName: "Engineering" }] }
              : { uuid: `u${i}`, published: "2026-09-02T10:00:00.000Z", eventType: "group.user_membership.add", outcome: { result: "SUCCESS" }, actor: { displayName: "Ann Admin", alternateId: "ann@acme.com" }, target: [{ type: "User", displayName: "Zed Person", alternateId: "zed@acme.com" }, { type: "UserGroup", displayName: "Engineering" }] },
          ),
          headers: { link: '<https://acme.okta.com/api/v1/logs?since=x>; rel="self", <https://acme.okta.com/api/v1/logs?after=cur2&limit=500>; rel="next"' },
        };
      }
      return [
        { uuid: "v1", published: "2026-09-02T11:00:00.000Z", eventType: "group.user_membership.remove", outcome: { result: "SUCCESS" }, actor: { displayName: "Ann Admin" }, target: [{ type: "User", displayName: "Zed Person" }, { type: "UserGroup", displayName: "Sales" }] },
        { uuid: "v2", published: "2026-09-02T12:00:00.000Z", eventType: "user.lifecycle.create", outcome: { result: "SUCCESS" }, actor: { displayName: "Okta System", type: "SystemPrincipal" }, target: [{ type: "User", displayName: "New Person", alternateId: "new@acme.com" }] },
        { uuid: "v3", published: "2026-09-03T09:00:00.000Z", eventType: "application.user_membership.add", outcome: { result: "SUCCESS" }, actor: { displayName: "Ann Admin" }, target: [{ type: "AppInstance", displayName: "GitHub" }, { type: "User", displayName: "New Person" }] },
        { uuid: "v4", published: "2026-09-03T09:30:00.000Z", eventType: "group.application_assignment.add", outcome: { result: "SUCCESS" }, actor: { displayName: "Ann Admin" }, target: [{ type: "AppInstance", displayName: "GitHub" }, { type: "UserGroup", displayName: "Engineering" }] },
        { uuid: "v5", published: "2026-09-03T09:45:00.000Z", eventType: "application.user_membership.add", outcome: { result: "FAILURE" }, actor: { displayName: "Ann Admin" }, target: [{ type: "AppInstance", displayName: "GitHub" }, { type: "User", displayName: "Zed Person" }] },
        { uuid: "v6", published: "2026-09-03T10:00:00.000Z", eventType: "user.session.start", outcome: { result: "SUCCESS" }, actor: { displayName: "Zed Person" } },
      ];
    });
    const { signals, stats } = await oktaAdapter.fetchChanges({ client, ...base, connectionConfig: { hostname: "acme.okta.com" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toMatchObject({ since: "2026-09-01T00:00:00.000Z", sortOrder: "ASCENDING", limit: 500 });
    expect(calls[0]?.query?.filter).toBe(oktaLogFilter());
    expect(calls[1]?.query?.after).toBe("cur2");
    expect(signals.map((s) => s.external_id)).toEqual(["apps:2026-09-03", "groups:2026-09-02", "users:2026-09-02"]);
    expect(signals[1]?.title).toBe("Directory: group membership · 2026-09-02 · 500 changes");
    expect(signals[1]?.text).toContain("- Engineering: member added ×499");
    expect(signals[1]?.text).toContain("- Sales: member removed ×1");
    expect(signals[1]?.text).toContain("Actors: Ann Admin (500)");
    expect(signals[1]?.author).toBe("Ann Admin");
    expect(signals[1]?.at).toBe("2026-09-02T11:00:00.000Z");
    expect(signals[1]?.url).toBe("https://acme-admin.okta.com/report/system_log");
    expect(signals[2]?.text).toContain("- create ×1");
    expect(signals[2]?.author).toBe("Okta System");
    expect(signals[0]?.text).toContain("- GitHub: user assigned ×1");
    expect(signals[0]?.text).toContain("- GitHub: group Engineering add ×1");
    const json = JSON.stringify(signals);
    expect(json).not.toContain("Zed Person");
    expect(json).not.toContain("New Person");
    expect(json).not.toContain("zed@acme.com");
    expect(json).not.toContain("new@acme.com");
    expect(stats).toMatchObject({ scanned: 506, skipped: 2, pages: 2, groups: 3 });
  });
});

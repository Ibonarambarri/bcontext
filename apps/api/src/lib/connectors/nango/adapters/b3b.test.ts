/**
 * Batch 3b adapters — request shape + mapping against a fake proxy client.
 * Bitbucket, Figma, PagerDuty, PostHog, Stripe.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { bitbucketAdapter, bitbucketPrQuery } from "./bitbucket";
import { figmaAdapter, figmaFileUrl } from "./figma";
import { pagerdutyAdapter, pagerdutyWindowStart } from "./pagerduty";
import { posthogAdapter, posthogProjectUrl } from "./posthog";
import { STRIPE_DEFAULT_EVENT_TYPES, stripeAdapter, stripeAmount, stripeEventText, stripeTypeAllowed } from "./stripe";

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

describe("bitbucket adapter", () => {
  it("discovers the workspace, skips stale repos and maps PRs with their last comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/2.0/workspaces") return { values: [{ slug: "acme" }] };
      if (req.path === "/2.0/repositories/acme") {
        return {
          values: [
            { slug: "api", full_name: "acme/api", updated_on: "2026-09-03T00:00:00Z" },
            { slug: "old", full_name: "acme/old", updated_on: "2026-08-01T00:00:00Z" },
          ],
        };
      }
      if (req.path === "/2.0/repositories/acme/api/pullrequests") {
        return {
          values: [
            {
              id: 7,
              title: "Retry webhooks",
              description: "Adds exponential backoff.",
              state: "MERGED",
              updated_on: "2026-09-03T10:00:00Z",
              author: { display_name: "Ana" },
              source: { branch: { name: "feat/retry" } },
              destination: { branch: { name: "main" } },
              links: { html: { href: "https://bitbucket.org/acme/api/pull-requests/7" } },
              comment_count: 1,
            },
          ],
        };
      }
      if (req.path === "/2.0/repositories/acme/api/pullrequests/7/comments") {
        return { values: [{ content: { raw: "Ship it after the retry test." }, user: { display_name: "Bo" }, created_on: "2026-09-03T09:00:00Z" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await bitbucketAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.query?.role).toBe("member");
    expect(calls[2]?.query?.q).toBe(bitbucketPrQuery(since));
    expect(String(calls[2]?.query?.q)).toContain('updated_on > "2026-09-01T00:00:00.000Z"');
    expect(calls.map((c) => c.path)).not.toContain("/2.0/repositories/acme/old/pullrequests");
    expect(signals.map((s) => s.external_id)).toEqual(["pr:acme/api:7"]);
    expect(signals[0]?.title).toBe("acme/api !7 · Retry webhooks");
    expect(signals[0]?.text).toContain("State: MERGED · feat/retry → main");
    expect(signals[0]?.text).toContain("Bo (2026-09-03T09:00:00Z): Ship it after the retry test.");
    expect(signals[0]?.url).toBe("https://bitbucket.org/acme/api/pull-requests/7");
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00Z");
    expect(signals[0]?.author).toBe("Ana");
    expect(stats?.repos).toBe(1);
  });

  it("uses config.workspace and config.repos without discovery calls", async () => {
    const { client, calls } = fakeClient((req) => (req.path.endsWith("/pullrequests") ? { values: [] } : { status: 500, data: {} }));
    await bitbucketAdapter.fetchChanges({ client, ...base, config: { workspace: "acme", repos: ["api"] } });
    expect(calls.map((c) => c.path)).toEqual(["/2.0/repositories/acme/api/pullrequests"]);
  });
});

describe("figma adapter", () => {
  it("walks team projects, keeps files modified or commented since, and pins file_keys", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/teams/t1/projects") return { projects: [{ id: 10, name: "Web" }] };
      if (req.path === "/v1/projects/10/files") {
        return {
          files: [
            { key: "F1", name: "Checkout", last_modified: "2026-09-02T00:00:00Z" },
            { key: "F2", name: "Old", last_modified: "2026-08-01T00:00:00Z" },
          ],
        };
      }
      if (req.path === "/v1/files/F1/comments") {
        return { comments: [{ id: "c1", message: "Use the compact layout.", created_at: "2026-09-02T01:00:00Z", user: { handle: "ana" } }, { id: "c0", message: "old", created_at: "2026-08-02T00:00:00Z" }] };
      }
      if (req.path === "/v1/files/P1/comments") return { comments: [{ id: "c9", message: "Approved.", created_at: "2026-09-04T00:00:00Z", user: { handle: "bo" } }] };
      return { status: 500, data: {} };
    });
    const { signals } = await figmaAdapter.fetchChanges({ client, ...base, config: { team_id: "t1", file_keys: ["P1"] } });
    expect(calls.map((c) => c.path)).toContain("/v1/teams/t1/projects");
    expect(calls.map((c) => c.path)).not.toContain("/v1/files/F2/comments");
    expect(signals.map((s) => s.external_id)).toEqual(["file:P1", "file:F1"]);
    const f1 = signals.find((s) => s.external_id === "file:F1");
    expect(f1?.title).toBe("Checkout (Web)");
    expect(f1?.text).toContain("Use the compact layout.");
    expect(f1?.text).not.toContain("old");
    expect(f1?.url).toBe(figmaFileUrl("F1"));
    expect(f1?.at).toBe("2026-09-02T01:00:00Z");
    expect(signals[0]?.text).toContain("File unchanged; new comments only.");
    expect(signals[0]?.author).toBe("bo");
  });

  it("returns nothing without a team or pinned files", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const { signals, stats } = await figmaAdapter.fetchChanges({ client, ...base });
    expect(signals).toEqual([]);
    expect(stats?.skipped_no_team).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("pagerduty adapter", () => {
  it("opens the window 30 days back, keeps incidents whose status changed since, and attaches notes + timeline", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/incidents") {
        return {
          incidents: [
            { id: "P1", incident_number: 41, title: "DB latency", status: "resolved", urgency: "high", created_at: "2026-08-20T00:00:00Z", last_status_change_at: "2026-09-02T12:00:00Z", html_url: "https://acme.pagerduty.com/incidents/P1", service: { summary: "API" }, assignments: [{ assignee: { summary: "Ana" } }] },
            { id: "P2", incident_number: 40, title: "Stale", status: "resolved", created_at: "2026-08-20T00:00:00Z", last_status_change_at: "2026-08-21T00:00:00Z" },
          ],
          more: false,
        };
      }
      if (req.path === "/incidents/P1/notes") return { notes: [{ content: "Root cause: missing index.", created_at: "2026-09-02T11:00:00Z", user: { summary: "Bo" } }] };
      if (req.path === "/incidents/P1/log_entries") return { log_entries: [{ type: "resolve_log_entry", summary: "Resolved by Ana", created_at: "2026-09-02T12:00:00Z", agent: { summary: "Ana" } }] };
      return { status: 500, data: {} };
    });
    const { signals } = await pagerdutyAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.headers?.Accept).toBe("application/vnd.pagerduty+json;version=2");
    expect(calls[0]?.query?.since).toBe(pagerdutyWindowStart(since));
    expect(calls[0]?.query?.since).toBe("2026-08-02T00:00:00.000Z");
    expect(calls[0]?.query?.sort_by).toBe("created_at:desc");
    expect(signals.map((s) => s.external_id)).toEqual(["incident:P1"]);
    expect(signals[0]?.title).toBe("#41 · DB latency");
    expect(signals[0]?.text).toContain("Status: resolved · Urgency: high · Service: API");
    expect(signals[0]?.text).toContain("Root cause: missing index.");
    expect(signals[0]?.text).toContain("Resolved by Ana");
    expect(signals[0]?.url).toBe("https://acme.pagerduty.com/incidents/P1");
    expect(signals[0]?.at).toBe("2026-09-02T12:00:00Z");
  });
});

describe("posthog adapter", () => {
  it("lists projects and maps annotations, insights and feature flags changed since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/projects/") return { results: [{ id: 3, name: "App" }] };
      if (req.path === "/api/projects/3/annotations/") {
        return { results: [{ id: 1, content: "Launched pricing v2", date_marker: "2026-09-02T00:00:00Z", created_at: "2026-09-02T01:00:00Z", scope: "project", created_by: { first_name: "Ana" } }, { id: 2, content: "old", date_marker: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" }] };
      }
      if (req.path === "/api/projects/3/insights/") return { results: [{ id: 9, short_id: "abc", name: "Signup funnel", description: "Drop at step 2", last_modified_at: "2026-09-03T00:00:00Z", last_modified_by: { email: "bo@acme.com" }, tags: ["growth"] }] };
      if (req.path === "/api/projects/3/feature_flags/") return { results: [{ id: 5, key: "new-checkout", name: "New checkout", active: true, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-09-04T00:00:00Z", rollout_percentage: 50 }, { id: 6, key: "old", created_at: "2026-01-01T00:00:00Z" }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await posthogAdapter.fetchChanges({ client, ...base, connectionConfig: { subdomain: "eu" } });
    expect(calls[2]?.query?.order).toBe("-last_modified_at");
    expect(signals.map((s) => s.external_id)).toEqual(["annotation:3:1", "insight:3:9", "feature_flag:3:5"]);
    expect(signals[0]?.text).toContain("Launched pricing v2");
    expect(signals[0]?.author).toBe("Ana");
    expect(signals[1]?.url).toBe(`${posthogProjectUrl({ subdomain: "eu" }, "3")}/insights/abc`);
    expect(signals[1]?.url).toBe("https://eu.posthog.com/project/3/insights/abc");
    expect(signals[2]?.text).toContain("Active: yes · Rollout: 50%");
    expect(signals[2]?.at).toBe("2026-09-04T00:00:00Z");
    expect(stats).toMatchObject({ projects: 1, annotations: 1, insights: 1, feature_flags: 1 });
  });
});

describe("stripe adapter", () => {
  it("filters events by the default type rules, summarises objects and paginates with starting_after", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.query?.starting_after === "evt_2") return { data: [{ id: "evt_3", type: "product.updated", created: 1788400000, data: { object: { id: "prod_1", object: "product", name: "Pro" }, previous_attributes: { name: "Team" } } }], has_more: false };
      return {
        data: [
          { id: "evt_1", type: "customer.subscription.updated", created: 1788500000, data: { object: { id: "sub_1", object: "subscription", status: "active", customer: "cus_1", currency: "eur", cancel_at_period_end: true, items: { data: [{ price: { nickname: "Team", unit_amount: 4900, currency: "eur", recurring: { interval: "month" } } }] } }, previous_attributes: { cancel_at_period_end: false } } },
          { id: "evt_2", type: "payment_intent.created", created: 1788400000, data: { object: { id: "pi_1", object: "payment_intent" } } },
        ],
        has_more: true,
      };
    });
    const { signals, stats } = await stripeAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/v1/events");
    expect(calls[0]?.query?.["created[gte]"]).toBe(Math.floor(since.getTime() / 1000));
    expect(calls[1]?.query?.starting_after).toBe("evt_2");
    expect(signals.map((s) => s.external_id)).toEqual(["event:evt_1", "event:evt_3"]);
    expect(signals[0]?.text).toContain("Plan: Team · ≈49 EUR/month");
    expect(signals[0]?.text).toContain("Cancels at period end.");
    expect(signals[0]?.text).toContain("Changed fields: cancel_at_period_end");
    expect(signals[0]?.url).toBe("https://dashboard.stripe.com/events/evt_1");
    expect(signals[0]?.at).toBe(new Date(1788500000 * 1000).toISOString());
    expect(signals[0]?.kind_hint).toBe("customer");
    expect(stats).toMatchObject({ pages: 2, scanned: 3 });
  });

  it("honours config.event_types and rounds amounts", () => {
    expect(stripeTypeAllowed("charge.dispute.created", STRIPE_DEFAULT_EVENT_TYPES)).toBe(true);
    expect(stripeTypeAllowed("charge.succeeded", STRIPE_DEFAULT_EVENT_TYPES)).toBe(false);
    expect(stripeTypeAllowed("invoice.paid", ["invoice.paid"])).toBe(true);
    expect(stripeAmount(12990, "eur")).toBe("≈130 EUR");
    expect(stripeAmount(null)).toBeNull();
    expect(stripeEventText({ id: "e", type: "invoice.payment_failed", data: { object: { id: "in_1", object: "invoice", status: "open", amount_due: 5000, currency: "usd", customer_email: "x@acme.com" } } })).toContain("Amount: ≈50 USD");
  });
});

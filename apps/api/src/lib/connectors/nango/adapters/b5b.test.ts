/**
 * Batch 5b adapters — request shape + mapping against a fake proxy client.
 * Datadog, Grafana, Vercel, Cloudflare, GitHub (token).
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { cloudflareAdapter, isNoisyAction } from "./cloudflare";
import { datadogAdapter, datadogAppUrl } from "./datadog";
import { githubPatAdapter, repoFullName } from "./github-pat";
import { grafanaAdapter } from "./grafana";
import { vercelAdapter } from "./vercel";

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

describe("datadog adapter", () => {
  it("keeps incidents and monitors modified after since, reads the timeline and caps events", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/incidents") {
        return {
          data: [
            {
              id: "i1",
              attributes: { public_id: 42, title: "API latency", created: "2026-09-02T09:00:00Z", modified: "2026-09-02T12:00:00Z", customer_impacted: true, fields: { severity: { value: "SEV-2" }, state: { value: "resolved" }, root_cause: { value: "Connection pool exhausted" } } },
              relationships: { commander_user: { data: { id: "u1" } } },
            },
            { id: "i0", attributes: { public_id: 41, title: "Old", modified: "2026-08-01T00:00:00Z" } },
          ],
          included: [{ id: "u1", type: "users", attributes: { name: "Ana", email: "ana@acme.com" } }],
          meta: { pagination: { next_offset: 100 } },
        };
      }
      if (req.path === "/v2/incidents/i1/timeline") {
        return { data: [{ id: "t1", attributes: { cell_type: "markdown", created: "2026-09-02T10:00:00Z", content: { content: "Rolled back the deploy", important: true }, author: { name: "Bo" } } }] };
      }
      if (req.path === "/v1/monitor") {
        return [
          { id: 7, name: "p95 latency", type: "metric alert", query: "avg(last_5m):…", overall_state: "OK", modified: "2026-09-03T00:00:00Z", creator: { name: "Ana" } },
          { id: 8, name: "old", modified: "2026-08-01T00:00:00Z" },
        ];
      }
      if (req.path === "/v1/events") {
        return { events: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `Event ${i + 1}`, text: "x", date_happened: 1788400000 + i, url: "/event/event?id=1" })) };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await datadogAdapter.fetchChanges({ client, ...base, connectionConfig: { siteParameter: "datadoghq.eu" }, config: { monitor_tags: ["team:core"] } });
    expect(calls[0]?.query?.include).toBe("users");
    expect(calls[0]?.query?.["page[size]"]).toBe(100);
    expect(calls.find((c) => c.path === "/v1/monitor")?.query?.monitor_tags).toBe("team:core");
    expect(calls.find((c) => c.path === "/v1/events")?.query?.start).toBe(Math.floor(since.getTime() / 1000));
    // The older incident stops pagination: only one incidents page requested.
    expect(calls.filter((c) => c.path === "/v2/incidents")).toHaveLength(1);
    const incident = signals.find((s) => s.external_id === "incident:i1");
    expect(incident?.title).toBe("#42 · API latency");
    expect(incident?.text).toContain("Severity: SEV-2");
    expect(incident?.text).toContain("Commander: Ana");
    expect(incident?.text).toContain("Root cause: Connection pool exhausted");
    expect(incident?.text).toContain("Rolled back the deploy");
    expect(incident?.url).toBe("https://app.datadoghq.eu/incidents/42");
    expect(incident?.at).toBe("2026-09-02T12:00:00Z");
    expect(signals.some((s) => s.external_id === "incident:i0")).toBe(false);
    const monitor = signals.find((s) => s.external_id === "monitor:7");
    expect(monitor?.url).toBe("https://app.datadoghq.eu/monitors/7");
    expect(monitor?.author).toBe("Ana");
    expect(signals.filter((s) => s.kind_hint === "event")).toHaveLength(20);
    expect(stats).toMatchObject({ incidents: 1, monitors: 1, events: 20 });
    expect(datadogAppUrl({ siteParameter: "us3.datadoghq.com" })).toBe("https://us3.datadoghq.com");
    expect(datadogAppUrl({})).toBe("https://app.datadoghq.com");
  });
});

describe("grafana adapter", () => {
  it("maps annotations, reads dashboards by uid and keeps alerts firing since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/annotations") {
        return [
          { id: 1, dashboardUID: "abc", panelId: 3, time: Date.parse("2026-09-02T08:00:00Z"), text: "Deployed v2.3", tags: ["deploy"], login: "ana" },
          { id: 2, time: Date.parse("2026-09-02T09:00:00Z"), text: "CPU high", alertId: 9, alertName: "CPU", prevState: "ok", newState: "alerting" },
        ];
      }
      if (req.path === "/api/search") return [{ uid: "abc", title: "API" }, { uid: "old", title: "Old" }];
      if (req.path === "/api/dashboards/uid/abc") return { meta: { updated: "2026-09-03T00:00:00Z", updatedBy: "bo", version: 12, url: "/d/abc/api" }, dashboard: { title: "API", description: "Golden signals", panels: [{ title: "Latency" }, { title: "Errors", description: "5xx" }] } };
      if (req.path === "/api/dashboards/uid/old") return { meta: { updated: "2026-08-01T00:00:00Z" }, dashboard: { title: "Old" } };
      if (req.path === "/api/alertmanager/grafana/api/v2/alerts") {
        return [
          { fingerprint: "f1", labels: { alertname: "HighErrorRate", service: "api" }, annotations: { summary: "5xx above 2%" }, startsAt: "2026-09-02T10:00:00Z", status: { state: "active" }, generatorURL: "https://acme.grafana.net/alerting/1" },
          { fingerprint: "f0", labels: { alertname: "Old" }, startsAt: "2026-08-01T00:00:00Z" },
        ];
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await grafanaAdapter.fetchChanges({ client, ...base, connectionConfig: { domain: "acme.grafana.net" } });
    expect(calls[0]?.query?.from).toBe(since.getTime());
    expect(calls[0]?.query?.limit).toBe(100);
    expect(calls[1]?.path).toBe("/api/search");
    expect(calls[1]?.query?.type).toBe("dash-db");
    expect(signals.map((s) => s.external_id)).toEqual(["annotation:1", "annotation:2", "dashboard:abc", "alert:f1"]);
    expect(signals[0]?.url).toBe("https://acme.grafana.net/d/abc?viewPanel=3");
    expect(signals[0]?.author).toBe("ana");
    expect(signals[1]?.kind_hint).toBe("alert");
    expect(signals[1]?.text).toContain("ok → alerting");
    expect(signals[2]?.url).toBe("https://acme.grafana.net/d/abc/api");
    expect(signals[2]?.text).toContain("Errors (5xx)");
    expect(signals[2]?.at).toBe("2026-09-03T00:00:00Z");
    expect(signals[3]?.text).toContain("service=api");
    expect(stats).toMatchObject({ annotations: 2, dashboards: 1, dashboards_read: 2, alerts: 1 });
  });

  it("honours a pinned dashboard allow-list and tolerates a missing alertmanager", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/annotations") return [];
      if (req.path === "/api/dashboards/uid/pin1") return { meta: { updated: "2026-09-03T00:00:00Z" }, dashboard: { title: "Pinned" } };
      if (req.path.startsWith("/api/alertmanager")) return { status: 404, data: {} };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await grafanaAdapter.fetchChanges({ client, ...base, connectionConfig: { domain: "https://acme.grafana.net/" }, config: { dashboard_uids: ["pin1"] } });
    expect(calls.some((c) => c.path === "/api/search")).toBe(false);
    expect(signals.map((s) => s.external_id)).toEqual(["dashboard:pin1"]);
    expect(signals[0]?.url).toBe("https://acme.grafana.net/d/pin1");
    expect(stats?.alerts_unavailable).toBe(1);
  });
});

describe("vercel adapter", () => {
  it("groups failed and production deployments per project and follows pagination", async () => {
    let page = 0;
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v9/projects") return { projects: [{ id: "p1", name: "web", framework: "nextjs", link: { org: "acme", repo: "web" } }] };
      if (req.path === "/v6/deployments") {
        page += 1;
        if (page === 1) {
          return {
            deployments: [
              { uid: "d3", name: "web", url: "web-3.vercel.app", readyState: "READY", target: "production", createdAt: Date.parse("2026-09-03T10:00:00Z"), inspectorUrl: "https://vercel.com/acme/web/d3", meta: { githubCommitMessage: "feat: pricing page\n\nmore", githubCommitAuthorName: "Ana", githubCommitRef: "main" } },
              { uid: "d2", name: "web", readyState: "ERROR", target: null, createdAt: Date.parse("2026-09-02T10:00:00Z"), creator: { username: "bo" }, meta: { githubCommitMessage: "wip", githubCommitRef: "feat/x" } },
              { uid: "d1", name: "web", readyState: "READY", target: null, createdAt: Date.parse("2026-09-02T09:00:00Z") },
              { uid: "d0", name: "api", readyState: "READY", target: "production", createdAt: Date.parse("2026-08-01T00:00:00Z") },
            ],
            pagination: { next: 123 },
          };
        }
        return { deployments: [{ uid: "e1", name: "docs", readyState: "READY", target: "production", createdAt: Date.parse("2026-09-02T00:00:00Z") }], pagination: { next: null } };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await vercelAdapter.fetchChanges({ client, ...base, config: { team_id: "team_1", projects: ["web", "api"] } });
    const deploys = calls.filter((c) => c.path === "/v6/deployments");
    expect(deploys[0]?.query).toMatchObject({ since: since.getTime(), state: "READY,ERROR", teamId: "team_1" });
    expect(deploys[1]?.query?.until).toBe(123);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("deployments:web:d3");
    expect(signals[0]?.title).toBe("web · 2 deployments, 1 failed");
    expect(signals[0]?.text).toContain("nextjs · acme/web");
    expect(signals[0]?.text).toContain("production · main · Ana: feat: pricing page (https://web-3.vercel.app)");
    expect(signals[0]?.text).toContain("FAILED · feat/x · bo: wip");
    expect(signals[0]?.text).not.toContain("d1");
    expect(signals[0]?.url).toBe("https://vercel.com/acme/web/d3");
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00.000Z");
    expect(stats).toMatchObject({ deployments: 5, projects: 1, pages: 2 });
  });
});

describe("cloudflare adapter", () => {
  it("discovers the account, groups audit entries per actor and action, and skips noisy actions", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v4/accounts") return { result: [{ id: "acc1", name: "Acme" }] };
      if (req.path === "/v4/zones") return { result: [{ id: "z1", name: "acme.com" }] };
      if (req.path === "/v4/accounts/acc1/audit_logs") {
        return {
          result: [
            { id: "a3", action: { type: "rec_set", result: true }, actor: { email: "ana@acme.com" }, resource: { type: "DNS_record", id: "z1" }, interface: "UI", oldValue: "1.1.1.1", newValue: "2.2.2.2", when: "2026-09-02T10:00:00Z" },
            { id: "a2", action: { type: "rec_set", result: true }, actor: { email: "ana@acme.com" }, resource: { type: "DNS_record", id: "z1" }, when: "2026-09-02T09:00:00Z" },
            { id: "a1", action: { type: "login", result: true }, actor: { email: "ana@acme.com" }, when: "2026-09-02T08:00:00Z" },
            { id: "a0", action: { type: "rec_set" }, actor: { email: "bo@acme.com" }, when: "2026-08-01T00:00:00Z" },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await cloudflareAdapter.fetchChanges({ client, ...base });
    const audit = calls.find((c) => c.path === "/v4/accounts/acc1/audit_logs");
    expect(audit?.query).toMatchObject({ since: since.toISOString(), per_page: 100, direction: "desc" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("audit:ana@acme.com:rec_set:a3");
    expect(signals[0]?.title).toBe("ana@acme.com · rec_set × 2");
    expect(signals[0]?.text).toContain("DNS_record acme.com");
    expect(signals[0]?.text).toContain("1.1.1.1 → 2.2.2.2");
    expect(signals[0]?.url).toBe("https://dash.cloudflare.com/acc1/audit-log");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00Z");
    expect(stats).toMatchObject({ scanned: 4, skipped: 1, groups: 1 });
    expect(isNoisyAction("login")).toBe(true);
    expect(isNoisyAction("zone_settings_change")).toBe(false);
  });

  it("uses config.account_id without discovery", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v4/zones") return { status: 403, data: {} };
      if (req.path === "/v4/accounts/acc9/audit_logs") return { result: [] };
      return { status: 500, data: {} };
    });
    const { signals } = await cloudflareAdapter.fetchChanges({ client, ...base, config: { account_id: "acc9" } });
    expect(calls.some((c) => c.path === "/v4/accounts")).toBe(false);
    expect(signals).toEqual([]);
  });
});

describe("github (token) adapter", () => {
  it("lists issues and pull requests per configured repo with their recent comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/repos/acme/app/issues") {
        return [
          { id: 11, number: 5, title: "Add SSO", body: "We need SAML.", state: "open", html_url: "https://github.com/acme/app/issues/5", updated_at: "2026-09-02T10:00:00Z", labels: [{ name: "feature" }], assignees: [{ login: "bo" }], user: { login: "ana" }, repository_url: "https://api.github.com/repos/acme/app", comments: 1 },
          { id: 12, number: 6, title: "Fix login", state: "closed", html_url: "https://github.com/acme/app/pull/6", updated_at: "2026-09-02T11:00:00Z", pull_request: { merged_at: "2026-09-02T11:00:00Z" }, user: { login: "bo" }, repository_url: "https://api.github.com/repos/acme/app", comments: 0 },
          { id: 10, number: 1, title: "Old", state: "open", updated_at: "2026-08-01T00:00:00Z", repository_url: "https://api.github.com/repos/acme/app" },
        ];
      }
      if (req.path === "/repos/acme/app/issues/5/comments") return [{ id: 1, body: "Let's use WorkOS", created_at: "2026-09-02T09:30:00Z", user: { login: "bo" } }];
      return { status: 500, data: {} };
    });
    const { signals } = await githubPatAdapter.fetchChanges({ client, ...base, config: { repos: ["acme/app"] } });
    expect(calls[0]?.query).toMatchObject({ state: "all", since: since.toISOString(), sort: "updated", per_page: 100 });
    expect(calls.find((c) => c.path === "/repos/acme/app/issues/5/comments")?.query?.since).toBe(since.toISOString());
    expect(calls.some((c) => c.path === "/repos/acme/app/issues/6/comments")).toBe(false);
    expect(signals.map((s) => s.external_id)).toEqual(["issue:11", "pr:12"]);
    expect(signals[0]?.title).toBe("acme/app#5 · Add SSO");
    expect(signals[0]?.text).toContain("Labels: feature");
    expect(signals[0]?.text).toContain("Assignees: bo");
    expect(signals[0]?.text).toContain("bo (2026-09-02T09:30:00Z): Let's use WorkOS");
    expect(signals[0]?.author).toBe("ana");
    expect(signals[1]?.text).toContain("Pull request · State: merged");
    expect(signals[1]?.kind_hint).toBe("pull_request");
    expect(repoFullName({ id: 1, number: 1, repository: { full_name: "x/y" } })).toBe("x/y");
  });

  it("falls back to search when the personal feed is empty", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/issues") return [];
      if (req.path === "/search/issues") return { items: [{ id: 20, number: 9, title: "Review me", state: "open", html_url: "https://github.com/acme/app/pull/9", updated_at: "2026-09-02T00:00:00Z", pull_request: {}, repository_url: "https://api.github.com/repos/acme/app", comments: 0 }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await githubPatAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.path).toBe("/issues");
    expect(calls[0]?.query?.filter).toBe("all");
    expect(String(calls[1]?.query?.q)).toBe("updated:>=2026-09-01 involves:@me");
    expect(signals.map((s) => s.external_id)).toEqual(["pr:20"]);
    expect(stats?.search_fallback).toBe(1);
  });
});

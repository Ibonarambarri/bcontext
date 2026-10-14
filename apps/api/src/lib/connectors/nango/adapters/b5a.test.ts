/**
 * Batch 5a adapters — request shape + mapping against a fake proxy client.
 * Mixpanel, Amplitude, Snowflake, BigQuery, Supabase.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { amplitudeAdapter, amplitudeChartText, amplitudeDate } from "./amplitude";
import { bigqueryAdapter, bigqueryRows } from "./bigquery";
import { mixpanelAdapter, mixpanelDate, mixpanelSeriesText } from "./mixpanel";
import { snowflakeAdapter, snowflakeStatementBody } from "./snowflake";
import { supabaseAdapter, supabaseTables } from "./supabase";
import { interpolateSince, namedQueries, renderRecord, renderTable, slug } from "./tabular";

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

describe("tabular helpers", () => {
  it("reads queries as a list or a map, interpolates since and slugs names", () => {
    expect(namedQueries({ queries: [{ name: "KPIs", sql: "select 1" }, { sql: "select 2" }, { name: "x" }] })).toEqual([
      { name: "KPIs", sql: "select 1" },
      { name: "select 2", sql: "select 2" },
    ]);
    expect(namedQueries({ queries: { "Weekly KPIs": "select 3" } })).toEqual([{ name: "Weekly KPIs", sql: "select 3" }]);
    expect(namedQueries({})).toEqual([]);
    expect(interpolateSince("where t > '{{ since }}'", since)).toBe("where t > '2026-09-01T00:00:00.000Z'");
    expect(slug("Weekly KPIs (EU)")).toBe("weekly-kpis-eu");
  });

  it("renders tables and records compactly", () => {
    const table = renderTable(["a", "b"], [[1, "x y"], [null, { k: 1 }], [3, 4]], { maxRows: 2 });
    expect(table).toBe('a | b\n--- | ---\n1 | x y\n | {"k":1}\n… 1 more rows');
    expect(renderRecord({ id: 1, title: "T", empty: null, blank: "" })).toBe("id: 1\ntitle: T");
    expect(renderTable([], [["abc"]], { maxChars: 1 })).toContain("(truncated)");
  });
});

describe("mixpanel adapter", () => {
  it("needs a project id, filters annotations by date and snapshots changed reports", async () => {
    const none = await mixpanelAdapter.fetchChanges({ ...base, client: fakeClient(() => ({})).client });
    expect(none).toEqual({ signals: [], stats: { missing_project_id: 1 } });

    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/app/projects/42/annotations") {
        return {
          results: [
            { id: 1, date: "2026-09-02 10:00:00", description: "Launched pricing v2", user: { first_name: "Ana", last_name: "R" } },
            { id: 2, date: "2026-08-20 10:00:00", description: "old" },
          ],
        };
      }
      if (req.path === "/api/app/projects/42/bookmarks") {
        return {
          results: [
            { id: 7, name: "Weekly signups", type: "insights", modified: "2026-09-03 08:00:00", creator_name: "Bo" },
            { id: 8, name: "Stale", modified: "2026-08-01 08:00:00" },
          ],
        };
      }
      if (req.path === "/api/query/insights") {
        return { computed_at: "2026-09-03T09:00:00Z", series: { Signups: { "2026-09-01": 12, "2026-09-02": 15 } } };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await mixpanelAdapter.fetchChanges({ ...base, client, config: { project_id: "42" } });
    expect(calls[2]?.query).toEqual({ project_id: "42", bookmark_id: "7" });
    expect(signals.map((s) => s.external_id)).toEqual(["annotation:42:1", "report:42:7"]);
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00.000Z");
    expect(signals[0]?.author).toBe("Ana R");
    expect(signals[1]?.text).toContain("Signups: 2026-09-01=12, 2026-09-02=15");
    expect(signals[1]?.author).toBe("Bo");
    expect(stats).toEqual({ annotations: 1, reports: 1 });
    expect(mixpanelDate("nope")).toBeNull();
    expect(mixpanelSeriesText(undefined)).toBe("");
  });
});

describe("amplitude adapter", () => {
  it("maps annotations dated since and chart snapshots for pinned charts", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/2/annotations") {
        return { data: [{ id: 5, date: "2026-09-04", label: "Release 3.1", details: "Onboarding redesign" }, { id: 6, date: "2026-08-01", label: "old" }] };
      }
      if (req.path === "/api/3/chart/abc/query") {
        return { data: { series: [[{ value: 1 }, { value: 2 }]], seriesLabels: ["Active users"], xValues: ["2026-09-01", "2026-09-02"] } };
      }
      if (req.path === "/api/3/chart/bad/query") return { status: 404, data: {} };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await amplitudeAdapter.fetchChanges({ ...base, client, config: { chart_ids: ["abc", "bad"] } });
    expect(calls.map((c) => c.path)).toEqual(["/api/2/annotations", "/api/3/chart/abc/query", "/api/3/chart/bad/query"]);
    expect(signals.map((s) => s.external_id)).toEqual(["annotation:5", "chart:abc"]);
    expect(signals[0]?.at).toBe("2026-09-04T00:00:00.000Z");
    expect(signals[0]?.text).toContain("Onboarding redesign");
    expect(signals[1]?.text).toContain("Active users: 2026-09-01=1, 2026-09-02=2");
    expect(stats).toEqual({ annotations: 1, charts: 1, chart_errors: 1 });
    expect(amplitudeDate("2026-09-04")?.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(amplitudeChartText({ data: { seriesCollapsed: [[10]] } })).toBe("totals: 10");
  });
});

describe("snowflake adapter", () => {
  it("runs each named query through the SQL API and renders the rows", async () => {
    const empty = await snowflakeAdapter.fetchChanges({ ...base, client: fakeClient(() => ({})).client });
    expect(empty).toEqual({ signals: [], stats: { missing_queries: 1 } });

    const { client, calls } = fakeClient((req) => {
      const body = req.body as { statement: string };
      if (body.statement.includes("pending")) return { status: 202, data: { statementHandle: "h" } };
      if (body.statement.includes("boom")) return { status: 422, data: { message: "bad" } };
      return { resultSetMetaData: { numRows: 2, rowType: [{ name: "PLAN" }, { name: "MRR" }] }, data: [["pro", 1200], ["team", 300]] };
    });
    const config = {
      queries: [{ name: "MRR by plan", sql: "select plan, mrr from kpis where day > '{{since}}'" }, { name: "P", sql: "pending" }, { name: "B", sql: "boom" }],
      warehouse: "WH",
      database: "DB",
    };
    const { signals, stats } = await snowflakeAdapter.fetchChanges({ ...base, client, config, connectionConfig: { snowflake_account_url: "acme.snowflakecomputing.com" } });
    expect(calls[0]?.path).toBe("/api/v2/statements");
    expect(calls[0]?.headers?.["X-Snowflake-Authorization-Token-Type"]).toBe("OAUTH");
    expect((calls[0]?.body as { statement: string }).statement).toContain("day > '2026-09-01T00:00:00.000Z'");
    expect(snowflakeStatementBody("select 1", config)).toMatchObject({ statement: "select 1", warehouse: "WH", database: "DB", timeout: 60 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("query:mrr-by-plan");
    expect(signals[0]?.text).toContain("PLAN | MRR\n--- | ---\npro | 1200\nteam | 300");
    expect(signals[0]?.url).toBe("https://acme.snowflakecomputing.com");
    expect(stats).toEqual({ queries: 3, executed: 1, pending: 1, failed: 1 });
  });
});

describe("bigquery adapter", () => {
  it("needs project + queries, posts standard SQL and flattens the row cells", async () => {
    const noProject = await bigqueryAdapter.fetchChanges({ ...base, client: fakeClient(() => ({})).client, config: { queries: { a: "select 1" } } });
    expect(noProject.stats).toEqual({ missing_project_id: 1 });
    const noQueries = await bigqueryAdapter.fetchChanges({ ...base, client: fakeClient(() => ({})).client, config: { project_id: "p" } });
    expect(noQueries.stats).toEqual({ missing_queries: 1 });

    const { client, calls } = fakeClient((req) => {
      const body = req.body as { query: string };
      if (body.query.includes("slow")) return { jobComplete: false };
      return { jobComplete: true, schema: { fields: [{ name: "day" }, { name: "signups" }] }, rows: [{ f: [{ v: "2026-09-02" }, { v: "14" }] }], totalRows: "1" };
    });
    const { signals, stats } = await bigqueryAdapter.fetchChanges({
      ...base,
      client,
      config: { project_id: "acme-prod", queries: { Signups: "select day, signups from t where day > '{{since}}'", Slow: "slow" } },
    });
    expect(calls[0]?.path).toBe("/bigquery/v2/projects/acme-prod/queries");
    expect(calls[0]?.body).toMatchObject({ useLegacySql: false, maxResults: 200 });
    expect((calls[0]?.body as { query: string }).query).toContain("2026-09-01T00:00:00.000Z");
    expect(signals.map((s) => s.external_id)).toEqual(["query:signups"]);
    expect(signals[0]?.text).toContain("day | signups\n--- | ---\n2026-09-02 | 14");
    expect(signals[0]?.url).toBe("https://console.cloud.google.com/bigquery?project=acme-prod");
    expect(stats).toEqual({ queries: 2, executed: 1, pending: 1, failed: 0 });
    expect(bigqueryRows(undefined)).toEqual({ headers: [], rows: [] });
  });
});

describe("supabase adapter", () => {
  it("parses table specs and reads rows updated since through PostgREST", async () => {
    expect(supabaseTables({ tables: ["decisions", { name: "notes", updated_at_column: null, select: "id,body" }, { name: " " }] })).toEqual([
      { name: "decisions", updatedAtColumn: "updated_at", select: "*" },
      { name: "notes", updatedAtColumn: null, select: "id,body" },
    ]);
    const empty = await supabaseAdapter.fetchChanges({ ...base, client: fakeClient(() => ({})).client });
    expect(empty).toEqual({ signals: [], stats: { missing_tables: 1 } });

    const { client, calls } = fakeClient((req) => {
      if (req.path === "/rest/v1/decisions") {
        return [{ id: "d1", title: "Move billing to org level", updated_at: "2026-09-03T12:00:00Z", owner: "Ana" }];
      }
      if (req.path === "/rest/v1/notes") return [{ body: "hello" }];
      if (req.path === "/rest/v1/missing") return { status: 404, data: {} };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await supabaseAdapter.fetchChanges({
      ...base,
      client,
      connectionConfig: { projectUrl: "abc.supabase.co/" },
      config: { tables: ["decisions", { name: "notes", updated_at_column: null }, "missing"] },
    });
    expect(calls[0]?.query).toEqual({ select: "*", limit: 50, updated_at: "gte.2026-09-01T00:00:00.000Z", order: "updated_at.desc" });
    expect(calls[0]?.headers).toEqual({ Prefer: "count=exact" });
    expect(calls[1]?.query).toEqual({ select: "*", limit: 50 });
    expect(signals.map((s) => s.external_id)).toEqual(["row:decisions:d1", "row:notes:0"]);
    expect(signals[0]?.title).toBe("decisions · Move billing to org level");
    expect(signals[0]?.text).toContain("owner: Ana");
    expect(signals[0]?.at).toBe("2026-09-03T12:00:00Z");
    expect(signals[0]?.url).toBe("abc.supabase.co/rest/v1/decisions?id=eq.d1");
    expect(stats).toEqual({ tables: 3, rows: 2, failed: 1 });
  });
});

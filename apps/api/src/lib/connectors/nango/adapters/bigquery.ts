/**
 * Google BigQuery — `bigquery` → Nango `google-bigquery` (OAuth2 via
 * google; proxy base https://bigquery.googleapis.com).
 *
 * Query-driven like Snowflake: `config.project_id` (billing project) and
 * `config.queries` (`[{ name, sql }]` or `{ name: sql }`, `{{since}}`
 * interpolated) define what NEXO reads; one signal per query, ≤ 200 rows as
 * a compact table. Nothing configured → zero signals + `missing_*` stats.
 *
 * Assumptions (docs, not exercised live): `POST
 * /bigquery/v2/projects/{id}/queries` with `useLegacySql: false` answers
 * `{ jobComplete, schema: { fields: [{ name }] }, rows: [{ f: [{ v }] }],
 * totalRows }`; `jobComplete: false` is counted as `pending`, not polled.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { configString, type NangoAdapter } from "./shared";
import { interpolateSince, namedQueries, renderTable, slug } from "./tabular";

interface BqQueryResponse {
  jobComplete?: boolean;
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalRows?: string | number;
  errors?: Array<{ message?: string }>;
}

export const BIGQUERY_MAX_ROWS = 200;

export function bigqueryRows(res: BqQueryResponse | undefined): { headers: string[]; rows: unknown[][] } {
  const headers = (res?.schema?.fields ?? []).map((f) => f.name ?? "");
  const rows = (res?.rows ?? []).map((r) => (r.f ?? []).map((c) => c?.v));
  return { headers, rows };
}

export const bigqueryAdapter: NangoAdapter = {
  id: "bigquery",
  provider: "google-bigquery",
  sourceHint: "bigquery:queries",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const project = configString(config, "project_id");
    if (!project) return { signals: [], stats: { missing_project_id: 1 } };
    const queries = namedQueries(config);
    if (!queries.length) return { signals: [], stats: { missing_queries: 1 } };
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { queries: queries.length, executed: 0, pending: 0, failed: 0 };
    const now = new Date().toISOString();
    const url = `https://console.cloud.google.com/bigquery?project=${encodeURIComponent(project)}`;
    for (const q of queries) {
      if (signals.length >= limit) break;
      const res = await client.proxy<BqQueryResponse>({
        method: "POST",
        providerConfigKey: "bigquery",
        connectionId,
        path: `/bigquery/v2/projects/${encodeURIComponent(project)}/queries`,
        body: {
          query: interpolateSince(q.sql, since),
          useLegacySql: false,
          maxResults: BIGQUERY_MAX_ROWS,
          timeoutMs: 60_000,
        },
      });
      if (!res.ok) {
        stats.failed = (stats.failed ?? 0) + 1;
        continue;
      }
      if (res.data?.jobComplete === false) {
        stats.pending = (stats.pending ?? 0) + 1;
        continue;
      }
      stats.executed = (stats.executed ?? 0) + 1;
      const { headers, rows } = bigqueryRows(res.data);
      const total = Number(res.data?.totalRows ?? rows.length);
      signals.push({
        external_id: `query:${slug(q.name)}`,
        title: `BigQuery · ${q.name}`,
        text: [
          `Rows: ${total}${total > BIGQUERY_MAX_ROWS ? ` (showing ${BIGQUERY_MAX_ROWS})` : ""} · Run at: ${now}`,
          `SQL: ${q.sql.replace(/\s+/g, " ").slice(0, 300)}`,
          "",
          renderTable(headers, rows, { maxRows: BIGQUERY_MAX_ROWS }),
        ].join("\n"),
        url,
        at: now,
        kind_hint: "query_result",
      });
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

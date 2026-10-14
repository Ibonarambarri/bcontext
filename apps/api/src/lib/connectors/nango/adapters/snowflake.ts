/**
 * Snowflake — `snowflake` → Nango `snowflake` (OAuth2; proxy base
 * https://<connection_config.snowflake_account_url>).
 *
 * Query-driven: a warehouse has no "what changed" feed, so the workspace
 * defines the questions in `config.queries` (`[{ name, sql }]` or
 * `{ name: sql }`, `{{since}}` interpolated as the ISO cursor) — e.g.
 * "weekly KPIs" or "churned accounts this week". Each run executes them via
 * the SQL API and emits one signal per query with up to 200 rows rendered
 * as a compact table. No queries configured → zero signals and a
 * `missing_queries` stat so the hub can say what to fill in.
 *
 * Optional `config.warehouse`, `database`, `schema`, `role` go on the
 * statement. Assumptions (docs, not exercised live): `POST /api/v2/statements`
 * answers 200 with `{ resultSetMetaData: { rowType: [{ name }] }, data:
 * [[...]] }` or 202 when still running (counted as `pending`, not read);
 * the OAuth bearer needs `X-Snowflake-Authorization-Token-Type: OAUTH`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { configString, type NangoAdapter } from "./shared";
import { interpolateSince, namedQueries, renderTable, slug } from "./tabular";

interface SfStatementResult {
  statementHandle?: string;
  resultSetMetaData?: { numRows?: number; rowType?: Array<{ name?: string }> };
  data?: unknown[][];
  message?: string;
}

export const SNOWFLAKE_MAX_ROWS = 200;

export function snowflakeStatementBody(sql: string, config: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    statement: sql,
    timeout: 60,
    resultSetMetaData: { format: "jsonv2" },
  };
  for (const key of ["warehouse", "database", "schema", "role"] as const) {
    const v = configString(config, key);
    if (v) body[key] = v;
  }
  return body;
}

export const snowflakeAdapter: NangoAdapter = {
  id: "snowflake",
  provider: "snowflake",
  sourceHint: "snowflake:queries",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const queries = namedQueries(config);
    if (!queries.length) return { signals: [], stats: { missing_queries: 1 } };
    const account = typeof connectionConfig.snowflake_account_url === "string" ? connectionConfig.snowflake_account_url : "";
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { queries: queries.length, executed: 0, pending: 0, failed: 0 };
    const now = new Date().toISOString();
    for (const q of queries) {
      if (signals.length >= limit) break;
      const res = await client.proxy<SfStatementResult>({
        method: "POST",
        providerConfigKey: "snowflake",
        connectionId,
        path: "/api/v2/statements",
        headers: { "X-Snowflake-Authorization-Token-Type": "OAUTH", Accept: "application/json" },
        body: snowflakeStatementBody(interpolateSince(q.sql, since), config),
      });
      if (res.status === 202) {
        stats.pending = (stats.pending ?? 0) + 1;
        continue;
      }
      if (!res.ok) {
        stats.failed = (stats.failed ?? 0) + 1;
        continue;
      }
      stats.executed = (stats.executed ?? 0) + 1;
      const headers = (res.data?.resultSetMetaData?.rowType ?? []).map((c) => c.name ?? "");
      const rows = Array.isArray(res.data?.data) ? res.data!.data! : [];
      const total = res.data?.resultSetMetaData?.numRows ?? rows.length;
      signals.push({
        external_id: `query:${slug(q.name)}`,
        title: `Snowflake · ${q.name}`,
        text: [
          `Rows: ${total}${total > SNOWFLAKE_MAX_ROWS ? ` (showing ${SNOWFLAKE_MAX_ROWS})` : ""} · Run at: ${now}`,
          `SQL: ${q.sql.replace(/\s+/g, " ").slice(0, 300)}`,
          "",
          renderTable(headers, rows, { maxRows: SNOWFLAKE_MAX_ROWS }),
        ].join("\n"),
        url: account ? `https://${account.replace(/^https?:\/\//, "")}` : undefined,
        at: now,
        kind_hint: "query_result",
      });
    }
    return { signals: signals.slice(0, limit), stats };
  },
};

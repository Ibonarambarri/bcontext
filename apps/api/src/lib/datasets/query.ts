/**
 * `DatasetQuery` → parameterised SQL.
 *
 * This is the only place a dataset question becomes a database question, and
 * it is written under two rules that are not negotiable:
 *
 *  1. **Every column a query names is checked against the stored schema before
 *     any SQL is built** (`unknownColumns`, from the contract). A column that
 *     is not in the schema is a validation error naming the columns that are —
 *     never an empty result set, which would let an agent conclude the dataset
 *     has no rows over 500 when what it actually has is no column called
 *     `mrr_usd`. Because of that check, a column name reaching the builder is
 *     one WE stored; it still travels as a bind parameter (`data ->> $3`),
 *     never spliced into the string, so the check is the policy and the
 *     parameter is the guarantee.
 *  2. **No value is ever interpolated.** Literals, LIKE patterns, `in` lists,
 *     limit and offset are all `$n`. The one thing built from caller input
 *     without a parameter is an ORDER BY direction, which comes from a
 *     two-value enum, and the aggregate aliases — which are NOT emitted as SQL
 *     identifiers at all: the select list is positional (`a0`, `a1`) and the
 *     caller's names are re-attached in JavaScript afterwards. An agent that
 *     names an aggregate `x"; drop table` gets a key in a JSON object.
 *
 * The column types are what make the answers right. Values are stored typed
 * (see `values.ts`), so a `number` column compares as `numeric` and not as
 * text — the difference between `mrr > 500` matching 90 and not matching it.
 * Dates are the deliberate exception: they compare as text, because ISO-8601
 * is lexicographically chronological and a `::timestamptz` cast on a shared
 * jsonb column has no total, non-throwing form (Postgres has no `try_cast`).
 * Ingest normalises the separator to `T` so that ordering is exact.
 */
import {
  DATASET_QUERY_DEFAULT_LIMIT,
  DATASET_QUERY_MAX_LIMIT,
  DATASET_AGGREGATES,
  DATASET_OPERATORS,
  unknownColumns,
  type DatasetAggregate,
  type DatasetColumn,
  type DatasetFilter,
  type DatasetQuery,
} from "@bcontext-dev/contract/datasets";
import { DatasetError } from "./errors";
import { coerceFilterValue } from "./values";
import { DATASET_ROWS_TABLE } from "./rows";

/** Bounds that keep one malformed query from becoming an outage. */
export const DATASET_MAX_FILTERS = 20;
const DATASET_MAX_IN_VALUES = 500;
export const DATASET_MAX_AGGREGATES = 10;
export const DATASET_MAX_GROUP_BY = 4;

/** How a returned SQL row becomes the caller's row. */
export type DatasetResultShape =
  | { kind: "rows"; columns: string[] }
  | { kind: "aggregate"; map: Array<{ sql: string; as: string }> };

export interface CompiledDatasetQuery {
  text: string;
  values: unknown[];
  shape: DatasetResultShape;
  /** The clamped values actually used, so the caller can report them back. */
  limit: number;
  offset: number;
}

/**
 * A number written as text, strictly enough that `::numeric` cannot throw.
 * Deliberately free of backslash escapes so it means the same thing whatever
 * `standard_conforming_strings` is set to.
 */
const NUMERIC_TEXT = "^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$";

/** `!` rather than `\` as the LIKE escape, for the same reason. */
function likePattern(value: string, mode: "contains" | "starts_with"): string {
  const escaped = value.replace(/[!%_]/g, (c) => `!${c}`);
  return mode === "contains" ? `%${escaped}%` : `${escaped}%`;
}

class Builder {
  readonly values: unknown[] = [];
  param(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * The SQL that reads one column as its declared type.
 *
 * Every branch is total: a row whose value does not match the column type
 * yields NULL instead of raising. Postgres cannot enforce per-column types in
 * a shared jsonb table (see migration 0086), so a hand-written row, or one
 * left by a future bug, must degrade to "no value" — one bad cell must not
 * make the whole dataset unqueryable. The `'string'` branches also mean a
 * dataset written before values were typed still answers correctly.
 */
function typedExpr(column: DatasetColumn, key: string): string {
  switch (column.type) {
    case "number":
      return (
        `(case jsonb_typeof(d.data -> ${key})` +
        ` when 'number' then (d.data ->> ${key})::numeric` +
        ` when 'string' then (case when btrim(d.data ->> ${key}) ~ '${NUMERIC_TEXT}'` +
        ` then btrim(d.data ->> ${key})::numeric end)` +
        ` end)`
      );
    case "boolean":
      return (
        `(case jsonb_typeof(d.data -> ${key})` +
        ` when 'boolean' then (d.data ->> ${key})::boolean` +
        ` when 'string' then (case when lower(btrim(d.data ->> ${key})) in ('true','yes','1') then true` +
        ` when lower(btrim(d.data ->> ${key})) in ('false','no','0') then false end)` +
        ` end)`
      );
    // date and text both compare as text; see the module header for why a date
    // does not need a cast to sort chronologically.
    default:
      return `(d.data ->> ${key})`;
  }
}

const RANGE_OPERATORS = new Set(["lt", "lte", "gt", "gte"]);
const SQL_COMPARISON: Record<string, string> = { lt: "<", lte: "<=", gt: ">", gte: ">=" };

function whereClause(builder: Builder, filter: DatasetFilter, column: DatasetColumn): string {
  const key = builder.param(column.name);
  const op = filter.op;
  if (!DATASET_OPERATORS.includes(op)) {
    throw new DatasetError(
      "invalid_query",
      `unknown operator \`${op}\`. Operators: ${DATASET_OPERATORS.join(", ")}`,
    );
  }

  // `is_null` covers both halves, and `eq: null` means the same question — a
  // caller asking which rows have no plan should not have to know which of the
  // two spellings this dialect chose.
  const missing =
    `(d.data -> ${key} is null or d.data -> ${key} = 'null'::jsonb or (d.data ->> ${key}) = '')`;
  if (op === "is_null") return filter.value === false ? `not ${missing}` : missing;
  if ((op === "eq" || op === "ne") && (filter.value === null || filter.value === undefined)) {
    return op === "eq" ? missing : `not ${missing}`;
  }

  if (op === "eq" || op === "ne") {
    // Containment, not `=`: this is the one operator the GIN index on
    // (node_id, data jsonb_path_ops) can serve, and equality is the filter
    // most likely to be selective. Typed storage is what makes it work —
    // `{"mrr": 1200}` never matches a row holding `"1200"`.
    const literal = builder.param(JSON.stringify(coerceFilterValue(column, filter.value)));
    const contains = `d.data @> jsonb_build_object(${key}, ${literal}::jsonb)`;
    // `ne` counts a missing value as "not equal": the row does not have that
    // value, which is what the question asks, and SQL's NULL-swallowing answer
    // would silently drop those rows from both `eq` and `ne`.
    return op === "eq" ? contains : `not (${contains})`;
  }

  if (RANGE_OPERATORS.has(op)) {
    if (column.type === "boolean") {
      throw new DatasetError(
        "invalid_query",
        `\`${column.name}\` is a boolean column; use eq/ne rather than ${op}`,
      );
    }
    const cast = column.type === "number" ? "::numeric" : "::text";
    const literal = builder.param(coerceFilterValue(column, filter.value));
    return `${typedExpr(column, key)} ${SQL_COMPARISON[op]} ${literal}${cast}`;
  }

  if (op === "contains" || op === "starts_with") {
    if (column.type === "number" || column.type === "boolean") {
      throw new DatasetError(
        "invalid_query",
        `${op} is a text match; \`${column.name}\` is a ${column.type} column — use eq or a range`,
      );
    }
    const literal = builder.param(likePattern(String(filter.value ?? ""), op));
    return `(d.data ->> ${key}) ilike ${literal} escape '!'`;
  }

  // in
  if (!Array.isArray(filter.value)) {
    throw new DatasetError("invalid_query", `\`in\` on \`${column.name}\` needs an array of values`);
  }
  if (filter.value.length === 0) return "false";
  if (filter.value.length > DATASET_MAX_IN_VALUES) {
    throw new DatasetError(
      "invalid_query",
      `\`in\` on \`${column.name}\` carries ${filter.value.length} values; at most ${DATASET_MAX_IN_VALUES}`,
    );
  }
  const list = builder.param(
    filter.value.map((value) => JSON.stringify(coerceFilterValue(column, value))),
  );
  return `(d.data -> ${key}) = any(${list}::jsonb[])`;
}

function aggregateExpr(
  builder: Builder,
  fn: DatasetAggregate,
  column: DatasetColumn | null,
): string {
  if (fn === "count") {
    // `count(col)` counts rows where the column has a value; `count()` counts
    // rows. Both are worth having and the difference is the presence of a
    // column, which is how the contract already spells it.
    if (!column) return "count(*)::int";
    return `count(${typedExpr(column, builder.param(column.name))})::int`;
  }
  if (!column) {
    throw new DatasetError("invalid_query", `${fn} needs a \`column\``);
  }
  if (fn === "sum" || fn === "avg") {
    if (column.type !== "number") {
      throw new DatasetError(
        "invalid_query",
        `${fn} needs a number column; \`${column.name}\` is ${column.type}`,
      );
    }
    return `${fn}(${typedExpr(column, builder.param(column.name))})::float8`;
  }
  // min/max
  if (column.type === "boolean") {
    throw new DatasetError("invalid_query", `${fn} does not apply to the boolean column \`${column.name}\``);
  }
  const expr = `${fn}(${typedExpr(column, builder.param(column.name))})`;
  return column.type === "number" ? `${expr}::float8` : expr;
}

/**
 * Build the statement. Throws `DatasetError` for anything the caller can fix;
 * anything it does not throw for is safe to send to Postgres as-is.
 */
export function compileDatasetQuery(
  query: DatasetQuery,
  columns: readonly DatasetColumn[],
  target: { nodeId: string; workspaceId: string },
): CompiledDatasetQuery {
  // Rule 1, and it happens first for a reason: nothing below may look at a
  // column name that is not one of ours.
  const unknown = unknownColumns(query, columns);
  if (unknown.length > 0) {
    throw new DatasetError(
      "unknown_column",
      `no such column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `This dataset has: ${columns.map((c) => `${c.name} (${c.type})`).join(", ") || "no columns"}`,
    );
  }
  const byName = new Map(columns.map((column) => [column.name, column]));
  const need = (name: string): DatasetColumn => byName.get(name)!;

  const builder = new Builder();
  // The workspace filter is not decoration: no server path evaluates RLS
  // (service-role everywhere), so this `where` is the tenant boundary.
  const where = [
    `d.node_id = ${builder.param(target.nodeId)}::uuid`,
    `d.workspace_id = ${builder.param(target.workspaceId)}::uuid`,
  ];

  const filters = query.where ?? [];
  if (filters.length > DATASET_MAX_FILTERS) {
    throw new DatasetError(
      "invalid_query",
      `${filters.length} filters; at most ${DATASET_MAX_FILTERS}`,
    );
  }
  for (const filter of filters) where.push(whereClause(builder, filter, need(filter.column)));

  const aggregates = query.aggregate ?? [];
  const groupBy = query.group_by ?? [];
  const grouped = aggregates.length > 0 || groupBy.length > 0;

  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? DATASET_QUERY_DEFAULT_LIMIT)),
    DATASET_QUERY_MAX_LIMIT,
  );
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));

  let select: string;
  let shape: DatasetResultShape;
  let tail = "";

  if (grouped) {
    if (groupBy.length > DATASET_MAX_GROUP_BY) {
      throw new DatasetError("invalid_query", `group_by takes at most ${DATASET_MAX_GROUP_BY} columns`);
    }
    if (aggregates.length > DATASET_MAX_AGGREGATES) {
      throw new DatasetError("invalid_query", `at most ${DATASET_MAX_AGGREGATES} aggregates`);
    }
    const seen = new Set<string>();
    const map: Array<{ sql: string; as: string }> = [];
    const parts: string[] = [];
    groupBy.forEach((name, index) => {
      const alias = `g${index}`;
      parts.push(`${typedExpr(need(name), builder.param(name))} as ${alias}`);
      map.push({ sql: alias, as: name });
      seen.add(name);
    });
    aggregates.forEach((agg, index) => {
      if (!DATASET_AGGREGATES.includes(agg.fn)) {
        throw new DatasetError(
          "invalid_query",
          `unknown aggregate \`${agg.fn}\`. Aggregates: ${DATASET_AGGREGATES.join(", ")}`,
        );
      }
      // The alias is the caller's word, so it stays out of the SQL entirely
      // and is re-attached to the positional column below.
      if (!agg.as || seen.has(agg.as)) {
        throw new DatasetError(
          "invalid_query",
          agg.as ? `duplicate result name \`${agg.as}\`` : `every aggregate needs an \`as\` name`,
        );
      }
      seen.add(agg.as);
      const alias = `a${index}`;
      parts.push(`${aggregateExpr(builder, agg.fn, agg.column ? need(agg.column) : null)} as ${alias}`);
      map.push({ sql: alias, as: agg.as });
    });
    select = parts.join(", ");
    shape = { kind: "aggregate", map };
    if (groupBy.length > 0) {
      tail += ` group by ${groupBy.map((_, index) => index + 1).join(", ")}`;
    }
    if (query.order_by) {
      const position = groupBy.indexOf(query.order_by.column);
      if (position === -1) {
        throw new DatasetError(
          "invalid_query",
          `order_by must name a group_by column when the query aggregates; ` +
            `\`${query.order_by.column}\` is not one of: ${groupBy.join(", ") || "none"}`,
        );
      }
      tail += ` order by ${position + 1} ${query.order_by.direction === "desc" ? "desc" : "asc"} nulls last`;
    }
  } else {
    // The projection is always the declared schema, never `data` whole: a key
    // left in a row by an older write is not part of this dataset and must not
    // travel back out of it.
    const projected = (query.select?.length ? query.select : columns.map((c) => c.name)).map(need);
    select = projected.length
      ? `jsonb_build_object(${projected
          .map((column) => `${builder.param(column.name)}, d.data -> ${builder.param(column.name)}`)
          .join(", ")}) as row`
      : `'{}'::jsonb as row`;
    shape = { kind: "rows", columns: projected.map((c) => c.name) };
    if (query.order_by) {
      const column = need(query.order_by.column);
      const direction = query.order_by.direction === "desc" ? "desc" : "asc";
      tail += ` order by ${typedExpr(column, builder.param(column.name))} ${direction} nulls last, d.idx asc`;
    } else {
      // Original file order. `idx` is stable and may have gaps, so it is an
      // ordering key and never a row number.
      tail += " order by d.idx asc";
    }
  }

  const text =
    `select ${select} from ${DATASET_ROWS_TABLE} d where ${where.join(" and ")}${tail}` +
    ` limit ${builder.param(limit)} offset ${builder.param(offset)}`;
  return { text, values: builder.values, shape, limit, offset };
}

/** Turn the driver's rows into the caller's rows, per the compiled shape. */
export function shapeDatasetRows(
  shape: DatasetResultShape,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  if (shape.kind === "rows") {
    return rows.map((row) => (row.row ?? {}) as Record<string, unknown>);
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const entry of shape.map) out[entry.as] = row[entry.sql] ?? null;
    return out;
  });
}

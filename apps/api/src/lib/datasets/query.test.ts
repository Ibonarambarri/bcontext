import { describe, expect, it } from "vitest";
import {
  DATASET_QUERY_DEFAULT_LIMIT,
  DATASET_QUERY_MAX_LIMIT,
  type DatasetColumn,
  type DatasetQuery,
} from "@bcontext-dev/contract/datasets";
import { DatasetError } from "./errors";
import { compileDatasetQuery, shapeDatasetRows } from "./query";

const COLUMNS: DatasetColumn[] = [
  { name: "company", type: "text", nullable: false },
  { name: "plan", type: "text", nullable: false },
  { name: "mrr", type: "number", nullable: false },
  { name: "active", type: "boolean", nullable: false },
  { name: "signed_at", type: "date", nullable: true },
];
const TARGET = { nodeId: "11111111-1111-1111-1111-111111111111", workspaceId: "22222222-2222-2222-2222-222222222222" };

function compile(query: Partial<DatasetQuery>) {
  return compileDatasetQuery({ schema_version: 1, ...query } as DatasetQuery, COLUMNS, TARGET);
}

describe("compileDatasetQuery — what reaches the database", () => {
  it("scopes every statement to the node AND the workspace", () => {
    const compiled = compile({});
    expect(compiled.text).toContain("d.node_id = $1::uuid");
    expect(compiled.text).toContain("d.workspace_id = $2::uuid");
    expect(compiled.values.slice(0, 2)).toEqual([TARGET.nodeId, TARGET.workspaceId]);
  });

  it("never puts a value in the SQL text — only $n placeholders", () => {
    const compiled = compile({
      where: [
        { column: "mrr", op: "gt", value: 500 },
        { column: "company", op: "contains", value: "acme" },
        { column: "plan", op: "in", value: ["pro", "enterprise"] },
      ],
      order_by: { column: "mrr", direction: "desc" },
      limit: 25,
    });
    expect(compiled.text).not.toContain("500");
    expect(compiled.text).not.toContain("acme");
    expect(compiled.text).not.toContain("enterprise");
    expect(compiled.values).toContain(500);
  });

  it("passes column names as parameters too, never spliced into the text", () => {
    const compiled = compile({ select: ["company"] });
    expect(compiled.text).not.toContain("company");
    expect(compiled.values).toContain("company");
  });

  it("projects the declared schema when `select` is omitted, not `data` whole", () => {
    const compiled = compile({});
    expect(compiled.text).toContain("jsonb_build_object");
    for (const column of COLUMNS) expect(compiled.values).toContain(column.name);
    expect(compiled.shape).toEqual({ kind: "rows", columns: COLUMNS.map((c) => c.name) });
  });
});

describe("compileDatasetQuery — the types decide the comparison", () => {
  it("compares a number column numerically, so 90 is not greater than 500", () => {
    const compiled = compile({ where: [{ column: "mrr", op: "gt", value: 500 }] });
    // The stored value is a JSON number; the comparison casts both sides to
    // numeric. Text comparison is what makes "90" > "500" true.
    expect(compiled.text).toContain("::numeric");
    expect(compiled.text).toMatch(/end\) > \$\d+::numeric/);
    expect(compiled.values).toContain(500);
    expect(compiled.values).not.toContain("500");
  });

  it("coerces a numeric string in the filter to a number", () => {
    const compiled = compile({ where: [{ column: "mrr", op: "gte", value: "500" }] });
    expect(compiled.values).toContain(500);
  });

  it("refuses a filter value that is not a number for a number column", () => {
    expect(() => compile({ where: [{ column: "mrr", op: "gt", value: "lots" }] })).toThrow(
      /is a number column/,
    );
  });

  it("orders a date column chronologically (ISO text is chronological once normalised)", () => {
    const compiled = compile({ order_by: { column: "signed_at", direction: "asc" } });
    expect(compiled.text).toMatch(/order by \(d\.data ->> \$\d+\) asc nulls last, d\.idx asc/);
  });

  it("normalises a date filter value to the stored spelling", () => {
    const compiled = compile({ where: [{ column: "signed_at", op: "gte", value: "2026-01-02 10:00" }] });
    expect(compiled.values).toContain("2026-01-02T10:00");
  });

  it("refuses a date filter that is not an ISO date", () => {
    expect(() => compile({ where: [{ column: "signed_at", op: "lt", value: "last tuesday" }] })).toThrow(
      /is not an ISO date/,
    );
  });

  it("translates equality to containment so the GIN index can serve it", () => {
    const compiled = compile({ where: [{ column: "plan", op: "eq", value: "pro" }] });
    expect(compiled.text).toContain("d.data @> jsonb_build_object");
    expect(compiled.values).toContain('"pro"');
  });

  it("stores a boolean filter as a JSON boolean, not the string 'true'", () => {
    const compiled = compile({ where: [{ column: "active", op: "eq", value: "yes" }] });
    expect(compiled.values).toContain("true");
    expect(compiled.values).not.toContain('"yes"');
  });

  it("refuses a range on a boolean column instead of comparing it as text", () => {
    expect(() => compile({ where: [{ column: "active", op: "gt", value: true }] })).toThrow(
      /use eq\/ne/,
    );
  });

  it("refuses a text match on a number column", () => {
    expect(() => compile({ where: [{ column: "mrr", op: "contains", value: "5" }] })).toThrow(
      /is a number column/,
    );
  });
});

describe("compileDatasetQuery — the hostile cases", () => {
  it("rejects a column that does not exist, naming the ones that do", () => {
    let error: unknown;
    try {
      compile({ where: [{ column: "mrr_usd", op: "gt", value: 1 }] });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DatasetError);
    expect((error as DatasetError).code).toBe("unknown_column");
    // An empty result set would let the caller believe the dataset has no rows
    // over 1, rather than that it asked about a column that is not there.
    expect((error as DatasetError).message).toContain("mrr (number)");
  });

  it("rejects an invented column whose name carries SQL, before any SQL is built", () => {
    const hostile = `mrr"; drop table public.dataset_rows; --`;
    expect(() => compile({ where: [{ column: hostile, op: "gt", value: 1 }] })).toThrow(DatasetError);
    expect(() => compile({ select: [hostile] })).toThrow(DatasetError);
    expect(() => compile({ order_by: { column: hostile, direction: "asc" } })).toThrow(DatasetError);
    expect(() => compile({ group_by: [hostile] })).toThrow(DatasetError);
    expect(() => compile({ aggregate: [{ fn: "sum", column: hostile, as: "total" }] })).toThrow(DatasetError);
  });

  it("keeps an aggregate alias out of the SQL entirely", () => {
    const compiled = compile({
      group_by: ["plan"],
      aggregate: [{ fn: "sum", column: "mrr", as: 'total"; drop table public.nodes; --' }],
    });
    expect(compiled.text).not.toContain("drop table");
    expect(compiled.text).toContain(" as a0");
    // The caller's name is re-attached in JavaScript, where it is a key.
    const shaped = shapeDatasetRows(compiled.shape, [{ g0: "pro", a0: 1200 }]);
    expect(shaped).toEqual([{ plan: "pro", 'total"; drop table public.nodes; --': 1200 }]);
  });

  it("caps a limit of a million at the contract ceiling", () => {
    const compiled = compile({ limit: 1_000_000 });
    expect(compiled.limit).toBe(DATASET_QUERY_MAX_LIMIT);
    expect(compiled.values).toContain(DATASET_QUERY_MAX_LIMIT);
  });

  it("defaults the limit rather than returning the whole dataset", () => {
    expect(compile({}).limit).toBe(DATASET_QUERY_DEFAULT_LIMIT);
  });

  it("refuses a limit of zero or a negative offset by clamping to something sane", () => {
    expect(compile({ limit: 0 }).limit).toBe(1);
    expect(compile({ offset: -50 }).offset).toBe(0);
  });

  it("rejects an operator that does not exist", () => {
    expect(() =>
      compile({ where: [{ column: "mrr", op: "regex" as never, value: ".*" }] }),
    ).toThrow(/unknown operator/);
  });

  it("rejects an aggregate function that does not exist", () => {
    expect(() =>
      compile({ group_by: ["plan"], aggregate: [{ fn: "median" as never, column: "mrr", as: "m" }] }),
    ).toThrow(/unknown aggregate/);
  });

  it("rejects more filters than a question ever needs", () => {
    const where = Array.from({ length: 21 }, () => ({ column: "mrr", op: "gt" as const, value: 1 }));
    expect(() => compile({ where })).toThrow(/at most 20/);
  });

  it("rejects an oversized `in` list", () => {
    const value = Array.from({ length: 501 }, (_, i) => `plan_${i}`);
    expect(() => compile({ where: [{ column: "plan", op: "in", value }] })).toThrow(/at most 500/);
  });

  it("reads an empty `in` list as matching nothing, not everything", () => {
    const compiled = compile({ where: [{ column: "plan", op: "in", value: [] }] });
    expect(compiled.text).toContain("and false");
  });

  it("escapes LIKE metacharacters in the pattern instead of letting them match", () => {
    const compiled = compile({ where: [{ column: "company", op: "starts_with", value: "100%_" }] });
    expect(compiled.values).toContain("100!%!_%");
    expect(compiled.text).toContain("escape '!'");
  });
});

describe("compileDatasetQuery — aggregates", () => {
  it("groups by position and re-attaches names afterwards", () => {
    const compiled = compile({
      group_by: ["plan"],
      aggregate: [
        { fn: "count", as: "customers" },
        { fn: "avg", column: "mrr", as: "average_mrr" },
      ],
      order_by: { column: "plan", direction: "desc" },
    });
    expect(compiled.text).toContain("group by 1");
    expect(compiled.text).toContain("order by 1 desc nulls last");
    expect(compiled.text).toContain("count(*)::int as a0");
    expect(compiled.text).toContain("avg(");
    expect(shapeDatasetRows(compiled.shape, [{ g0: "pro", a0: 3, a1: 400 }])).toEqual([
      { plan: "pro", customers: 3, average_mrr: 400 },
    ]);
  });

  it("aggregates the whole match when there is no group_by", () => {
    const compiled = compile({ aggregate: [{ fn: "max", column: "mrr", as: "top" }] });
    expect(compiled.text).not.toContain("group by");
    expect(compiled.text).toContain("max(");
  });

  it("refuses to sum a text column", () => {
    expect(() => compile({ aggregate: [{ fn: "sum", column: "plan", as: "x" }] })).toThrow(
      /needs a number column/,
    );
  });

  it("refuses two results with the same name", () => {
    expect(() =>
      compile({
        group_by: ["plan"],
        aggregate: [{ fn: "count", as: "plan" }],
      }),
    ).toThrow(/duplicate result name/);
  });

  it("refuses ordering an aggregate query by something it did not group by", () => {
    expect(() =>
      compile({
        group_by: ["plan"],
        aggregate: [{ fn: "count", as: "n" }],
        order_by: { column: "mrr", direction: "asc" },
      }),
    ).toThrow(/order_by must name a group_by column/);
  });
});

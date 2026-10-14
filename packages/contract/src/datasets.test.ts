import { describe, expect, it } from "vitest";
import {
  inferColumnType,
  inferSchema,
  unknownColumns,
  type DatasetQuery,
} from "./datasets.js";

describe("inferColumnType", () => {
  it("reads a column of flags as boolean rather than as zeros and ones", () => {
    expect(inferColumnType(["1", "0", "1"])).toBe("boolean");
  });

  it("demotes a whole column when one value does not fit", () => {
    // The 14 rows that say N/A are exactly why: typed as number, they would
    // drop out of every range filter without anyone being told.
    expect(inferColumnType(["1200", "980", "N/A", "1500"])).toBe("text");
  });

  it("ignores blanks, which carry no evidence either way", () => {
    expect(inferColumnType(["1200", "", "  ", "980"])).toBe("number");
  });

  it("falls back to text for a column with nothing in it", () => {
    expect(inferColumnType(["", "", ""])).toBe("text");
  });

  it("recognises dates with and without a time part", () => {
    expect(inferColumnType(["2026-03-11", "2026-09-01T10:30:00Z"])).toBe("date");
  });

  it("keeps free prose as text", () => {
    expect(inferColumnType(["Ana García", "Bruno"])).toBe("text");
  });
});

describe("inferSchema", () => {
  it("types each column independently and records emptiness", () => {
    const columns = inferSchema(
      ["name", "mrr", "signed_up", "active"],
      [
        ["Ana", "1200", "2026-03-11", "true"],
        ["Bruno", "980", "2026-04-02", "false"],
        ["Carla", "", "2026-05-19", "true"],
      ],
    );
    expect(columns).toEqual([
      { name: "name", type: "text", nullable: false },
      { name: "mrr", type: "number", nullable: true },
      { name: "signed_up", type: "date", nullable: false },
      { name: "active", type: "boolean", nullable: false },
    ]);
  });
});

describe("unknownColumns", () => {
  const columns = [
    { name: "name", type: "text" as const, nullable: false },
    { name: "mrr", type: "number" as const, nullable: false },
  ];

  it("passes a query that only names columns the dataset has", () => {
    const query: DatasetQuery = {
      schema_version: 1,
      select: ["name"],
      where: [{ column: "mrr", op: "gt", value: 500 }],
      order_by: { column: "mrr", direction: "desc" },
    };
    expect(unknownColumns(query, columns)).toEqual([]);
  });

  it("catches an invented column before it can reach SQL", () => {
    const query: DatasetQuery = {
      schema_version: 1,
      where: [{ column: "salary; drop table nodes", op: "gt", value: 0 }],
    };
    expect(unknownColumns(query, columns)).toEqual(["salary; drop table nodes"]);
  });

  it("looks inside group_by and aggregates too", () => {
    const query: DatasetQuery = {
      schema_version: 1,
      group_by: ["plan"],
      aggregate: [{ fn: "sum", column: "arr", as: "total" }],
    };
    expect(unknownColumns(query, columns).sort()).toEqual(["arr", "plan"]);
  });

  it("reports each unknown column once", () => {
    const query: DatasetQuery = {
      schema_version: 1,
      select: ["plan"],
      where: [{ column: "plan", op: "eq", value: "pro" }],
    };
    expect(unknownColumns(query, columns)).toEqual(["plan"]);
  });
});

import { describe, expect, it } from "vitest";
import { DATASET_QUERY_MAX_LIMIT } from "@bcontext-dev/contract/datasets";
import {
  buildDatasetQuery,
  cellText,
  datasetFromNodeData,
  datasetFromResponse,
  extractLegacyCsv,
  filterIsActive,
  operatorsFor,
} from "./datasets";

describe("cells", () => {
  it("tells an absent value apart from a zero", () => {
    expect(cellText(null)).toBeNull();
    expect(cellText(undefined)).toBeNull();
    expect(cellText("")).toBeNull();
    expect(cellText("   ")).toBeNull();
    expect(cellText(0)).toBe("0");
    expect(cellText(false)).toBe("false");
  });
});

describe("the query", () => {
  it("pages and orders against the server, within the contract's ceiling", () => {
    const query = buildDatasetQuery({
      limit: DATASET_QUERY_MAX_LIMIT + 500,
      offset: 200,
      sort: { column: "mrr", direction: "desc" },
      filter: null,
    });
    expect(query.limit).toBe(DATASET_QUERY_MAX_LIMIT);
    expect(query.offset).toBe(200);
    expect(query.order_by).toEqual({ column: "mrr", direction: "desc" });
    expect(query.where).toBeUndefined();
  });

  it("drops a filter that has no value yet, and keeps the one that needs none", () => {
    const half = buildDatasetQuery({
      limit: 100,
      offset: 0,
      sort: null,
      filter: { column: "plan", op: "contains", value: "  " },
    });
    expect(half.where).toBeUndefined();
    expect(filterIsActive({ column: "plan", op: "contains", value: "" })).toBe(false);

    const empty = buildDatasetQuery({
      limit: 100,
      offset: 0,
      sort: null,
      filter: { column: "plan", op: "is_null", value: "" },
    });
    expect(empty.where).toEqual([{ column: "plan", op: "is_null" }]);
  });

  it("offers only the operators the column's type admits", () => {
    expect(operatorsFor("number")).not.toContain("contains");
    expect(operatorsFor("boolean")).not.toContain("gt");
    expect(operatorsFor("text")).toContain("contains");
  });
});

describe("the shape", () => {
  it("reads a dataset off the node payload, and says so when there is none", () => {
    expect(datasetFromNodeData({ description: "Customers" })).toBeNull();
    expect(datasetFromNodeData(null)).toBeNull();
    const view = datasetFromNodeData({
      description: "Customers",
      dataset: {
        schema_version: 1,
        columns: [{ name: "mrr", type: "number", nullable: false }],
        row_count: 0,
        source_file: null,
        updated_at: "2026-09-10T00:00:00.000Z",
      },
    });
    // A dataset with no rows is a dataset: the columns are real.
    expect(view).toEqual({
      columns: [{ name: "mrr", type: "number", nullable: false }],
      rowCount: 0,
      description: "Customers",
      sourceFile: null,
    });
  });

  it("reads the same view off the route's payload", () => {
    expect(
      datasetFromResponse({
        columns: [{ name: "week", type: "text", nullable: false }],
        row_count: 12,
        description: null,
        source_file: { path: "a/b.csv", filename: "b.csv", bytes: 42, uploaded_at: "x" },
      })?.sourceFile?.filename,
    ).toBe("b.csv");
    expect(datasetFromResponse({ columns: [], row_count: 0 })).toBeNull();
  });
});

describe("legacy bodies", () => {
  it("lifts the csv fence out and keeps the prose around it", () => {
    const legacy = extractLegacyCsv("Signups by week.\n\n```csv\nweek,signups\n2026-W01,42\n```\n\nSource: Metabase.");
    expect(legacy?.csv).toBe("week,signups\n2026-W01,42");
    expect(legacy?.remainder).toBe("Signups by week.\n\nSource: Metabase.");
  });

  it("finds nothing in a body that has no table", () => {
    expect(extractLegacyCsv("Just prose.")).toBeNull();
    expect(extractLegacyCsv("```csv\n\n```")).toBeNull();
    expect(extractLegacyCsv("")).toBeNull();
  });
});

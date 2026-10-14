/**
 * The dataset service: what a write puts in `dataset_rows`, what it leaves on
 * the node, and what it refuses.
 *
 * `dataset_rows` is reached through the `pg` pool, so these run against a fake
 * pool that keeps the rows in memory and answers the three statements
 * `rows.ts` sends. That is the seam worth faking: what is being tested here is
 * the shape of what gets stored — above all that values arrive TYPED — and the
 * rules around a write, not Postgres.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";
import { setPoolForTests } from "@/lib/queue/db";
import { DATASET_MAX_ROWS, DATASET_MAX_ROWS_PER_WRITE } from "@bcontext-dev/contract/datasets";
import {
  appendRowsToDataset,
  createDataset,
  readDatasetSchema,
  replaceDatasetRows,
  sampleDataset,
  DatasetError,
} from "./index";

/** Rows the fake pool holds, keyed by node id. */
const stored = new Map<string, Array<{ idx: number; data: Record<string, unknown> }>>();

function rowsOf(nodeId: string) {
  return stored.get(nodeId) ?? [];
}

async function runStatement(text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
  // `replaceAllRows` wraps its delete + insert in a transaction; the fake keeps
  // no snapshot, so the markers are accepted and ignored.
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
  const nodeId = String(values[0]);
  if (text.startsWith("insert into")) {
    const batch = JSON.parse(String(values[2])) as Array<{ idx: number; data: Record<string, unknown> }>;
    stored.set(nodeId, [...rowsOf(nodeId), ...batch]);
    return { rows: [] };
  }
  if (text.startsWith("delete from")) {
    stored.set(nodeId, []);
    return { rows: [] };
  }
  if (text.includes("count(*)::int as count")) {
    const rows = rowsOf(nodeId);
    return {
      rows: [{ count: rows.length, max_idx: rows.length ? Math.max(...rows.map((r) => r.idx)) : null }],
    };
  }
  if (text.startsWith("select data from")) {
    const limit = Number(values[2]);
    return { rows: rowsOf(nodeId).slice().sort((a, b) => a.idx - b.idx).slice(0, limit).map((r) => ({ data: r.data })) };
  }
  throw new Error(`the fake pool was not taught this statement: ${text}`);
}

const fakePool = {
  query: (text: string, values: unknown[]) => runStatement(text, values),
  connect: async () => ({
    query: (text: string, values?: unknown[]) => runStatement(text, values ?? []),
    release: () => {},
  }),
};

let storage: Storage;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeEach(() => {
  stored.clear();
  process.env.DATABASE_URL = "postgres://fake/test";
  setPoolForTests(fakePool as never);
  const slug = `datasets-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: "Datasets", slug });
  storage = resolveDemoStorage(slug)!;
});

afterEach(() => {
  setPoolForTests(null);
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const CSV = [
  "company,plan,mrr,active,signed_at",
  "Acme,pro,500,true,2026-01-02",
  '"Globex, Inc",free,90,false,2026-02-11 09:30',
  "Initech,enterprise,,true,",
].join("\n");

describe("ingest", () => {
  it("puts the rows in the table and the schema on the node, with no CSV in the body", async () => {
    const { node, dataset, rows_written } = await createDataset(storage, {
      title: "Customers",
      description: "Every paying account and what it pays.",
      csv: CSV,
    });

    expect(rows_written).toBe(3);
    expect(node.content_md).toBe("");
    expect(node.content_md).not.toContain("```csv");
    expect(dataset.row_count).toBe(3);
    expect(dataset.columns).toEqual([
      { name: "company", type: "text", nullable: false },
      { name: "plan", type: "text", nullable: false },
      { name: "mrr", type: "number", nullable: true },
      { name: "active", type: "boolean", nullable: false },
      { name: "signed_at", type: "date", nullable: true },
    ]);
    expect(rowsOf(node.id)).toHaveLength(3);
  });

  it("stores values TYPED, so 90 is never greater than 500", async () => {
    const { node } = await createDataset(storage, { title: "Customers", csv: CSV });
    const values = rowsOf(node.id).map((row) => row.data);

    expect(typeof values[0]!.mrr).toBe("number");
    expect(values[0]!.mrr).toBe(500);
    expect(values[1]!.mrr).toBe(90);
    expect(typeof values[0]!.active).toBe("boolean");

    // This is the bug the typing exists to prevent, written down: as text, the
    // two-digit value sorts above the three-digit one.
    expect("90" > "500").toBe(true);
    const overFiveHundred = values.filter((row) => (row.mrr as number) >= 500);
    expect(overFiveHundred.map((row) => row.company)).toEqual(["Acme"]);
  });

  it("normalises a date's separator so text ordering is chronological", async () => {
    const { node } = await createDataset(storage, { title: "Customers", csv: CSV });
    const signed = rowsOf(node.id).map((row) => row.data.signed_at);
    expect(signed).toEqual(["2026-01-02", "2026-02-11T09:30", null]);
    // With a space, "2026-02-11 09:30" would sort BEFORE "2026-02-11T00:00".
    expect([...signed].filter(Boolean).sort()).toEqual(["2026-01-02", "2026-02-11T09:30"]);
  });

  it("writes a blank cell as null rather than an empty string", async () => {
    const { node } = await createDataset(storage, { title: "Customers", csv: CSV });
    expect(rowsOf(node.id)[2]!.data.mrr).toBeNull();
    expect(rowsOf(node.id)[2]!.data.signed_at).toBeNull();
  });

  it("takes rows directly, because an agent has rows and not a CSV", async () => {
    const { dataset, node } = await createDataset(storage, {
      title: "Churn by month",
      rows: [
        { month: "2026-01", churned: 3 },
        { month: "2026-02", churned: 5 },
      ],
    });
    expect(dataset.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["month:text", "churned:number"]);
    expect(rowsOf(node.id).map((r) => r.data.churned)).toEqual([3, 5]);
  });

  it("lets the caller override a type inference got wrong", async () => {
    const { dataset } = await createDataset(storage, {
      title: "Counts",
      rows: [{ retries: "0" }, { retries: "1" }],
      columns: [{ name: "retries", type: "number" }],
    });
    // "0"/"1" infer as booleans; a column of counts is not a column of flags.
    expect(dataset.columns[0]!.type).toBe("number");
  });

  it("refuses an override that names a column the data does not have", async () => {
    await expect(
      createDataset(storage, {
        title: "Counts",
        rows: [{ retries: 1 }],
        columns: [{ name: "retires", type: "number" }],
      }),
    ).rejects.toThrow(/not in the data/);
  });

  it("refuses csv and rows together rather than picking one", async () => {
    await expect(
      createDataset(storage, { title: "Both", csv: CSV, rows: [{ a: 1 }] }),
    ).rejects.toThrow(/not both/);
  });

  it("refuses a batch bigger than one write may carry", async () => {
    const rows = Array.from({ length: DATASET_MAX_ROWS_PER_WRITE + 1 }, (_, i) => ({ n: i }));
    await expect(createDataset(storage, { title: "Too big", rows })).rejects.toThrow(
      new RegExp(`at most ${DATASET_MAX_ROWS_PER_WRITE}`),
    );
  });
});

describe("append_rows", () => {
  async function customers() {
    const { node } = await createDataset(storage, { title: "Customers", csv: CSV });
    return node;
  }

  it("continues the row index from the highest one used, never from the count", async () => {
    const node = await customers();
    await appendRowsToDataset(storage, node.id, {
      rows: [{ company: "Umbrella", plan: "pro", mrr: 700, active: true, signed_at: "2026-03-01" }],
    });
    expect(rowsOf(node.id).map((r) => r.idx)).toEqual([0, 1, 2, 3]);
    expect((await readDatasetSchema(storage, node.id)).row_count).toBe(4);
  });

  it("refuses a row carrying a column the dataset does not have", async () => {
    const node = await customers();
    let error: unknown;
    try {
      await appendRowsToDataset(storage, node.id, { rows: [{ company: "Umbrella", seats: 12 }] });
    } catch (err) {
      error = err;
    }
    expect((error as DatasetError).code).toBe("unknown_column");
    expect((error as DatasetError).message).toContain("replace_rows");
    // Nothing was written: a refused write is a refused write.
    expect(rowsOf(node.id)).toHaveLength(3);
  });

  it("demotes a column to text when a later batch contradicts its type", async () => {
    const node = await customers();
    const result = await appendRowsToDataset(storage, node.id, {
      rows: [{ company: "Umbrella", plan: "pro", mrr: "N/A", active: true, signed_at: "2026-03-01" }],
    });
    const mrr = result.dataset.columns.find((c) => c.name === "mrr")!;
    expect(mrr.type).toBe("text");
  });

  it("leaves the type alone when a batch says nothing about that column", async () => {
    const node = await customers();
    const result = await appendRowsToDataset(storage, node.id, {
      rows: [{ company: "Umbrella", plan: "pro", mrr: "", active: true }],
    });
    expect(result.dataset.columns.find((c) => c.name === "mrr")!.type).toBe("number");
    expect(result.dataset.columns.find((c) => c.name === "signed_at")!.nullable).toBe(true);
  });

  it("refuses to push a dataset past the row ceiling, before inserting anything", async () => {
    const node = await customers();
    stored.set(node.id, [
      ...rowsOf(node.id),
      { idx: DATASET_MAX_ROWS - 1, data: { company: "Last" } },
    ]);
    await expect(
      appendRowsToDataset(storage, node.id, { rows: [{ company: "One too many" }] }),
    ).rejects.toThrow(/at most 200000 rows/);
  });

  it("refuses a dataset node that has no dataset yet", async () => {
    const empty = await storage.createNode({ title: "Empty", kind: "data", parent_id: null });
    await expect(appendRowsToDataset(storage, empty.id, { rows: [{ a: 1 }] })).rejects.toThrow(
      /no dataset yet/,
    );
  });

  it("refuses a node that is not a dataset", async () => {
    const doc = await storage.createNode({ title: "Runbook", kind: "doc", parent_id: null });
    let error: unknown;
    try {
      await appendRowsToDataset(storage, doc.id, { rows: [{ a: 1 }] });
    } catch (err) {
      error = err;
    }
    expect((error as DatasetError).code).toBe("wrong_kind");
  });
});

describe("replace_rows", () => {
  it("re-infers the schema and restarts the indexes", async () => {
    const { node } = await createDataset(storage, { title: "Customers", csv: CSV });
    const result = await replaceDatasetRows(storage, node.id, {
      rows: [
        { account: "Acme", seats: 12 },
        { account: "Globex", seats: 4 },
      ],
    });
    expect(result.dataset.columns.map((c) => c.name)).toEqual(["account", "seats"]);
    expect(result.dataset.row_count).toBe(2);
    expect(rowsOf(node.id).map((r) => r.idx)).toEqual([0, 1]);
  });
});

describe("sample", () => {
  it("returns rows in file order, capped", async () => {
    const { node } = await createDataset(storage, { title: "Customers", csv: CSV });
    const { rows, description } = await sampleDataset(storage, node.id, 2);
    expect(rows.map((row) => row.company)).toEqual(["Acme", "Globex, Inc"]);
    expect(description.columns).toHaveLength(5);
    expect(description.row_count).toBe(3);
  });
});

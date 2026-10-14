/**
 * Migrating the `data` nodes that already exist: the CSV block becomes rows,
 * the prose around it stays, and running it twice changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";
import { setPoolForTests } from "@/lib/queue/db";
import { extractCsvBlock, migrateDataNodes } from "./migrate";

const stored = new Map<string, Array<{ idx: number; data: Record<string, unknown> }>>();

async function runStatement(text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
  const nodeId = String(values[0]);
  const rows = stored.get(nodeId) ?? [];
  if (text.startsWith("insert into")) {
    stored.set(nodeId, [...rows, ...(JSON.parse(String(values[2])) as never[])]);
    return { rows: [] };
  }
  if (text.startsWith("delete from")) {
    stored.set(nodeId, []);
    return { rows: [] };
  }
  if (text.includes("count(*)::int as count")) {
    return { rows: [{ count: rows.length, max_idx: rows.length ? Math.max(...rows.map((r) => r.idx)) : null }] };
  }
  throw new Error(`unexpected statement: ${text}`);
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
  const slug = `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: "Migrate", slug });
  storage = resolveDemoStorage(slug)!;
});

afterEach(() => {
  setPoolForTests(null);
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const BODY =
  "Weekly beta signup funnel.\n\n```csv\nweek,signups\n2026-W01,42\n2026-W02,61\n```\n\nUpdated every Monday.";

describe("extractCsvBlock", () => {
  it("takes the table and leaves the prose around it", () => {
    const extracted = extractCsvBlock(BODY)!;
    expect(extracted.csv).toBe("week,signups\n2026-W01,42\n2026-W02,61");
    expect(extracted.remainder).toBe("Weekly beta signup funnel.\n\nUpdated every Monday.");
  });

  it("finds nothing in a body that has no fenced table", () => {
    expect(extractCsvBlock("Just a note about the data we do not have yet.")).toBeNull();
    expect(extractCsvBlock("```json\n{}\n```")).toBeNull();
    expect(extractCsvBlock("```csv\n\n```")).toBeNull();
    expect(extractCsvBlock(null)).toBeNull();
  });
});

describe("migrateDataNodes", () => {
  it("moves the block into rows, keeps the prose, and infers the schema", async () => {
    const node = await storage.createNode({
      title: "Beta signups (CSV)",
      kind: "data",
      parent_id: null,
      content_md: BODY,
    });

    const summary = await migrateDataNodes(storage);

    expect(summary).toMatchObject({ scanned: 1, migrated: 1, failed: 0 });
    const after = (await storage.getNode(node.id))!;
    expect(after.content_md).toBe("Weekly beta signup funnel.\n\nUpdated every Monday.");
    expect(after.content_md).not.toContain("```csv");
    const dataset = (after.data as { dataset: { columns: Array<{ name: string; type: string }>; row_count: number } }).dataset;
    expect(dataset.row_count).toBe(2);
    expect(dataset.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["week:text", "signups:number"]);
    expect(stored.get(node.id)!.map((r) => r.data.signups)).toEqual([42, 61]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await storage.createNode({ title: "Beta signups", kind: "data", parent_id: null, content_md: BODY });
    await migrateDataNodes(storage);
    const rowsAfterFirst = JSON.stringify([...stored.entries()]);

    const second = await migrateDataNodes(storage);

    expect(second).toMatchObject({ scanned: 1, migrated: 0, skipped: 1, failed: 0 });
    expect(second.results[0]!.outcome).toBe("already_migrated");
    expect(JSON.stringify([...stored.entries()])).toBe(rowsAfterFirst);
  });

  it("leaves a data node with no CSV block exactly as it is", async () => {
    const node = await storage.createNode({
      title: "Pricing experiments",
      kind: "data",
      parent_id: null,
      content_md: "Numbers to collect once the A/B test is live.",
    });

    const summary = await migrateDataNodes(storage);

    expect(summary.results[0]!.outcome).toBe("no_csv_block");
    const after = (await storage.getNode(node.id))!;
    expect(after.content_md).toBe("Numbers to collect once the A/B test is live.");
    expect((after.data as Record<string, unknown>).dataset).toBeUndefined();
  });

  it("never touches a node of another kind", async () => {
    await storage.createNode({
      title: "Runbook",
      kind: "doc",
      parent_id: null,
      content_md: BODY,
    });
    const summary = await migrateDataNodes(storage);
    expect(summary.scanned).toBe(0);
  });

  it("reports what it would do without writing, in a dry run", async () => {
    const node = await storage.createNode({ title: "Beta signups", kind: "data", parent_id: null, content_md: BODY });
    const summary = await migrateDataNodes(storage, { dryRun: true });
    expect(summary.migrated).toBe(1);
    expect(summary.results[0]!.rows).toBe(2);
    expect(stored.get(node.id)).toBeUndefined();
    expect((await storage.getNode(node.id))!.content_md).toContain("```csv");
  });
});

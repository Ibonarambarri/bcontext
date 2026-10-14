/**
 * Datasets over MCP: a `data` node created with its rows in one call, read
 * back as a SCHEMA and not as a table, sampled, and queried without the rows
 * ever passing through the node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { setPoolForTests } from "@/lib/queue/db";
import type { Storage } from "@/lib/storage";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));

import { buildMcpServer } from "./server";

/**
 * The rows, in memory. The SQL a query compiles to is tested against its text
 * in `src/lib/datasets/query.test.ts`; here what matters is that a query goes
 * to the row table at all and comes back as rows, so the fake answers the
 * shape of statement rather than executing it.
 */
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
  if (text.startsWith("select data from")) {
    return { rows: rows.slice(0, Number(values[2])).map((r) => ({ data: r.data })) };
  }
  if (text.startsWith("select jsonb_build_object")) {
    // Only the projection is simulated — the predicates are not evaluated
    // here; that the WHERE is built correctly is asserted against the SQL
    // text in `src/lib/datasets/query.test.ts`. The projected columns are
    // read out of the `jsonb_build_object($k, d.data -> $v)` pairs so the
    // order the caller asked for survives.
    const columns = [...text.matchAll(/\$(\d+), d\.data -> \$\d+/g)].map(
      (match) => String(values[Number(match[1]) - 1]),
    );
    return {
      rows: rows.map((r) => ({
        row: Object.fromEntries(columns.map((name) => [name, r.data[name] ?? null])),
      })),
    };
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

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}
function body<T = Record<string, unknown>>(result: ToolResult): T {
  return JSON.parse(text(result)) as T;
}

const CSV = [
  "company,plan,mrr,active",
  "Acme,pro,500,true",
  '"Globex, Inc",free,90,false',
].join("\n");

describe("datasets over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeEach(async () => {
    stored.clear();
    process.env.DATABASE_URL = "postgres://fake/test";
    setPoolForTests(fakePool as never);
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-data-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Datasets", slug });
    storage = resolveDemoStorage(slug)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write"], tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "a" }, verbs: ["read", "write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  });

  afterEach(async () => {
    await close();
    setPoolForTests(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  async function createDataset(args: Record<string, unknown> = {}) {
    const res = await client.callTool({
      name: "data_write",
      arguments: {
        op: "create",
        title: "Customers",
        description: "Every paying account and what it pays.",
        csv: CSV,
        ...args,
      },
    });
    expect(res.isError).toBeFalsy();
    return body<{ id: string; rows_written: number; dataset: { columns: Array<{ name: string; type: string }>; row_count: number } }>(res);
  }

  it("creates the node and its rows in one call, with the table nowhere in the body", async () => {
    const created = await createDataset();
    expect(created.rows_written).toBe(2);
    expect(created.dataset.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      "company:text", "plan:text", "mrr:number", "active:boolean",
    ]);
    expect(stored.get(created.id)).toHaveLength(2);

    const got = body<{ node: { content_md: string; data: Record<string, unknown> }; dataset: { columns: unknown[]; row_count: number } }>(
      await client.callTool({ name: "nodes", arguments: { op: "get", id: created.id } }),
    );
    expect(got.node.content_md).not.toContain("```csv");
    expect(JSON.stringify(got)).not.toContain("Globex");
  });

  it("answers nodes(op=get) with the schema and never with the rows", async () => {
    const created = await createDataset();
    const got = body<{ node: { data: Record<string, unknown> }; dataset: { columns: Array<{ name: string }>; row_count: number } }>(
      await client.callTool({ name: "nodes", arguments: { op: "get", id: created.id } }),
    );
    expect(got.dataset.row_count).toBe(2);
    expect(got.dataset.columns.map((c) => c.name)).toEqual(["company", "plan", "mrr", "active"]);
    // The schema is returned once, at the top level — not again inside `data`.
    expect(got.node.data.dataset).toBeUndefined();
  });

  it("returns the shape on op=schema", async () => {
    const created = await createDataset();
    const schema = body<{ columns: unknown[]; row_count: number; description: string; source_file: unknown }>(
      await client.callTool({ name: "data", arguments: { op: "schema", node_id: created.id } }),
    );
    expect(schema.row_count).toBe(2);
    expect(schema.description).toBe("Every paying account and what it pays.");
    expect(schema.source_file).toBeNull();
  });

  it("returns real rows on op=sample, because five rows are what tell you what a column means", async () => {
    const created = await createDataset();
    const sample = body<{ rows: Array<Record<string, unknown>> }>(
      await client.callTool({ name: "data", arguments: { op: "sample", node_id: created.id, limit: 1 } }),
    );
    expect(sample.rows).toHaveLength(1);
    expect(sample.rows[0]).toMatchObject({ company: "Acme", plan: "pro", mrr: 500, active: true });
  });

  it("takes rows straight from an agent, with no CSV to fabricate", async () => {
    const created = await client.callTool({
      name: "data_write",
      arguments: {
        op: "create",
        title: "Churn by month",
        rows: [{ month: "2026-01", churned: 3 }, { month: "2026-02", churned: 5 }],
      },
    });
    expect(created.isError).toBeFalsy();
    const created2 = body<{ id: string; dataset: { columns: Array<{ name: string; type: string }> } }>(created);
    expect(created2.dataset.columns.map((c) => c.type)).toEqual(["text", "number"]);
  });

  it("appends rows without re-sending the dataset", async () => {
    const created = await createDataset();
    const appended = body<{ rows_written: number; dataset: { row_count: number } }>(
      await client.callTool({
        name: "data_write",
        arguments: {
          op: "append_rows",
          node_id: created.id,
          rows: [{ company: "Initech", plan: "enterprise", mrr: 2400, active: true }],
        },
      }),
    );
    expect(appended.rows_written).toBe(1);
    expect(appended.dataset.row_count).toBe(3);
  });

  it("refuses a column the dataset does not have, and says which op changes the shape", async () => {
    const created = await createDataset();
    const res = await client.callTool({
      name: "data_write",
      arguments: { op: "append_rows", node_id: created.id, rows: [{ company: "Initech", seats: 12 }] },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toContain("replace_rows");
  });

  it("replaces the whole table and re-infers the schema", async () => {
    const created = await createDataset();
    const replaced = body<{ dataset: { columns: Array<{ name: string }>; row_count: number } }>(
      await client.callTool({
        name: "data_write",
        arguments: { op: "replace_rows", node_id: created.id, rows: [{ account: "Acme", seats: 12 }] },
      }),
    );
    expect(replaced.dataset.columns.map((c) => c.name)).toEqual(["account", "seats"]);
    expect(replaced.dataset.row_count).toBe(1);
  });

  it("queries by the DSL and returns only the columns asked for", async () => {
    const created = await createDataset();
    const result = body<{ rows: Array<Record<string, unknown>>; limit: number }>(
      await client.callTool({
        name: "data",
        arguments: {
          op: "query",
          node_id: created.id,
          query: { select: ["company", "mrr"], where: [{ column: "mrr", op: "gt", value: 100 }] },
        },
      }),
    );
    expect(Object.keys(result.rows[0]!)).toEqual(["company", "mrr"]);
    expect(result.limit).toBe(100);
  });

  it("rejects a column the schema does not have instead of answering nothing", async () => {
    const created = await createDataset();
    const res = await client.callTool({
      name: "data",
      arguments: { op: "query", node_id: created.id, query: { where: [{ column: "mrr_usd", op: "gt", value: 1 }] } },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toContain("no such column: mrr_usd");
    expect(text(res)).toContain("mrr (number)");
  });

  it("refuses to treat a node of another kind as a dataset", async () => {
    const doc = await storage.createNode({ title: "Runbook", kind: "doc", parent_id: null });
    const res = await client.callTool({ name: "data", arguments: { op: "schema", node_id: doc.id } });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toContain("not a dataset");
  });

  it("has no delete_rows: taking rows out is a replace", async () => {
    const created = await createDataset();
    const res = await client.callTool({
      name: "data_write",
      arguments: { op: "delete_rows", node_id: created.id },
    });
    expect(res.isError).toBeTruthy();
  });

  it("advertises both tools to a principal that may read and write", async () => {
    // Which verbs each tool needs, and that a reader never sees the write
    // half, is the subject of `surface.test.ts`.
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("data");
    expect(tools).toContain("data_write");
  });
});

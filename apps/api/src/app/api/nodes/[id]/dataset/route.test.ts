/**
 * The dataset routes: the same three ops as MCP, over HTTP, with a GET that
 * answers with the schema and not the table.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { setPoolForTests } from "@/lib/queue/db";
import { GET, POST } from "./route";
import { POST as QUERY } from "./query/route";
import { POST as CREATE } from "../../../datasets/route";

const headers = { origin: "http://localhost", host: "localhost", "Content-Type": "application/json" };
const get = (path: string) => new Request(`http://localhost${path}`, { headers });
const post = (path: string, payload: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

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
    const columns = [...text.matchAll(/\$(\d+), d\.data -> \$\d+/g)].map(
      (match) => String(values[Number(match[1]) - 1]),
    );
    return { rows: rows.map((r) => ({ row: Object.fromEntries(columns.map((c) => [c, r.data[c] ?? null])) })) };
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

const CSV = "company,plan,mrr\nAcme,pro,500\nGlobex,free,90\n";
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeEach(() => {
  stored.clear();
  process.env.DATABASE_URL = "postgres://fake/test";
  setPoolForTests(fakePool as never);
});

afterEach(() => {
  setPoolForTests(null);
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

async function seed() {
  const workspace = createWorkspace({
    name: "Datasets REST",
    slug: `datasets-rest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  const storage = resolveDemoStorage(workspace.slug)!;
  const response = await CREATE(
    post("/api/datasets", {
      workspace: workspace.slug,
      title: "Customers",
      description: "Every paying account and what it pays.",
      csv: CSV,
    }),
  );
  expect(response.status).toBe(201);
  const created = (await response.json()) as { node: { id: string }; rows_written: number };
  return { workspace, storage, nodeId: created.node.id, created };
}

describe("POST /api/datasets", () => {
  it("creates the node and its rows in one call", async () => {
    const { created, nodeId } = await seed();
    expect(created.rows_written).toBe(2);
    expect(stored.get(nodeId)).toHaveLength(2);
    expect(stored.get(nodeId)![0]!.data.mrr).toBe(500);
  });

  it("rejects a body it does not understand", async () => {
    const workspace = createWorkspace({ name: "X", slug: `x-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    const response = await CREATE(post("/api/datasets", { workspace: workspace.slug, title: "No rows" }));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/nodes/:id/dataset", () => {
  it("answers with the schema, not the table", async () => {
    const { workspace, nodeId } = await seed();
    const response = await GET(get(`/api/nodes/${nodeId}/dataset?workspace=${workspace.slug}`), params(nodeId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { columns: Array<{ name: string; type: string }>; row_count: number; rows?: unknown };
    expect(body.row_count).toBe(2);
    expect(body.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["company:text", "plan:text", "mrr:number"]);
    expect(body.rows).toBeUndefined();
  });

  it("returns rows only when `sample` asks for them", async () => {
    const { workspace, nodeId } = await seed();
    const response = await GET(get(`/api/nodes/${nodeId}/dataset?workspace=${workspace.slug}&sample=1`), params(nodeId));
    const body = (await response.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ company: "Acme", mrr: 500 });
  });

  it("404s a node that is not a dataset at all", async () => {
    const { workspace, storage } = await seed();
    const doc = await storage.createNode({ title: "Runbook", kind: "doc", parent_id: null });
    const response = await GET(get(`/api/nodes/${doc.id}/dataset?workspace=${workspace.slug}`), params(doc.id));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "wrong_kind" });
  });
});

describe("POST /api/nodes/:id/dataset", () => {
  it("appends rows and reports the new count", async () => {
    const { workspace, nodeId } = await seed();
    const response = await POST(
      post(`/api/nodes/${nodeId}/dataset`, {
        workspace: workspace.slug,
        op: "append_rows",
        rows: [{ company: "Initech", plan: "enterprise", mrr: 2400 }],
      }),
      params(nodeId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows_written: number; dataset: { row_count: number } };
    expect(body).toMatchObject({ rows_written: 1, dataset: { row_count: 3 } });
  });

  it("refuses a column the dataset does not have", async () => {
    const { workspace, nodeId } = await seed();
    const response = await POST(
      post(`/api/nodes/${nodeId}/dataset`, {
        workspace: workspace.slug,
        op: "append_rows",
        rows: [{ company: "Initech", seats: 4 }],
      }),
      params(nodeId),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "unknown_column" });
  });

  it("409s on a stale if_updated_at instead of clobbering", async () => {
    const { workspace, storage, nodeId } = await seed();
    const stale = (await storage.getNode(nodeId))!.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await POST(
      post(`/api/nodes/${nodeId}/dataset`, { workspace: workspace.slug, op: "append_rows", rows: [{ company: "A" }] }),
      params(nodeId),
    );
    const response = await POST(
      post(`/api/nodes/${nodeId}/dataset`, {
        workspace: workspace.slug,
        op: "append_rows",
        rows: [{ company: "B" }],
        if_updated_at: stale,
      }),
      params(nodeId),
    );
    expect(response.status).toBe(409);
  });

  it("has no delete_rows op", async () => {
    const { workspace, nodeId } = await seed();
    const response = await POST(
      post(`/api/nodes/${nodeId}/dataset`, { workspace: workspace.slug, op: "delete_rows" }),
      params(nodeId),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/nodes/:id/dataset/query", () => {
  it("returns the projected rows", async () => {
    const { workspace, nodeId } = await seed();
    const response = await QUERY(
      post(`/api/nodes/${nodeId}/dataset/query`, {
        workspace: workspace.slug,
        query: { select: ["company", "mrr"], where: [{ column: "mrr", op: "gte", value: 100 }] },
      }),
      params(nodeId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<Record<string, unknown>>; limit: number };
    expect(Object.keys(body.rows[0]!)).toEqual(["company", "mrr"]);
    expect(body.limit).toBe(100);
  });

  it("400s a column the schema does not have, naming the ones it does", async () => {
    const { workspace, nodeId } = await seed();
    const response = await QUERY(
      post(`/api/nodes/${nodeId}/dataset/query`, {
        workspace: workspace.slug,
        query: { where: [{ column: "revenue", op: "gt", value: 1 }] },
      }),
      params(nodeId),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_column");
    expect(body.message).toContain("mrr (number)");
  });
});

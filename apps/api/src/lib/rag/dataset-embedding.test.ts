/**
 * The two halves of the dataset embedding rule: a `data` node HAS to be
 * findable by semantics, and must never put a row in the index.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const embedMany = vi.fn();
vi.mock("ai", () => ({ embedMany: (args: unknown) => embedMany(args) }));
vi.mock("@/lib/rag", () => ({ resolveEmbeddingModel: () => "test-model" }));
vi.mock("./contextualize", () => ({
  // Pass chunks through unchanged: what is under test is which text reaches
  // the embedder, not how it is prefixed.
  contextualizeChunks: async (_doc: unknown, chunks: Array<Record<string, unknown>>) =>
    chunks.map((chunk) => ({ ...chunk, context_prefix: "", embedding_input: chunk.content })),
  combinePrefix: (prefix: string, content: string) => (prefix ? `${prefix}\n\n${content}` : content),
  contextualRetrievalEnabled: () => false,
  resolveContextModel: () => "test-context-model",
}));
vi.mock("@/lib/telemetry/ai-usage", () => ({ recordAiUsageEvent: () => {} }));

const { embedNode, embeddingSourceFor } = await import("./embed");

const DATASET_NODE = {
  id: "data-1",
  workspace_id: "ws-1",
  title: "Customers",
  // A body that still carries the table, as an unmigrated node would.
  content_md: "Exported from Stripe.\n\n```csv\ncompany,email,mrr\nAcme,ana@acme.com,500\n```\n",
  kind: "data",
  data: {
    description: "Every paying account and what it pays.",
    dataset: {
      schema_version: 1,
      columns: [
        { name: "company", type: "text", nullable: false },
        { name: "email", type: "text", nullable: false },
        { name: "mrr", type: "number", nullable: false },
      ],
      row_count: 3000,
      source_file: null,
      updated_at: "2026-09-10T00:00:00.000Z",
    },
  },
};

function fakeSupabase(node: Record<string, unknown>) {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from: (table: string) => {
      if (table === "nodes") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: node, error: null }) }) }) };
      }
      return {
        // No prior rows: nothing to reuse, every chunk is fresh.
        select: () => ({ eq: async () => ({ data: [], error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
        insert: async (rows: Array<Record<string, unknown>>) => {
          inserted.push(...rows);
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserted };
}

const ORIGINAL_KEY = process.env.AI_GATEWAY_API_KEY;

beforeEach(() => {
  process.env.AI_GATEWAY_API_KEY = "test-key";
  embedMany.mockReset();
  embedMany.mockImplementation(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => [0.1, 0.2]),
    usage: { tokens: 1 },
  }));
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = ORIGINAL_KEY;
});

describe("embeddingSourceFor", () => {
  it("gives a dataset its schema — title, description, columns and types", () => {
    const source = embeddingSourceFor(DATASET_NODE);
    expect(source).toContain("Customers");
    expect(source).toContain("Every paying account and what it pays.");
    expect(source).toContain("company (text), email (text), mrr (number)");
    expect(source).toContain("3000 rows");
  });

  it("gives a dataset none of its rows, not even the ones left in the body", () => {
    const source = embeddingSourceFor(DATASET_NODE);
    expect(source).not.toContain("ana@acme.com");
    expect(source).not.toContain("```csv");
    expect(source).not.toContain("Acme");
  });

  it("leaves every other kind on its body", () => {
    const source = embeddingSourceFor({ title: "Runbook", content_md: "Restart the worker.", kind: "doc" });
    expect(source).toBe("# Runbook\n\nRestart the worker.");
  });
});

describe("embedNode on a data node", () => {
  it("indexes it — a dataset nobody can find is a dataset nobody uses", async () => {
    const { client, inserted } = fakeSupabase(DATASET_NODE);
    const result = await embedNode(client, "data-1");

    expect(result.status).toBe("embedded");
    expect(result.chunks).toBeGreaterThan(0);
    // Unlike a credential, which is skipped outright.
    expect(result.reason).toBeUndefined();
    const indexed = inserted.map((row) => String(row.content)).join("\n");
    expect(indexed).toContain("Customers");
    expect(indexed).toContain("mrr (number)");
  });

  it("sends no row value to the embedder or to the index", async () => {
    const { client, inserted } = fakeSupabase(DATASET_NODE);
    await embedNode(client, "data-1");

    const embedded = embedMany.mock.calls.map((call) => (call[0] as { values: string[] }).values.join("\n")).join("\n");
    expect(embedded).not.toContain("ana@acme.com");
    expect(embedded).not.toContain("```csv");
    const indexed = inserted.map((row) => String(row.content)).join("\n");
    expect(indexed).not.toContain("ana@acme.com");
  });
});

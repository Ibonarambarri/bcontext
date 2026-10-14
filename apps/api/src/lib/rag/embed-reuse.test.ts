/**
 * Re-embedding a node after a small edit must pay only for the chunks whose
 * text changed: the others keep their stored prefix and vector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const embedMany = vi.fn();
const contextualized: string[] = [];
vi.mock("ai", () => ({ embedMany: (args: unknown) => embedMany(args) }));
vi.mock("@/lib/rag", () => ({ resolveEmbeddingModel: () => "test-model" }));
vi.mock("./contextualize", async () => {
  const real = await vi.importActual<typeof import("./contextualize")>("./contextualize");
  return {
    ...real,
    resolveContextModel: () => "test-context-model",
    contextualizeChunks: async (
      _doc: unknown,
      chunks: Array<{ content: string }>,
      opts?: { enabled?: boolean },
    ) => {
      if (!(opts?.enabled ?? real.contextualRetrievalEnabled())) {
        return chunks.map((chunk) => ({ ...chunk, context_prefix: "", embedding_input: chunk.content }));
      }
      contextualized.push(...chunks.map((c) => c.content));
      return chunks.map((chunk) => ({
        ...chunk,
        context_prefix: `fresh prefix for ${chunk.content.slice(0, 12)}`,
        embedding_input: `fresh prefix\n\n${chunk.content}`,
      }));
    },
  };
});
const recorded: Array<Record<string, unknown>> = [];
vi.mock("@/lib/telemetry/ai-usage", () => ({
  recordAiUsageEvent: (e: Record<string, unknown>) => {
    recorded.push(e);
  },
}));

const { embedNode } = await import("./embed");

const BODY_V1 = "## Goal\n\nShip the worker on pg-boss so the crons leave the host scheduler.\n\n## Result\n\nDone on 2026-09-08.";
const BODY_V2 = "## Goal\n\nShip the worker on pg-boss so the crons leave the host scheduler.\n\n## Result\n\nDone on 2026-09-08. The three scheduled tasks still need deleting.";

function fakeSupabase(node: Record<string, unknown>, prior: Array<Record<string, unknown>>) {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from: (table: string) => {
      if (table === "nodes") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: node, error: null }) }) }) };
      }
      return {
        select: () => ({ eq: async () => ({ data: prior, error: null }) }),
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

const node = (content_md: string) => ({ id: "task-1", workspace_id: "ws-1", title: "Worker on pg-boss", content_md, kind: "task", data: null });

const ORIGINAL_KEY = process.env.AI_GATEWAY_API_KEY;
const ORIGINAL_CR = process.env.CONTEXTUAL_RETRIEVAL;
beforeEach(() => {
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.CONTEXTUAL_RETRIEVAL = "1";
  contextualized.length = 0;
  recorded.length = 0;
  embedMany.mockReset();
  embedMany.mockImplementation(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((_, i) => [0.5, i]),
    usage: { tokens: values.length },
  }));
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_CR === undefined) delete process.env.CONTEXTUAL_RETRIEVAL;
  else process.env.CONTEXTUAL_RETRIEVAL = ORIGINAL_CR;
});

describe("embedNode reuse of unchanged chunks", () => {
  it("first embed of a node pays for every chunk", async () => {
    const { client, inserted } = fakeSupabase(node(BODY_V1), []);
    const result = await embedNode(client, "task-1");
    expect(result.status).toBe("embedded");
    expect(contextualized.length).toBe(inserted.length);
    expect(embedMany).toHaveBeenCalledTimes(1);
  });

  it("after editing one block, only that block's chunk is regenerated and embedded", async () => {
    // Rows a previous embed left behind, same embedding model, prefixes set.
    const first = fakeSupabase(node(BODY_V1), []);
    await embedNode(first.client, "task-1");
    const prior = first.inserted.map((r) => ({
      content: r.content,
      context_prefix: r.context_prefix,
      embedding: "[0.5,0]",
      embedding_version: "test-model",
    }));
    contextualized.length = 0;
    embedMany.mockClear();
    recorded.length = 0;

    const { client, inserted } = fakeSupabase(node(BODY_V2), prior);
    const result = await embedNode(client, "task-1");

    expect(result.status).toBe("embedded");
    // Only the changed `## Result` chunk went to the model and the embedder.
    expect(contextualized).toHaveLength(1);
    expect(contextualized[0]).toContain("still need deleting");
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0]![0].values).toHaveLength(1);
    // Every row was rewritten, unchanged ones with their stored prefix and vector.
    expect(inserted).toHaveLength(prior.length);
    const goal = inserted.find((r) => String(r.content).includes("Ship the worker"))!;
    expect(goal.context_prefix).toBe(prior.find((p) => p.content === goal.content)!.context_prefix);
    expect(goal.embedding).toBe("[0.5,0]");
    const changed = inserted.find((r) => String(r.content).includes("still need deleting"))!;
    expect(changed.context_prefix).toMatch(/^fresh prefix/);
    expect(changed.embedding).toEqual([0.5, 0]);
    // Telemetry says how much was reused.
    const ctx = recorded.find((e) => e.surface === "contextualize");
    expect(ctx).toBeUndefined(); // the mocked contextualizer reports no usage
    const emb = recorded.find((e) => e.surface === "embed")!;
    expect(emb.metadata).toMatchObject({ chunks: prior.length, reused: prior.length - 1 });
  });

  it("does not reuse rows from another embedding model or rows that never got a prefix", async () => {
    const first = fakeSupabase(node(BODY_V1), []);
    await embedNode(first.client, "task-1");
    const prior = first.inserted.map((r, i) => ({
      content: r.content,
      // One row from an outage (empty prefix), the rest from an older model.
      context_prefix: i === 0 ? "" : r.context_prefix,
      embedding: "[0.1,0.1]",
      embedding_version: i === 0 ? "test-model" : "old-model",
    }));
    contextualized.length = 0;
    embedMany.mockClear();

    const { client, inserted } = fakeSupabase(node(BODY_V1), prior);
    await embedNode(client, "task-1");
    expect(contextualized).toHaveLength(inserted.length);
    expect(embedMany.mock.calls[0]![0].values).toHaveLength(inserted.length);
  });

  it("with contextual retrieval off (the default) no prefix is generated and prefix-less rows are reused", async () => {
    delete process.env.CONTEXTUAL_RETRIEVAL;
    const first = fakeSupabase(node(BODY_V1), []);
    await embedNode(first.client, "task-1");
    expect(contextualized).toHaveLength(0);
    expect(first.inserted.every((r) => r.context_prefix === "")).toBe(true);

    const prior = first.inserted.map((r) => ({
      content: r.content,
      context_prefix: "",
      embedding: "[0.2,0.2]",
      embedding_version: "test-model",
    }));
    embedMany.mockClear();
    const { client, inserted } = fakeSupabase(node(BODY_V2), prior);
    await embedNode(client, "task-1");
    expect(contextualized).toHaveLength(0);
    expect(embedMany.mock.calls[0]![0].values).toHaveLength(1);
    expect(inserted.filter((r) => r.embedding === "[0.2,0.2]")).toHaveLength(prior.length - 1);
  });
});

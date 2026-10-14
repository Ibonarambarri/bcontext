import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RagHit } from "@/lib/rag";

// Mock the AI SDK's rerank so unit tests never touch the network.
// Reassign per test via `mockRerank.mockImplementationOnce(...)`.
const mockRerank = vi.fn();
vi.mock("ai", () => ({
  rerank: (args: Parameters<typeof mockRerank>[0]) => mockRerank(args),
}));

import {
  applyRerankRanking,
  hitToRerankDoc,
  RERANK_DOC_CHAR_BUDGET,
  rerankHits,
  resolveRerankModel,
  DEFAULT_RERANK_MODEL,
} from "./rerank";

const hit = (
  id: string,
  similarity = 0.5,
  overrides: Partial<RagHit> = {},
): RagHit => ({
  node_id: id,
  title: `Node ${id}`,
  kind: "doc",
  content: `Body of ${id}`,
  similarity,
  chunk_index: 0,
  block_id: null,
  ...overrides,
});

describe("resolveRerankModel", () => {
  const origEnv = process.env.RERANK_MODEL;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.RERANK_MODEL;
    else process.env.RERANK_MODEL = origEnv;
  });

  it("returns env override when set", () => {
    process.env.RERANK_MODEL = "cohere/rerank-v4-fast";
    expect(resolveRerankModel()).toBe("cohere/rerank-v4-fast");
  });

  it("falls back to opts override when env is unset", () => {
    delete process.env.RERANK_MODEL;
    expect(resolveRerankModel("voyage/rerank-2.5")).toBe("voyage/rerank-2.5");
  });

  it("uses sentinel default when nothing is configured", () => {
    delete process.env.RERANK_MODEL;
    expect(resolveRerankModel()).toBe(DEFAULT_RERANK_MODEL);
    expect(resolveRerankModel("")).toBe(DEFAULT_RERANK_MODEL);
    expect(resolveRerankModel("   ")).toBe(DEFAULT_RERANK_MODEL);
  });

  it("env wins over opts override", () => {
    process.env.RERANK_MODEL = "voyage/rerank-2.5-lite";
    expect(resolveRerankModel("cohere/rerank-v3.5")).toBe(
      "voyage/rerank-2.5-lite",
    );
  });
});

describe("hitToRerankDoc", () => {
  it("prefixes title before body", () => {
    expect(hitToRerankDoc(hit("a"))).toBe("Node a\n\nBody of a");
  });

  it("returns body alone when title is empty", () => {
    expect(hitToRerankDoc(hit("a", 1, { title: "" }))).toBe("Body of a");
  });

  it("clamps to the per-doc char budget", () => {
    const huge = "x".repeat(RERANK_DOC_CHAR_BUDGET * 2);
    const out = hitToRerankDoc(hit("a", 1, { title: "T", content: huge }));
    expect(out.length).toBe(RERANK_DOC_CHAR_BUDGET);
  });
});

describe("applyRerankRanking", () => {
  it("reorders by score and rewrites similarity", () => {
    const hits = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)];
    const ranked = applyRerankRanking(hits, [
      { originalIndex: 2, score: 0.95 },
      { originalIndex: 0, score: 0.5 },
      { originalIndex: 1, score: 0.1 },
    ]);
    expect(ranked.map((h) => h.node_id)).toEqual(["c", "a", "b"]);
    expect(ranked.map((h) => h.similarity)).toEqual([0.95, 0.5, 0.1]);
  });

  it("clamps rerank scores into [0,1]", () => {
    const hits = [hit("a"), hit("b")];
    const ranked = applyRerankRanking(hits, [
      { originalIndex: 0, score: 1.5 },
      { originalIndex: 1, score: -0.2 },
    ]);
    expect(ranked.map((h) => h.similarity)).toEqual([1, 0]);
  });

  it("appends unreranked tail in original order with original similarity", () => {
    const hits = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)];
    const ranked = applyRerankRanking(hits, [
      { originalIndex: 2, score: 0.99 },
    ]);
    expect(ranked.map((h) => h.node_id)).toEqual(["c", "a", "b"]);
    expect(ranked.map((h) => h.similarity)).toEqual([0.99, 0.9, 0.8]);
  });

  it("slices to topK when provided", () => {
    const hits = [hit("a"), hit("b"), hit("c"), hit("d")];
    const ranked = applyRerankRanking(
      hits,
      [
        { originalIndex: 3, score: 0.9 },
        { originalIndex: 0, score: 0.8 },
      ],
      2,
    );
    expect(ranked.map((h) => h.node_id)).toEqual(["d", "a"]);
  });

  it("ignores out-of-range and duplicate indices", () => {
    const hits = [hit("a"), hit("b")];
    const ranked = applyRerankRanking(hits, [
      { originalIndex: 0, score: 0.9 },
      { originalIndex: 0, score: 0.5 },
      { originalIndex: 99, score: 0.4 },
      { originalIndex: -1, score: 0.3 },
    ]);
    expect(ranked.map((h) => h.node_id)).toEqual(["a", "b"]);
    expect(ranked.map((h) => h.similarity)).toEqual([0.9, 0.5]);
  });

  it("returns [] when given no hits", () => {
    expect(applyRerankRanking([], [{ originalIndex: 0, score: 1 }])).toEqual([]);
  });
});

describe("rerankHits", () => {
  const origKey = process.env.AI_GATEWAY_API_KEY;
  const origModel = process.env.RERANK_MODEL;

  beforeEach(() => {
    mockRerank.mockReset();
    process.env.AI_GATEWAY_API_KEY = "test-key";
    delete process.env.RERANK_MODEL;
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = origKey;
    if (origModel === undefined) delete process.env.RERANK_MODEL;
    else process.env.RERANK_MODEL = origModel;
  });

  it("returns input unchanged when disabled", async () => {
    const hits = [hit("a"), hit("b"), hit("c")];
    const out = await rerankHits("q", hits, { enabled: false });
    expect(out).toEqual(hits);
    expect(mockRerank).not.toHaveBeenCalled();
  });

  it("skips when query is empty", async () => {
    const hits = [hit("a"), hit("b"), hit("c")];
    const out = await rerankHits("   ", hits);
    expect(out).toEqual(hits);
    expect(mockRerank).not.toHaveBeenCalled();
  });

  it("skips when fewer than the minimum candidates", async () => {
    const hits = [hit("a"), hit("b")];
    const out = await rerankHits("q", hits);
    expect(out).toEqual(hits);
    expect(mockRerank).not.toHaveBeenCalled();
  });

  it("skips when AI_GATEWAY_API_KEY is unset", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    const hits = [hit("a"), hit("b"), hit("c")];
    const out = await rerankHits("q", hits);
    expect(out).toEqual(hits);
    expect(mockRerank).not.toHaveBeenCalled();
  });

  it("calls the AI SDK rerank and reorders by score", async () => {
    const hits = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)];
    mockRerank.mockResolvedValueOnce({
      ranking: [
        { originalIndex: 2, score: 0.95, document: "..." },
        { originalIndex: 0, score: 0.6, document: "..." },
        { originalIndex: 1, score: 0.2, document: "..." },
      ],
      rerankedDocuments: [],
      originalDocuments: [],
      response: { timestamp: new Date(), modelId: DEFAULT_RERANK_MODEL },
    });
    const out = await rerankHits("q", hits);
    expect(mockRerank).toHaveBeenCalledTimes(1);
    expect(out.map((h) => h.node_id)).toEqual(["c", "a", "b"]);
    expect(out.map((h) => h.similarity)).toEqual([0.95, 0.6, 0.2]);
  });

  it("forwards topK to the provider and slices the result", async () => {
    const hits = [hit("a"), hit("b"), hit("c"), hit("d")];
    mockRerank.mockResolvedValueOnce({
      ranking: [
        { originalIndex: 3, score: 0.9, document: "..." },
        { originalIndex: 0, score: 0.7, document: "..." },
      ],
      rerankedDocuments: [],
      originalDocuments: [],
      response: { timestamp: new Date(), modelId: DEFAULT_RERANK_MODEL },
    });
    const out = await rerankHits("q", hits, { topK: 2 });
    const firstCallArgs = mockRerank.mock.calls[0]?.[0];
    expect(firstCallArgs?.topN).toBe(2);
    expect(out.map((h) => h.node_id)).toEqual(["d", "a"]);
  });

  it("falls back to original order on provider error", async () => {
    const hits = [hit("a"), hit("b"), hit("c")];
    mockRerank.mockRejectedValueOnce(new Error("gateway 500"));
    const out = await rerankHits("q", hits, { topK: 2 });
    expect(out.map((h) => h.node_id)).toEqual(["a", "b"]);
  });

  it("uses the model id from env when set", async () => {
    process.env.RERANK_MODEL = "voyage/rerank-2.5";
    const hits = [hit("a"), hit("b"), hit("c")];
    mockRerank.mockResolvedValueOnce({
      ranking: [{ originalIndex: 0, score: 0.5, document: "..." }],
      rerankedDocuments: [],
      originalDocuments: [],
      response: { timestamp: new Date(), modelId: "voyage/rerank-2.5" },
    });
    await rerankHits("q", hits);
    const firstCallArgs = mockRerank.mock.calls[0]?.[0];
    expect(firstCallArgs?.model).toBe("voyage/rerank-2.5");
  });

  it("sends docs derived via hitToRerankDoc", async () => {
    const hits = [hit("a"), hit("b"), hit("c")];
    mockRerank.mockResolvedValueOnce({
      ranking: [],
      rerankedDocuments: [],
      originalDocuments: [],
      response: { timestamp: new Date(), modelId: DEFAULT_RERANK_MODEL },
    });
    await rerankHits("q", hits);
    const firstCallArgs = mockRerank.mock.calls[0]?.[0];
    expect(firstCallArgs?.documents).toEqual(hits.map(hitToRerankDoc));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const inserted: Record<string, unknown>[] = [];
let upsertError: { message: string } | null = null;

function makeAdmin() {
  return {
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>) => {
        if (table !== "ai_usage_events") throw new Error(`unexpected table ${table}`);
        if (upsertError) return { error: upsertError };
        inserted.push(row);
        return { error: null };
      },
    }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => makeAdmin(),
}));

import { gatewayCostUsd, recordAiUsageEvent, tokensFromUsage } from "./ai-usage";

describe("gatewayCostUsd", () => {
  it("reads the gateway's reported cost, which arrives as a string", () => {
    expect(gatewayCostUsd({ gateway: { cost: "0.00123", generationId: "gen_1" } })).toBe(0.00123);
  });

  it("is null when the call did not go through the gateway", () => {
    expect(gatewayCostUsd(undefined)).toBeNull();
    expect(gatewayCostUsd({ anthropic: { cacheReadInputTokens: 10 } })).toBeNull();
    expect(gatewayCostUsd({ gateway: { cost: "" } })).toBeNull();
  });
});

describe("tokensFromUsage", () => {
  it("returns empty tokens for undefined usage", () => {
    expect(tokensFromUsage(undefined)).toEqual({});
  });

  it("prefers inputTokenDetails.cacheReadTokens over the deprecated cachedInputTokens", () => {
    expect(
      tokensFromUsage({
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 30 },
        cachedInputTokens: 999,
      }),
    ).toEqual({ input: 100, output: 20, cached: 30, cacheWrite: 0 });
  });

  it("carries the cache writes, which Anthropic bills above the base rate", () => {
    expect(
      tokensFromUsage({
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 50 },
      }),
    ).toEqual({ input: 100, output: 20, cached: 30, cacheWrite: 50 });
  });
});

describe("recordAiUsageEvent", () => {
  afterEach(() => {
    inserted.length = 0;
    upsertError = null;
  });

  it("never carries prompt/response text — only identifiers land in the row", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "chat",
      model: "anthropic/claude-sonnet-4-6",
      tokens: { input: 100, output: 50 },
      metadata: { node_id: "node-1", finish_reason: "stop" },
    });
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "cost_source",
        "cost_usd",
        "metadata",
        "model",
        "request_id",
        "subject_user_id",
        "success",
        "surface",
        "tokens_cached",
        "tokens_input",
        "tokens_output",
        "workspace_id",
      ].sort(),
    );
    // The type surface for `metadata` only accepts primitives, so there is no
    // way to pass a prompt/response string through it — this asserts the
    // allowed keys stay identifiers, not that we redacted anything.
    expect(row.metadata).toEqual({ node_id: "node-1", finish_reason: "stop" });
  });

  it("scopes every row to the workspace it was recorded for", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-a",
      surface: "embed",
      model: "openai/text-embedding-3-small",
      tokens: { input: 10 },
    });
    await recordAiUsageEvent({
      workspaceId: "ws-b",
      surface: "embed",
      model: "openai/text-embedding-3-small",
      tokens: { input: 20 },
    });
    expect(inserted.map((r) => r.workspace_id)).toEqual(["ws-a", "ws-b"]);
    expect(inserted[0]!.workspace_id).not.toBe(inserted[1]!.workspace_id);
  });

  it("passes requestId through as the idempotency key for upsert-based dedupe", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "rerank",
      model: "cohere/rerank-v3.5",
      tokens: { input: 5 },
      requestId: "req-123",
    });
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "rerank",
      model: "cohere/rerank-v3.5",
      tokens: { input: 5 },
      requestId: "req-123",
    });
    // The upsert dedupe itself lives in Postgres (unique index + ignoreDuplicates);
    // here we assert the helper always forwards the same request_id for retries
    // of the same logical call, which is the contract the DB constraint relies on.
    expect(inserted.map((r) => r.request_id)).toEqual(["req-123", "req-123"]);
  });

  it("falls back to versioned per-model pricing when no provider cost is given", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "chat",
      model: "anthropic/claude-sonnet-4-6",
      tokens: { input: 1_000_000, output: 1_000_000 },
    });
    expect(inserted[0]!.cost_source).toBe("fallback");
    expect(inserted[0]!.cost_usd).toBeCloseTo(3 + 15, 5);
  });

  it("marks a model missing from the pricing table as unpriced, not as a free fallback", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "chat",
      model: "acme/not-in-the-table",
      tokens: { input: 1000, output: 1000 },
    });
    expect(inserted[0]!.cost_source).toBe("unpriced");
    expect(inserted[0]!.cost_usd).toBe(0);
  });

  it("keeps a priced call that rounds to $0 as fallback", async () => {
    // A two-token embedding is worth less than the millionth of a dollar the
    // ledger column stores; that is a rounding, not a missing price.
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "embed",
      model: "openai/text-embedding-3-small",
      tokens: { input: 2, output: 0 },
    });
    expect(inserted[0]!.cost_source).toBe("fallback");
    expect(inserted[0]!.cost_usd).toBe(0);
  });

  it("prices the cached part of the prompt once, at the cache rate", async () => {
    // The SDK's `inputTokens` is the whole prompt, cache reads included. A
    // Nexo turn with a 900k-token cache hit costs 100k at $2 + 900k at $0.2,
    // not 1M at $2 plus 900k at $0.2 on top.
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "nexo",
      model: "anthropic/claude-sonnet-5",
      tokens: { input: 1_000_000, output: 0, cached: 900_000 },
    });
    expect(inserted[0]!.cost_usd).toBeCloseTo(0.1 * 2 + 0.9 * 0.2, 6);
  });

  it("prices cache writes at Anthropic's 1.25x rate and never below zero uncached", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "nexo",
      model: "anthropic/claude-sonnet-5",
      tokens: { input: 1_000_000, output: 0, cached: 200_000, cacheWrite: 800_000 },
    });
    expect(inserted[0]!.cost_usd).toBeCloseTo(0.2 * 0.2 + 0.8 * 2.5, 6);
    // Cache writes are priced, not stored: the row keeps the total prompt.
    expect(inserted[0]!.tokens_input).toBe(1_000_000);
    expect(inserted[0]).not.toHaveProperty("tokens_cache_write");
  });

  it("bills a rerank per search, not per document", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "rerank",
      model: "cohere/rerank-v3.5",
      tokens: { input: 20 },
    });
    // Cohere: $2 per 1,000 searches, a search being up to 100 documents.
    expect(inserted[0]!.cost_usd).toBeCloseTo(0.002, 6);
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "rerank",
      model: "cohere/rerank-v3.5",
      tokens: { input: 150 },
    });
    expect(inserted[1]!.cost_usd).toBeCloseTo(0.004, 6);
  });

  it("prices every model the surfaces default to, so nothing runs for free", async () => {
    const defaults = [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
      "deepseek/deepseek-v4-flash",
      "openai/text-embedding-3-small",
    ];
    for (const model of defaults) {
      await recordAiUsageEvent({
        workspaceId: "ws-1",
        surface: "chat",
        model,
        tokens: { input: 1_000_000, output: 0 },
      });
    }
    for (const row of inserted) expect(row.cost_usd as number).toBeGreaterThan(0);
  });

  it("prefers provider-reported cost over the fallback table when present", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "chat",
      model: "anthropic/claude-sonnet-4-6",
      tokens: { input: 1_000_000, output: 1_000_000 },
      providerCostUsd: 0.42,
    });
    expect(inserted[0]!.cost_source).toBe("provider");
    expect(inserted[0]!.cost_usd).toBe(0.42);
  });

  it("derives the provider cost from the gateway metadata when the caller passes it", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "contextualize",
      model: "anthropic/claude-haiku-4-5",
      tokens: { input: 500, output: 60 },
      providerMetadata: { gateway: { cost: "0.0008" } },
    });
    expect(inserted[0]!.cost_source).toBe("provider");
    expect(inserted[0]!.cost_usd).toBe(0.0008);
  });

  it("prices the catalog spelling (claude-haiku-4.5) like the code spelling (claude-haiku-4-5)", async () => {
    await recordAiUsageEvent({
      workspaceId: "ws-1",
      surface: "contextualize",
      model: "anthropic/claude-haiku-4.5",
      tokens: { input: 1_000_000, output: 0 },
    });
    expect(inserted[0]!.cost_usd).toBeCloseTo(1, 5);
  });

  it("swallows DB errors — telemetry must never throw for the caller", async () => {
    upsertError = { message: "boom" };
    await expect(
      recordAiUsageEvent({
        workspaceId: "ws-1",
        surface: "skill_run",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).resolves.toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.fn();
vi.mock("ai", () => ({
  generateObject: (args: Parameters<typeof mockGenerateObject>[0]) => mockGenerateObject(args),
  createGateway: () => (model: string) => model,
}));

const recorded: Record<string, unknown>[] = [];
vi.mock("@/lib/telemetry/ai-usage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/telemetry/ai-usage")>(
    "@/lib/telemetry/ai-usage",
  );
  return {
    ...actual,
    recordAiUsageEvent: async (input: Record<string, unknown>) => {
      recorded.push(input);
    },
  };
});

import { extractCandidate, ExtractCandidateError } from "./extract";

describe("extractCandidate", () => {
  afterEach(() => {
    mockGenerateObject.mockReset();
    recorded.length = 0;
    vi.unstubAllEnvs();
  });

  it("throws no_gateway_key when no AI backend is configured", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    await expect(
      extractCandidate({ workspaceId: "ws-1", rawText: "text", sourceHint: "github" }),
    ).rejects.toMatchObject({ code: "no_gateway_key" });
  });

  it("returns the classified candidate and records ai usage on the ingest_extract surface", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    mockGenerateObject.mockResolvedValue({
      object: {
        kind: "task",
        title: "Fix flaky test",
        content_md: "## Objetivo\n\nFix it.",
        confidence: 0.9,
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const out = await extractCandidate({
      workspaceId: "ws-1",
      rawText: "the CI test flakes",
      sourceHint: "github:issue#42",
    });

    expect(out).toEqual({
      kind: "task",
      title: "Fix flaky test",
      contentMd: "## Objetivo\n\nFix it.",
      confidence: 0.9,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workspaceId: "ws-1",
      surface: "ingest_extract",
    });
  });

  it("wraps a model failure in ExtractCandidateError with code model_error", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    mockGenerateObject.mockRejectedValue(new Error("gateway 500"));
    await expect(
      extractCandidate({ workspaceId: "ws-1", rawText: "text", sourceHint: "slack" }),
    ).rejects.toMatchObject({ code: "model_error" } satisfies Partial<ExtractCandidateError>);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRefinePrompt, RefineError, refineTranscript } from "../refine";

describe("buildRefinePrompt", () => {
  it("includes title, participants, and duration when provided", () => {
    const out = buildRefinePrompt({
      transcriptMd: "**Alice · 00:00** — Hi.",
      title: "Q3 kickoff",
      participants: ["Alice", "Bob"],
      durationSec: 1800,
    });
    expect(out).toContain("Title: Q3 kickoff");
    expect(out).toContain("Participants: Alice, Bob");
    expect(out).toContain("Duration: 30 min");
    expect(out).toContain("**Alice · 00:00** — Hi.");
  });

  it("omits the meta header when no metadata is provided", () => {
    const out = buildRefinePrompt({
      transcriptMd: "**Alice · 00:00** — Hi.",
      participants: [],
      durationSec: null,
    });
    expect(out.startsWith("Produce a Markdown document")).toBe(true);
  });

  it("skips zero-minute durations to avoid noisy headers", () => {
    const out = buildRefinePrompt({
      transcriptMd: "x".repeat(50),
      participants: [],
      durationSec: 20,
    });
    expect(out).not.toContain("Duration:");
  });
});

describe("refineTranscript", () => {
  const originalKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalKey;
  });

  it("throws RefineError(no_gateway_key) when the key is missing", async () => {
    await expect(
      refineTranscript({ transcriptMd: "x".repeat(500) }),
    ).rejects.toMatchObject({ name: "RefineError", code: "no_gateway_key" });
  });

  it("throws RefineError(input_too_short) for tiny transcripts before requiring the gateway key", async () => {
    // Length check runs before env lookup, so the result is the same
    // whether the key is set or not.
    await expect(
      refineTranscript({ transcriptMd: "hi" }),
    ).rejects.toMatchObject({ name: "RefineError", code: "input_too_short" });
  });

  it("exposes the error code on the thrown instance", async () => {
    try {
      await refineTranscript({ transcriptMd: "x".repeat(500) });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RefineError);
      expect((err as RefineError).code).toBe("no_gateway_key");
    }
  });
});

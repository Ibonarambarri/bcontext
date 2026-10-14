import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_MODEL,
  buildContextPrompt,
  combinePrefix,
  contextualizeChunks,
  deriveDocSummary,
  generateChunkContext,
  normalizeContextPrefix,
  resolveContextModel,
  contextualRetrievalEnabled,
} from "./contextualize";

const ORIG_CHAT = process.env.CHAT_MODEL;
const ORIG_CONTEXT = process.env.CONTEXT_MODEL;
const ORIG_KEY = process.env.AI_GATEWAY_API_KEY;

describe("contextualize helpers", () => {
  beforeEach(() => {
    delete process.env.CHAT_MODEL;
    delete process.env.CONTEXT_MODEL;
    delete process.env.CONTEXTUAL_RETRIEVAL;
    // Ensure the LLM path is short-circuited by `generateChunkContext`'s
    // missing-key guard. Real LLM calls are not exercised in unit tests.
    delete process.env.AI_GATEWAY_API_KEY;
  });
  afterEach(() => {
    if (ORIG_CHAT === undefined) delete process.env.CHAT_MODEL;
    else process.env.CHAT_MODEL = ORIG_CHAT;
    if (ORIG_CONTEXT === undefined) delete process.env.CONTEXT_MODEL;
    else process.env.CONTEXT_MODEL = ORIG_CONTEXT;
    if (ORIG_KEY === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = ORIG_KEY;
  });

  describe("resolveContextModel", () => {
    it("prefers CONTEXT_MODEL when set", () => {
      process.env.CONTEXT_MODEL = "openai/gpt-5-nano";
      expect(resolveContextModel("override/x")).toBe("openai/gpt-5-nano");
    });

    it("ignores CHAT_MODEL — the chat model must not price the per-chunk loop", () => {
      process.env.CHAT_MODEL = "anthropic/claude-sonnet-4-6";
      expect(resolveContextModel("override/x")).toBe("override/x");
      expect(resolveContextModel()).toBe(DEFAULT_CONTEXT_MODEL);
    });

    it("falls back to the explicit override when env is unset", () => {
      expect(resolveContextModel("override/x")).toBe("override/x");
    });

    it("uses the cheap default when nothing is provided", () => {
      expect(resolveContextModel()).toBe(DEFAULT_CONTEXT_MODEL);
      expect(resolveContextModel(null)).toBe(DEFAULT_CONTEXT_MODEL);
      expect(resolveContextModel("   ")).toBe(DEFAULT_CONTEXT_MODEL);
    });
  });

  describe("deriveDocSummary", () => {
    it("returns the body verbatim when under budget", () => {
      expect(deriveDocSummary("Hello world.")).toBe("Hello world.");
    });

    it("clamps at a sentence boundary when possible", () => {
      const body =
        "First sentence here. Second one continues. " +
        "x".repeat(900) +
        ". Tail.";
      const summary = deriveDocSummary(body, 200);
      expect(summary.length).toBeLessThanOrEqual(200);
      // Should end at one of the early sentence stops, not mid-x.
      expect(summary.endsWith(".")).toBe(true);
      expect(summary.includes("x".repeat(50))).toBe(false);
    });

    it("trims surrounding whitespace", () => {
      expect(deriveDocSummary("  \n hello \n ")).toBe("hello");
    });

    it("falls back to a whitespace boundary when no sentence stop fits", () => {
      // No sentence punctuation at all; uses lastSpace.
      const body = "alpha beta gamma delta epsilon zeta eta";
      const summary = deriveDocSummary(body, 20);
      expect(summary.length).toBeLessThanOrEqual(20);
      expect(summary).not.toContain("zeta");
      // Should not end mid-word.
      expect(/\s$/.test(summary)).toBe(false);
    });
  });

  describe("buildContextPrompt", () => {
    it("includes the title, summary, and chunk in tagged sections", () => {
      const out = buildContextPrompt({
        title: "Auth Spec",
        docSummary: "Defines how users sign in via magic links.",
        chunkContent: "Magic links expire after 15 minutes.",
      });
      expect(out).toContain("<document_title>\nAuth Spec\n</document_title>");
      expect(out).toContain(
        "<document_summary>\nDefines how users sign in via magic links.\n</document_summary>",
      );
      expect(out).toContain(
        "<chunk>\nMagic links expire after 15 minutes.\n</chunk>",
      );
      // Explicit budget instruction — keeps the model from rambling.
      expect(out).toMatch(/max ~?100 tokens/i);
      // Instruction not to summarize the chunk — important for retrieval signal.
      expect(out.toLowerCase()).toContain("do not summarize the chunk");
    });

    it("differs across titles so identical chunks in different docs produce different prompts", () => {
      const a = buildContextPrompt({
        title: "Doc A",
        docSummary: "About A.",
        chunkContent: "Shared content.",
      });
      const b = buildContextPrompt({
        title: "Doc B",
        docSummary: "About B.",
        chunkContent: "Shared content.",
      });
      expect(a).not.toEqual(b);
    });
  });

  describe("normalizeContextPrefix", () => {
    it("strips surrounding whitespace and quotes", () => {
      expect(normalizeContextPrefix('  "Hello there"  ')).toBe("Hello there");
      expect(normalizeContextPrefix("“Smart quotes”")).toBe("Smart quotes");
    });

    it("strips code fences the model may have added", () => {
      expect(normalizeContextPrefix("```\nbody\n```")).toBe("body");
      expect(normalizeContextPrefix("```text\nbody\n```")).toBe("body");
    });

    it("collapses newlines into single spaces", () => {
      expect(normalizeContextPrefix("a\nb\n\nc")).toBe("a b c");
    });

    it("clamps a runaway response", () => {
      const huge = "x ".repeat(1000);
      const out = normalizeContextPrefix(huge);
      expect(out.length).toBeLessThanOrEqual(600);
    });
  });

  describe("combinePrefix", () => {
    it("combines with a blank-line separator", () => {
      expect(combinePrefix("CTX", "body line")).toBe("CTX\n\nbody line");
    });

    it("returns content as-is when prefix is empty", () => {
      expect(combinePrefix("", "body")).toBe("body");
    });
  });

  describe("generateChunkContext (missing gateway key)", () => {
    it("returns empty string when AI_GATEWAY_API_KEY is unset", async () => {
      const out = await generateChunkContext({
        node: { title: "T", content_md: "body" },
        chunk: { content: "chunk body", index: 0 },
      });
      expect(out).toBe("");
    });
  });

  describe("contextualRetrievalEnabled", () => {
    it("is off unless CONTEXTUAL_RETRIEVAL is set — the step costs ~90% of the bill and buys no retrieval", () => {
      delete process.env.CONTEXTUAL_RETRIEVAL;
      expect(contextualRetrievalEnabled()).toBe(false);
      process.env.CONTEXTUAL_RETRIEVAL = "0";
      expect(contextualRetrievalEnabled()).toBe(false);
      process.env.CONTEXTUAL_RETRIEVAL = "1";
      expect(contextualRetrievalEnabled()).toBe(true);
      process.env.CONTEXTUAL_RETRIEVAL = "true";
      expect(contextualRetrievalEnabled()).toBe(true);
      delete process.env.CONTEXTUAL_RETRIEVAL;
    });
  });

  describe("contextualizeChunks", () => {
    it("returns empty-prefix chunks when disabled", async () => {
      const chunks = [
        { index: 0, content: "first", tokens: 1, heading_path: [], block_id: "_unblocked" },
        { index: 1, content: "second", tokens: 1, heading_path: [], block_id: "_unblocked" },
      ];
      const out = await contextualizeChunks(
        { title: "T", content_md: "body" },
        chunks,
        { enabled: false },
      );
      expect(out).toHaveLength(2);
      expect(out.map((c) => c.context_prefix)).toEqual(["", ""]);
      // embedding_input falls back to raw content when prefix is empty.
      expect(out[0]!.embedding_input).toBe("first");
      expect(out[1]!.embedding_input).toBe("second");
    });

    it("returns empty-prefix chunks when the gateway key is missing", async () => {
      // Enabled explicitly; no AI_GATEWAY_API_KEY: each generateChunkContext returns "".
      process.env.CONTEXTUAL_RETRIEVAL = "1";
      const chunks = [
        { index: 0, content: "alpha", tokens: 1, heading_path: [], block_id: "_unblocked" },
      ];
      const out = await contextualizeChunks(
        { title: "T", content_md: "body" },
        chunks,
      );
      expect(out[0]!.context_prefix).toBe("");
      expect(out[0]!.embedding_input).toBe("alpha");
    });

    it("no-ops on an empty chunk list", async () => {
      const out = await contextualizeChunks(
        { title: "T", content_md: "body" },
        [],
      );
      expect(out).toEqual([]);
    });
  });
});

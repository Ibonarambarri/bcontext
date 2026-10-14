import { describe, expect, it } from "vitest";
import { batchExternalId, extractBatch, renderSignalsForPrompt } from "./batch-extract";
import { ExtractCandidateError } from "./extract";

describe("batch extractor", () => {
  it("throws no_gateway_key without an AI gateway", async () => {
    await expect(
      extractBatch({ workspaceId: "ws", sourceHint: "jira:issues", guidance: null, signals: [{ external_id: "a", title: "A", text: "x" }] }),
    ).rejects.toMatchObject({ code: "no_gateway_key" });
    await expect(extractBatch({ workspaceId: "ws", sourceHint: "x", guidance: null, signals: [] })).resolves.toMatchObject({ candidates: [] });
  });

  it("renders signals with their ids and metadata, trimming long bodies", () => {
    const out = renderSignalsForPrompt([
      { external_id: "issue:1", title: "First", text: "y".repeat(2000), url: "https://x/1", author: "Ana", kind_hint: "issue" },
    ]);
    expect(out).toContain("### [1] First");
    expect(out).toContain("external_id: issue:1");
    expect(out).toContain("issue · by Ana · https://x/1");
    expect(out.length).toBeLessThan(1800);
  });

  it("derives a stable external id from the evidence set, regardless of order", () => {
    const a = batchExternalId("decision", [{ external_id: "issue:2", excerpt: "" }, { external_id: "issue:1", excerpt: "" }]);
    const b = batchExternalId("decision", [{ external_id: "issue:1", excerpt: "" }, { external_id: "issue:2", excerpt: "" }]);
    expect(a).toBe(b);
    expect(a.startsWith("batch:decision:")).toBe(true);
    expect(batchExternalId("task", [{ external_id: "issue:1", excerpt: "" }])).not.toBe(a);
  });

  it("keeps the error class shared with the single-signal extractor", () => {
    expect(new ExtractCandidateError("model_error")).toBeInstanceOf(Error);
  });
});

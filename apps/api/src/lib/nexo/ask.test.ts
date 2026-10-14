import { describe, expect, it } from "vitest";
import { deriveConfidence, pickMode, resolveNexoSignals } from "./ask";

describe("ask_nexo — mode selection", () => {
  it("honours an explicit mode", () => {
    expect(pickMode("fast", "why did this change", { stale: true, superseded_by: "x" })).toMatchObject({ effective: "fast" });
    expect(pickMode("deep", "status", undefined)).toMatchObject({ effective: "deep" });
  });

  it("goes deep on reasons/history cues, in either language, and says which cue", () => {
    for (const q of ["Why is the worker separate?", "¿Por qué se retiró el CLI?", "porqué cambió el hosting", "what did we decide about pricing", "history of the auth model", "qué cambió en el deploy"]) {
      const pick = pickMode("auto", q, { stale: false, superseded_by: null });
      expect(pick.effective, q).toBe("deep");
      expect(pick.reason).toMatch(/history|reasons/);
    }
  });

  it("goes deep when the top hit is no longer current, otherwise fast", () => {
    expect(pickMode("auto", "deploy target", { superseded_by: "n2" })).toMatchObject({ effective: "deep", reason: expect.stringMatching(/superseded/) });
    expect(pickMode("auto", "deploy target", { stale: true, superseded_by: null })).toMatchObject({ effective: "deep", reason: expect.stringMatching(/stale/) });
    expect(pickMode("auto", "deploy target", { stale: false, superseded_by: null })).toMatchObject({ effective: "fast" });
    expect(pickMode("auto", "deploy target", undefined)).toMatchObject({ effective: "fast" });
  });
});

describe("ask_nexo — confidence", () => {
  const base = { conflicts: 0, answered: true, topSuperseded: false, topStale: false };

  it("is low with no hits", () => {
    expect(deriveConfidence({ ...base, hits: [] })).toMatchObject({ level: "low" });
  });

  it("needs a strong top score and a second source for high", () => {
    const two = [{ node_id: "a", similarity: 0.9 }, { node_id: "b", similarity: 0.6 }];
    expect(deriveConfidence({ ...base, hits: two })).toMatchObject({ level: "high" });
    const one = [{ node_id: "a", similarity: 0.9 }, { node_id: "a", similarity: 0.8 }];
    expect(deriveConfidence({ ...base, hits: one })).toMatchObject({ level: "medium", reason: expect.stringMatching(/single source/) });
    expect(deriveConfidence({ ...base, hits: [{ node_id: "a", similarity: 0.2 }] })).toMatchObject({ level: "low" });
  });

  it("downgrades for a superseded top hit, open conflicts, and retrieval-only answers", () => {
    const two = [{ node_id: "a", similarity: 0.9 }, { node_id: "b", similarity: 0.6 }];
    expect(deriveConfidence({ ...base, hits: two, topSuperseded: true })).toMatchObject({ level: "medium" });
    expect(deriveConfidence({ ...base, hits: two, topStale: true, conflicts: 1 })).toMatchObject({ level: "low", reason: expect.stringMatching(/stale.*conflict/) });
    expect(deriveConfidence({ ...base, hits: two, answered: false })).toMatchObject({ level: "medium", reason: expect.stringMatching(/no synthesis/) });
  });
});

describe("ask_nexo — demo signals", () => {
  it("counts the seeded pending candidates of the reference demo workspace and knows no conflicts", async () => {
    // WS_CONTEXT in src/lib/demo-store.ts: 8 seeded candidates, 6 pending.
    const seeded = resolveNexoSignals("demo", "00000000-0000-0000-0000-000000000010");
    expect(await seeded.countPendingSignals()).toBe(6);
    expect(await seeded.listOpenConflicts()).toEqual([]);
    const empty = resolveNexoSignals("demo", "00000000-0000-0000-0000-0000000000ff");
    expect(await empty.countPendingSignals()).toBe(0);
  });
});

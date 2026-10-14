import { describe, expect, it } from "vitest";
import {
  applySubtaskOp,
  newSubtaskId,
  readSubtasks,
  subtaskProgress,
  subtasksFromDrafts,
  withSubtasks,
  withoutSubtasks,
  SUBTASK_LIMITS,
  type Subtask,
} from "./subtasks.js";

const NOW = "2026-09-08T10:00:00.000Z";
const LATER = "2026-09-08T11:00:00.000Z";

/** Deterministic ids: s000000, s111111, … */
function seq(): () => number {
  let n = 0;
  return () => {
    const v = (n % 36) / 36;
    n += 1;
    return v;
  };
}

function three(): Subtask[] {
  return subtasksFromDrafts(
    [
      { title: "Schema", summary: "Add the column", content_md: "## Steps\n\n1. …" },
      { title: "API", summary: "Expose it", content_md: "" },
      { title: "UI", summary: "Show it", content_md: "" },
    ],
    NOW,
    seq(),
  );
}

describe("readSubtasks", () => {
  it("returns [] for missing or malformed data", () => {
    expect(readSubtasks(null)).toEqual([]);
    expect(readSubtasks({})).toEqual([]);
    expect(readSubtasks({ subtasks: "nope" })).toEqual([]);
    expect(readSubtasks({ subtasks: [{ title: "no id" }, null, 3] })).toEqual([]);
  });

  it("normalizes partial records instead of dropping them", () => {
    const [s] = readSubtasks({ subtasks: [{ id: "s1", title: "T" }] });
    expect(s).toEqual({ id: "s1", title: "T", summary: "", content_md: "", done: false, done_at: null, created_at: "", updated_at: "" });
  });
});

describe("subtasksFromDrafts", () => {
  it("stamps ids and times, keeps order, never marks done", () => {
    const list = three();
    expect(list.map((s) => s.title)).toEqual(["Schema", "API", "UI"]);
    expect(new Set(list.map((s) => s.id)).size).toBe(3);
    expect(list.every((s) => !s.done && s.done_at === null && s.created_at === NOW)).toBe(true);
    expect(subtaskProgress(list)).toEqual({ done: 0, total: 3 });
  });
});

describe("newSubtaskId", () => {
  it("avoids ids already in use", () => {
    const random = seq();
    const a = newSubtaskId([], random);
    const b = newSubtaskId([{ id: a }], random);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^s[a-z0-9]{6}$/);
  });
});

describe("applySubtaskOp", () => {
  it("add appends by default and inserts at a position when asked", () => {
    const list = three();
    const appended = applySubtaskOp(list, { op: "add", title: "Docs", summary: "", content_md: "" }, LATER);
    expect(appended.ok && appended.subtasks.map((s) => s.title)).toEqual(["Schema", "API", "UI", "Docs"]);
    const inserted = applySubtaskOp(list, { op: "add", title: "Docs", summary: "", content_md: "", position: 1 }, LATER);
    expect(inserted.ok && inserted.subtasks.map((s) => s.title)).toEqual(["Schema", "Docs", "API", "UI"]);
    expect(inserted.ok && inserted.subtask?.created_at).toBe(LATER);
    // The input list is never mutated.
    expect(list).toHaveLength(3);
  });

  it("add refuses past the limit and says what to do instead", () => {
    const full = subtasksFromDrafts(Array.from({ length: SUBTASK_LIMITS.count }, (_, i) => ({ title: `T${i}`, summary: "", content_md: "" })), NOW);
    const res = applySubtaskOp(full, { op: "add", title: "One more", summary: "", content_md: "" }, LATER);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/subtask_limit/);
  });

  it("update patches only supplied keys and reports a rename", () => {
    const list = three();
    const id = list[1]!.id;
    const edited = applySubtaskOp(list, { op: "update", id, patch: { summary: "Expose it over REST" } }, LATER);
    expect(edited.ok && edited.subtask).toMatchObject({ title: "API", summary: "Expose it over REST", updated_at: LATER });
    expect(edited.ok && edited.summary).toBe("subtask edited: API");
    const renamed = applySubtaskOp(list, { op: "update", id, patch: { title: "REST" } }, LATER);
    expect(renamed.ok && renamed.summary).toBe("subtask renamed: API → REST");
    const noop = applySubtaskOp(list, { op: "update", id, patch: { summary: "Expose it" } }, LATER);
    expect(noop.ok && noop.changed).toBe(false);
    expect(noop.ok && noop.subtask?.updated_at).toBe(NOW);
  });

  it("names the known ids when one is missing, so the retry needs no read", () => {
    const res = applySubtaskOp(three(), { op: "toggle", id: "nope" }, LATER);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/subtask not found: nope\. Known: s[a-z0-9]{6} \(Schema\)/);
  });

  it("toggle flips, or sets an explicit state idempotently", () => {
    const list = three();
    const id = list[0]!.id;
    const flipped = applySubtaskOp(list, { op: "toggle", id }, LATER);
    expect(flipped.ok && flipped.subtask).toMatchObject({ done: true, done_at: LATER });
    expect(flipped.ok && flipped.summary).toBe("subtask ☑ Schema");
    expect(flipped.ok && subtaskProgress(flipped.subtasks)).toEqual({ done: 1, total: 3 });
    const again = applySubtaskOp(flipped.ok ? flipped.subtasks : [], { op: "toggle", id, done: true }, LATER);
    expect(again.ok && again.changed).toBe(false);
    const reopened = applySubtaskOp(flipped.ok ? flipped.subtasks : [], { op: "toggle", id, done: false }, LATER);
    expect(reopened.ok && reopened.subtask).toMatchObject({ done: false, done_at: null });
  });

  it("delete removes exactly one", () => {
    const list = three();
    const res = applySubtaskOp(list, { op: "delete", id: list[1]!.id }, LATER);
    expect(res.ok && res.subtasks.map((s) => s.title)).toEqual(["Schema", "UI"]);
    expect(res.ok && res.subtask).toBeNull();
  });

  it("reorder with the full order requires a permutation", () => {
    const list = three();
    const [a, b, c] = list.map((s) => s.id) as [string, string, string];
    const ok = applySubtaskOp(list, { op: "reorder", ids: [c, a, b] }, LATER);
    expect(ok.ok && ok.subtasks.map((s) => s.title)).toEqual(["UI", "Schema", "API"]);
    const short = applySubtaskOp(list, { op: "reorder", ids: [c, a] }, LATER);
    expect(!short.ok && short.error).toMatch(/missing: /);
    const unknown = applySubtaskOp(list, { op: "reorder", ids: [c, a, b, "zzz"] }, LATER);
    expect(!unknown.ok && unknown.error).toMatch(/unknown: zzz/);
    const dupe = applySubtaskOp(list, { op: "reorder", ids: [c, a, a] }, LATER);
    expect(!dupe.ok && dupe.error).toMatch(/repeated: /);
  });

  it("reorder moves one subtask by id + position", () => {
    const list = three();
    const moved = applySubtaskOp(list, { op: "reorder", id: list[2]!.id, position: 0 }, LATER);
    expect(moved.ok && moved.subtasks.map((s) => s.title)).toEqual(["UI", "Schema", "API"]);
    const beyond = applySubtaskOp(list, { op: "reorder", id: list[0]!.id, position: 99 }, LATER);
    expect(beyond.ok && beyond.subtasks.map((s) => s.title)).toEqual(["API", "UI", "Schema"]);
    const bare = applySubtaskOp(list, { op: "reorder" }, LATER);
    expect(bare.ok).toBe(false);
  });
});

describe("data helpers", () => {
  it("withSubtasks keeps every other key; withoutSubtasks drops only that one", () => {
    const data = { attachments: [{ path: "a" }], previous_slugs: ["x"] };
    const list = three();
    const next = withSubtasks(data, list);
    expect(next.attachments).toEqual(data.attachments);
    expect(next.subtasks).toBe(list);
    expect(withoutSubtasks(next)).toEqual(data);
    expect(withoutSubtasks(null)).toEqual({});
  });
});

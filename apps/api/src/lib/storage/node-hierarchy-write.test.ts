import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "./demo";
import { canonicalNodeData, NodeWriteError } from "./index";

function storageFor(prefix: string) {
  const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: prefix, slug });
  const storage = resolveDemoStorage(slug);
  if (!storage) throw new Error("demo workspace missing");
  return storage;
}

async function expectWriteError(
  run: () => Promise<unknown>,
  code: NodeWriteError["code"],
) {
  await expect(run()).rejects.toMatchObject({ code });
}

describe("semantic node hierarchy write boundary", () => {
  it("strips a stray data.tags key without dropping unrelated data", () => {
    expect(canonicalNodeData({ tags: ["product"], source: "linear", nested: { ok: true } }))
      .toEqual({ source: "linear", nested: { ok: true } });
  });

  it("requires an existing parent in the same workspace", async () => {
    const storage = storageFor("hierarchy-local");
    const other = storageFor("hierarchy-foreign");
    const foreign = await other.createNode({
      title: "Foreign",
      kind: "doc",
      parent_id: null,
    });

    await expectWriteError(
      () => storage.createNode({ title: "Missing", kind: "doc", parent_id: "missing" }),
      "invalid_parent",
    );
    await expectWriteError(
      () => storage.createNode({ title: "Foreign child", kind: "doc", parent_id: foreign.id }),
      "invalid_parent",
    );
  });

  it("preserves real hierarchy and prevents cycles", async () => {
    const storage = storageFor("hierarchy-cycle");
    const root = await storage.createNode({ title: "Semantic root", kind: "doc", parent_id: null });
    const child = await storage.createNode({ title: "Semantic child", kind: "task", parent_id: root.id });
    expect(child.parent_id).toBe(root.id);

    await expectWriteError(
      () => storage.updateNode(root.id, { parent_id: child.id }),
      "parent_cycle",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/activity", () => ({ record: mocks.record }));

import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";
import { runAfterNodeWrite } from "./after-write";
import {
  findEntityMentions,
  linkEntities,
  readDismissedEntityLinks,
  rememberDismissedEntityLink,
  stripCode,
  type EntityRef,
} from "./entity-linker";

function storageFor(prefix: string): Storage {
  const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: prefix, slug });
  const storage = resolveDemoStorage(slug);
  if (!storage) throw new Error("demo workspace missing");
  return storage;
}

/** Let the fire-and-forget write hook finish before asserting on edges. */
const settle = () => new Promise((r) => setTimeout(r, 25));

async function entity(storage: Storage, title: string, aliases: string[] = []) {
  return storage.createNode({ title, kind: "entity", parent_id: null, data: { aliases } });
}

const acme: EntityRef = { id: "e-acme", title: "Acme Corp", aliases: ["Acme", "ACME Inc."] };
const jane: EntityRef = { id: "e-jane", title: "Jane Doe", aliases: ["JD"] };

describe("findEntityMentions", () => {
  it("matches titles and aliases on word boundaries, case-insensitively", () => {
    const scan = findEntityMentions("Call with acme about the Jane Doe contract.", [acme, jane]);
    expect(scan.matches.map((m) => m.entityId).sort()).toEqual(["e-acme", "e-jane"]);
    expect(scan.ambiguous).toEqual([]);
  });

  it("does not match inside other words, short aliases, or code", () => {
    expect(findEntityMentions("Acmeco ships; see `Acme` and JD", [acme, jane]).matches).toEqual([]);
    expect(findEntityMentions("```\nAcme Corp\n```\nplain text", [acme]).matches).toEqual([]);
    expect(findEntityMentions("ACME Inc. is a customer", [acme]).matches).toEqual([{ entityId: "e-acme", term: "ACME Inc." }]);
  });

  it("reports a term shared by two entities as ambiguous instead of guessing", () => {
    const other: EntityRef = { id: "e-acme-2", title: "Acme Labs", aliases: ["Acme"] };
    const scan = findEntityMentions("Met Acme today.", [acme, other]);
    expect(scan.matches).toEqual([]);
    expect(scan.ambiguous).toEqual([{ term: "Acme", entityIds: ["e-acme", "e-acme-2"] }]);
    // The full name resolves it: the longer term wins, and "Acme" no longer counts as open.
    const resolved = findEntityMentions("Met Acme Corp today.", [acme, other]);
    expect(resolved.matches).toEqual([{ entityId: "e-acme", term: "Acme Corp" }]);
    expect(resolved.ambiguous).toEqual([]);
  });

  it("never matches the node against itself", () => {
    expect(findEntityMentions("Acme Corp profile", [acme], { excludeId: "e-acme" }).matches).toEqual([]);
  });

  it("strips fenced and inline code", () => {
    expect(stripCode("a `x` b\n```ts\ncode\n```\nc").replace(/\s+/g, " ").trim()).toBe("a b c");
  });
});

describe("linkEntities (demo storage)", () => {
  beforeEach(() => mocks.record.mockReset());

  it("creates references edges for mentioned entities and records system activity", async () => {
    const storage = storageFor("linker");
    const acmeNode = await entity(storage, "Acme Corp", ["Acme"]);
    const janeNode = await entity(storage, "Jane Doe");
    await entity(storage, "Nobody Mentioned");
    const doc = await storage.createNode({
      title: "Kickoff notes",
      kind: "doc",
      parent_id: null,
      content_md: "## Attendees\nJane Doe from Acme joined.",
    });
    // The write hook already swept this node in the background; wait for it.
    await settle();
    const edges = await storage.listEdges();
    expect(edges.filter((e) => e.from_node === doc.id && e.relation === "references").map((e) => e.to_node).sort())
      .toEqual([acmeNode.id, janeNode.id].sort());
    expect(mocks.record).toHaveBeenCalledWith(
      storage.workspace.slug, "update", doc.id, "Kickoff notes", "entity linked: Acme Corp",
      expect.objectContaining({ actorKind: "system" }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      storage.workspace.slug, "update", doc.id, "Kickoff notes", "entity linked: Jane Doe",
      expect.objectContaining({ actorKind: "system" }),
    );

    // Idempotent: a second sweep links nothing and stays quiet.
    mocks.record.mockReset();
    const again = await linkEntities(storage, doc);
    expect(again.linked).toEqual([]);
    expect(again.skipped.sort()).toEqual([acmeNode.id, janeNode.id].sort());
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("runs from the storage write hook on create and content updates, not on metadata", async () => {
    const storage = storageFor("hook");
    const acmeNode = await entity(storage, "Acme Corp");
    const doc = await storage.createNode({ title: "Plan", kind: "doc", parent_id: null, content_md: "Nothing yet." });
    await settle();
    expect((await storage.listEdges()).filter((e) => e.from_node === doc.id)).toEqual([]);

    await storage.updateNode(doc.id, { content_md: "Acme Corp signed." });
    await settle();
    expect((await storage.listEdges()).filter((e) => e.from_node === doc.id).map((e) => e.to_node)).toEqual([acmeNode.id]);

    // A metadata-only update (status) does not sweep — the explicit form says so.
    const updated = (await storage.updateNode(doc.id, { status: "done" }))!;
    await storage.deleteEdge({ from_node: doc.id, to_node: acmeNode.id, relation: "references" });
    const metaOnly = await runAfterNodeWrite(storage, updated, { created: false, contentChanged: false });
    expect(metaOnly.linked).toEqual([]);
    await settle();
    expect((await storage.listEdges()).filter((e) => e.from_node === doc.id)).toEqual([]);
    // ...while a content change through the same entry point does.
    const swept = await runAfterNodeWrite(storage, updated, { created: false, contentChanged: true });
    expect(swept).toEqual({ linked: [acmeNode.id], scan_enqueued: false });
  });

  it("leaves a link alone once a human unlinked it", async () => {
    const storage = storageFor("dismiss");
    const acmeNode = await entity(storage, "Acme Corp");
    const doc = await storage.createNode({ title: "Notes", kind: "doc", parent_id: null, content_md: "Acme Corp again." });
    await settle();
    expect((await storage.listEdges()).some((e) => e.from_node === doc.id && e.to_node === acmeNode.id)).toBe(true);
    await storage.deleteEdge({ from_node: doc.id, to_node: acmeNode.id, relation: "references" });
    expect(await rememberDismissedEntityLink(storage, doc.id, acmeNode.id)).toBe(true);
    const fresh = (await storage.getNode(doc.id))!;
    expect(readDismissedEntityLinks(fresh.data)).toEqual([acmeNode.id]);

    const result = await linkEntities(storage, fresh);
    expect(result.linked).toEqual([]);
    expect(result.skipped).toEqual([acmeNode.id]);
    expect((await storage.listEdges()).some((e) => e.to_node === acmeNode.id)).toBe(false);
  });

  it("ignores unlinks whose target is not an entity", async () => {
    const storage = storageFor("dismiss-noop");
    const a = await storage.createNode({ title: "A", kind: "doc", parent_id: null });
    const b = await storage.createNode({ title: "B", kind: "doc", parent_id: null });
    expect(await rememberDismissedEntityLink(storage, a.id, b.id)).toBe(false);
    expect(readDismissedEntityLinks((await storage.getNode(a.id))!.data)).toEqual([]);
  });

  it("does not link ambiguous mentions and never links a node to itself", async () => {
    const storage = storageFor("ambiguous");
    const one = await entity(storage, "Acme Corp", ["Acme"]);
    const two = await entity(storage, "Acme Labs", ["Acme"]);
    const doc = await storage.createNode({ title: "Memo", kind: "doc", parent_id: null, content_md: "Acme called." });
    const result = await linkEntities(storage, doc);
    expect(result.linked).toEqual([]);
    expect(result.ambiguous).toEqual([{ term: "Acme", entityIds: [one.id, two.id] }]);
    expect((await storage.listEdges()).filter((e) => e.from_node === doc.id)).toEqual([]);

    // An entity whose body repeats its own name links nothing.
    const self = (await storage.updateNode(one.id, { content_md: "Acme Corp is Acme Corp." }))!;
    expect((await linkEntities(storage, self)).linked).toEqual([]);
  });

  it("skips credential nodes entirely", async () => {
    const storage = storageFor("credential");
    await entity(storage, "Acme Corp");
    const cred = await storage.createNode({ title: "Acme Corp API key", kind: "credential", parent_id: null, content_md: "Acme Corp" });
    expect((await linkEntities(storage, cred)).linked).toEqual([]);
  });
});

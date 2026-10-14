import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { TagConflictError, TagRelationError } from "@/lib/storage";
import { normalizeTagName, normalizeTagNames, tagSlugBase } from "@bcontext-dev/contract/tags";

function storageFor(prefix: string) {
  const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: prefix, slug });
  const storage = resolveDemoStorage(slug);
  if (!storage) throw new Error("demo storage missing");
  return storage;
}

describe("tag normalization", () => {
  it("normalizes case/whitespace and deduplicates", () => {
    expect(normalizeTagName("  Product   Ops ")).toBe("product ops");
    expect(normalizeTagNames(["Foo", " foo ", "BAR", 1, ""])).toEqual([
      "foo",
      "bar",
    ]);
    expect(tagSlugBase(" Product / Ops ")).toBe("product-ops");
  });
});

describe("demo taxonomy lifecycle", () => {
  it("seeds domain tags without duplicating kind-oriented categories", async () => {
    const storage = storageFor("seed-tags");
    const tags = await storage.listTags();
    expect(tags.map((tag) => tag.normalized_name)).toEqual([
      "ai",
      "business",
      "product",
      "tech",
    ]);
    expect(tags.some((tag) => tag.normalized_name === "tasks")).toBe(false);
  });

  it("assigns multiple tags and filters any/all", async () => {
    const storage = storageFor("multi-tags");
    const [business, product] = await Promise.all([
      storage.listTags().then((tags) => tags.find((tag) => tag.normalized_name === "business")!),
      storage.listTags().then((tags) => tags.find((tag) => tag.normalized_name === "product")!),
    ]);
    const node = await storage.createNode({
      title: "Cross-functional plan",
      kind: "doc",
      parent_id: null,
    });
    const assigned = await storage.setNodeTags(node.id, [business.id, product.id]);
    expect(assigned.tags.map((tag) => tag.id)).toEqual(expect.arrayContaining([business.id, product.id]));
    expect(assigned.data).not.toHaveProperty("tags");
    expect((await storage.listNodes({ tagIds: [business.id] })).map((item) => item.id)).toContain(node.id);
    expect((await storage.listNodes({ tagIds: [business.id, product.id], tagsMatch: "all" })).map((item) => item.id)).toContain(node.id);
    expect(await storage.listNodes({ tagIds: [business.id, "missing"], tagsMatch: "all" })).toHaveLength(0);
  });

  it("uses renamed tags and keeps old tag aliases resolving", async () => {
    const storage = storageFor("renamed-tag");
    const product = (await storage.listTags()).find((tag) => tag.normalized_name === "product")!;
    await storage.updateTag(product.id, { name: "Product Area" });
    const node = await storage.createNode({
      title: "Tagged node",
      kind: "doc",
      parent_id: null,
      tag_ids: [product.id],
    });
    expect(node.tags[0]).toMatchObject({ id: product.id, normalized_name: "product area" });
    expect(node.data).not.toHaveProperty("tags");
  });

  it("preserves ids on rename, redirects aliases on merge, and cleans assignments on delete", async () => {
    const storage = storageFor("lifecycle-tags");
    const source = await storage.createTag({ name: "Customer Success" });
    const target = await storage.createTag({ name: "Customers" });
    const node = await storage.createNode({
      title: "Renewal",
      kind: "doc",
      parent_id: null,
      tag_ids: [source.id],
    });

    const renamed = await storage.updateTag(source.id, {
      name: "Customer Operations",
      description: "Lifecycle owner",
    });
    expect(renamed.id).toBe(source.id);
    expect((await storage.getNode(node.id))?.data).not.toHaveProperty("tags");
    expect((await storage.listNodes({ tagSlugs: ["customer-success"] }))[0]?.id).toBe(node.id);
    await expect(storage.createTag({ name: "Customer Success" })).rejects.toBeInstanceOf(TagConflictError);

    const merged = await storage.mergeTags(source.id, target.id);
    expect(merged.id).toBe(target.id);
    expect((await storage.getTag(source.id))?.merged_into_id).toBe(target.id);
    expect((await storage.getNode(node.id))?.tags.map((tag) => tag.id)).toEqual([target.id]);
    expect((await storage.listNodes({ tagSlugs: ["customer-operations"] }))[0]?.id).toBe(node.id);

    expect(await storage.deleteTag(target.id)).toBe(true);
    expect((await storage.getNode(node.id))?.tags).toEqual([]);
    expect((await storage.getNode(node.id))?.data).not.toHaveProperty("tags");
  });

  it("creates parent/related tag relations and lists them workspace-wide", async () => {
    const storage = storageFor("tag-relations-basic");
    const backend = await storage.createTag({ name: "Backend" });
    const api = await storage.createTag({ name: "API" });
    const infra = await storage.createTag({ name: "Infra" });

    const created = await storage.createTagRelations(api.id, {
      parent_ids: [backend.id],
      related_ids: [infra.id],
    });
    expect(created).toHaveLength(2);
    expect(created.find((r) => r.relation === "parent")).toMatchObject({
      from_tag_id: api.id,
      to_tag_id: backend.id,
    });
    expect(created.find((r) => r.relation === "related")).toMatchObject({
      from_tag_id: api.id,
      to_tag_id: infra.id,
    });

    const all = await storage.listTagRelations();
    expect(all).toHaveLength(2);

    // Idempotent: re-requesting the same edges creates nothing new.
    const again = await storage.createTagRelations(api.id, {
      parent_ids: [backend.id],
      related_ids: [infra.id],
    });
    expect(again).toHaveLength(0);
    expect(await storage.listTagRelations()).toHaveLength(2);
  });

  it("rejects a tag being its own parent/related edge", async () => {
    const storage = storageFor("tag-relations-self");
    const tag = await storage.createTag({ name: "Loopy" });
    await expect(
      storage.createTagRelations(tag.id, { parent_ids: [tag.id] }),
    ).rejects.toBeInstanceOf(TagRelationError);
    await expect(
      storage.createTagRelations(tag.id, { related_ids: [tag.id] }),
    ).rejects.toBeInstanceOf(TagRelationError);
  });

  it("rejects a parent edge that would introduce a hierarchy cycle", async () => {
    const storage = storageFor("tag-relations-cycle");
    const grandparent = await storage.createTag({ name: "Grandparent" });
    const parent = await storage.createTag({ name: "Parent" });
    const child = await storage.createTag({ name: "Child" });
    // child -> parent -> grandparent
    await storage.createTagRelations(child.id, { parent_ids: [parent.id] });
    await storage.createTagRelations(parent.id, { parent_ids: [grandparent.id] });

    // grandparent -> child would close the loop.
    await expect(
      storage.createTagRelations(grandparent.id, { parent_ids: [child.id] }),
    ).rejects.toMatchObject({ code: "cycle" });

    expect(await storage.listTagRelations()).toHaveLength(2);
  });

  it("deletes a tag relation by (from, to, relation) and treats related as symmetric", async () => {
    const storage = storageFor("tag-relations-delete");
    const a = await storage.createTag({ name: "Tag A" });
    const b = await storage.createTag({ name: "Tag B" });
    await storage.createTagRelations(a.id, { related_ids: [b.id] });
    expect(await storage.listTagRelations()).toHaveLength(1);

    // Deleting via the reversed pair still matches — related is symmetric.
    const deleted = await storage.deleteTagRelation({
      fromTagId: b.id,
      toTagId: a.id,
      relation: "related",
    });
    expect(deleted).toBe(true);
    expect(await storage.listTagRelations()).toHaveLength(0);
  });

  it("repoints tag relations onto the target on merge, dropping self-loops/dupes", async () => {
    const storage = storageFor("tag-relations-merge");
    const source = await storage.createTag({ name: "Old Backend" });
    const target = await storage.createTag({ name: "Backend" });
    const infra = await storage.createTag({ name: "Infra" });
    const child = await storage.createTag({ name: "Backend Child" });

    await storage.createTagRelations(child.id, { parent_ids: [source.id] });
    // target already related to infra AND source related to infra too —
    // merging must not produce a duplicate edge.
    await storage.createTagRelations(target.id, { related_ids: [infra.id] });
    await storage.createTagRelations(source.id, { related_ids: [infra.id] });
    // source related to target directly — merging must drop this self-loop.
    await storage.createTagRelations(source.id, { related_ids: [target.id] });

    await storage.mergeTags(source.id, target.id);

    const relations = await storage.listTagRelations();
    // child -> source repointed to child -> target
    expect(relations.some((r) => r.from_tag_id === child.id && r.to_tag_id === target.id && r.relation === "parent")).toBe(true);
    expect(relations.some((r) => r.to_tag_id === source.id || r.from_tag_id === source.id)).toBe(false);
    // Only one related edge to infra remains (the duplicate was dropped).
    expect(relations.filter((r) => r.relation === "related" && (r.from_tag_id === infra.id || r.to_tag_id === infra.id))).toHaveLength(1);
  });

  it("cleans up tag relations when a tag is deleted", async () => {
    const storage = storageFor("tag-relations-tag-delete");
    const parent = await storage.createTag({ name: "Parent" });
    const child = await storage.createTag({ name: "Child" });
    await storage.createTagRelations(child.id, { parent_ids: [parent.id] });
    expect(await storage.listTagRelations()).toHaveLength(1);

    expect(await storage.deleteTag(parent.id)).toBe(true);
    expect(await storage.listTagRelations()).toHaveLength(0);
  });

  it("rejects the retired data.tags mirror at create and update boundaries", async () => {
    const storage = storageFor("legacy-data-tags");
    await expect(storage.createNode({
      title: "Legacy mirror",
      kind: "doc",
      parent_id: null,
      data: { tags: ["product"] },
    })).rejects.toMatchObject({ code: "legacy_data_tags" });

    const node = await storage.createNode({ title: "Canonical", kind: "doc", parent_id: null });
    await expect(storage.updateNode(node.id, { data: { tags: [] } }))
      .rejects.toMatchObject({ code: "legacy_data_tags" });
  });
});

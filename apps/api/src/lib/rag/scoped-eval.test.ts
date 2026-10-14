import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { retrieveScoped } from "@/lib/rag";

/** Small deterministic global-vs-scoped quality eval spanning all domains. */
describe("scoped RAG eval: Business / Product / Tech", () => {
  const previousKey = process.env.AI_GATEWAY_API_KEY;
  beforeEach(() => { delete process.env.AI_GATEWAY_API_KEY; });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousKey;
  });

  it("trades recall for precision in strict scope while auto preserves global recall without duplicates", async () => {
    const workspace = createWorkspace({ name: "RAG eval", slug: `rag-eval-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const seeded = await storage.listTags();
    const businessTag = seeded.find((tag) => tag.normalized_name === "business")!;
    const productTag = seeded.find((tag) => tag.normalized_name === "product")!;
    const techTag = seeded.find((tag) => tag.normalized_name === "tech")!;
    const business = await storage.createNode({ title: "Revenue launch", kind: "doc", parent_id: null, content_md: "revenue launch pricing", tag_ids: [businessTag.id] });
    const product = await storage.createNode({ title: "Product launch", kind: "doc", parent_id: null, content_md: "product launch onboarding", tag_ids: [productTag.id] });
    const tech = await storage.createNode({ title: "Launch architecture", kind: "adr", parent_id: null, content_md: "launch architecture embedding", tag_ids: [techTag.id] });
    const relevant = new Set([business.id, product.id, tech.id]);
    const query = "revenue product launch architecture";

    const global = await retrieveScoped(workspace.slug, query, { k: 10, storage });
    const strict = await retrieveScoped(workspace.slug, query, {
      k: 10,
      storage,
      scope: { schema_version: 1, type: "tags", tags_all: [productTag.id] },
    });
    const auto = await retrieveScoped(workspace.slug, query, {
      k: 10,
      storage,
      scope: { schema_version: 1, type: "auto", tags_all: [productTag.id] },
    });

    expect(metrics(global.hits.map((hit) => hit.node_id), relevant)).toEqual({ recall: 1, precision: 1 });
    expect(metrics(strict.hits.map((hit) => hit.node_id), relevant)).toEqual({ recall: 1 / 3, precision: 1 });
    expect(metrics(auto.hits.map((hit) => hit.node_id), relevant)).toEqual({ recall: 1, precision: 1 });
    expect(auto.scope.global_lane).toBe(true);
    expect(new Set(auto.hits.map((hit) => hit.node_id)).size).toBe(auto.hits.length);
  });
});

function metrics(found: string[], relevant: Set<string>) {
  const unique = [...new Set(found)];
  const truePositives = unique.filter((id) => relevant.has(id)).length;
  return {
    recall: truePositives / relevant.size,
    precision: unique.length === 0 ? 0 : truePositives / unique.length,
  };
}

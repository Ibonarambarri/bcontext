import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET, POST } from "./route";
import { PUT as ASSIGN_TAGS } from "@/app/api/nodes/[id]/tags/route";
import {
  DELETE as DELETE_TAG,
  PATCH as UPDATE_TAG,
} from "@/app/api/tags/[id]/route";
import { POST as MERGE_TAG } from "@/app/api/tags/[id]/merge/route";
import {
  DELETE as DELETE_RELATION,
  POST as CREATE_RELATION,
} from "@/app/api/tags/[id]/relations/route";
import { GET as LIST_NODES } from "@/app/api/nodes/route";
import { PATCH as PATCH_NODE } from "@/app/api/nodes/[id]/route";

function workspace() {
  const slug = `rest-tags-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: "REST tags", slug });
  const storage = resolveDemoStorage(slug);
  if (!storage) throw new Error("demo storage missing");
  return { slug, storage };
}

describe("REST tag contracts", () => {
  it("creates/lists reusable tags and rejects normalized duplicates", async () => {
    const { slug } = workspace();
    const create = (name: string) =>
      POST(new Request("http://localhost/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ workspace: slug, name }),
      }));
    const created = await create("Customer Ops");
    expect(created.status).toBe(201);
    const duplicate = await create(" customer   ops ");
    expect(duplicate.status).toBe(409);

    const listed = await GET(
      new Request(`http://localhost/api/tags?workspace=${encodeURIComponent(slug)}`),
    );
    const payload = (await listed.json()) as { tags: Array<{ normalized_name: string }> };
    expect(payload.tags.some((tag) => tag.normalized_name === "customer ops")).toBe(true);
  });

  it("assigns several existing tags to one canonical node", async () => {
    const { slug, storage } = workspace();
    const tags = await storage.listTags();
    const node = await storage.createNode({ title: "Tagged", kind: "doc", parent_id: null });
    const ids = tags.filter((tag) => ["business", "tech"].includes(tag.normalized_name)).map((tag) => tag.id);
    const response = await ASSIGN_TAGS(
      new Request(`http://localhost/api/nodes/${node.id}/tags`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ workspace: slug, tag_ids: ids }),
      }),
      { params: Promise.resolve({ id: node.id }) },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { tags: WorkspaceTagShape[] };
    expect(payload.tags.map((tag) => tag.id)).toEqual(expect.arrayContaining(ids));
  });

  it("renames, resolves aliases, merges and deletes through REST", async () => {
    const { slug, storage } = workspace();
    const source = await storage.createTag({ name: "Customer Success" });
    const target = await storage.createTag({ name: "Customers" });
    const node = await storage.createNode({
      title: "Renewal",
      kind: "doc",
      parent_id: null,
      tag_ids: [source.id],
    });
    const jsonHeaders = {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
    };

    const renamed = await UPDATE_TAG(
      new Request(`http://localhost/api/tags/${source.id}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          workspace: slug,
          name: "Customer Operations",
          description: "Lifecycle owner",
        }),
      }),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(renamed.status).toBe(200);

    const byOldAlias = await LIST_NODES(
      new Request(
        `http://localhost/api/nodes?workspace=${encodeURIComponent(slug)}&tag=customer-success`,
      ),
    );
    const aliasBody = (await byOldAlias.json()) as { nodes: Array<{ id: string }> };
    expect(aliasBody.nodes.map((item) => item.id)).toContain(node.id);

    const merged = await MERGE_TAG(
      new Request(`http://localhost/api/tags/${source.id}/merge`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ workspace: slug, target_id: target.id }),
      }),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(merged.status).toBe(200);
    expect((await storage.getNode(node.id))?.tags.map((tag) => tag.id)).toEqual([
      target.id,
    ]);

    const deleted = await DELETE_TAG(
      new Request(
        `http://localhost/api/tags/${target.id}?workspace=${encodeURIComponent(slug)}`,
        { method: "DELETE", headers: { origin: "http://localhost", host: "localhost" } },
      ),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(deleted.status).toBe(200);
    expect((await storage.getNode(node.id))?.tags).toEqual([]);
  });

  it("creates a tag with parent_ids/related_ids and surfaces relations from GET", async () => {
    const { slug, storage } = workspace();
    const jsonHeaders = {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
    };
    const parent = await storage.createTag({ name: "Backend" });
    const sibling = await storage.createTag({ name: "Infra" });

    const created = await POST(new Request("http://localhost/api/tags", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        workspace: slug,
        name: "API",
        parent_ids: [parent.id],
        related_ids: [sibling.id],
      }),
    }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      tag: { id: string };
      relations: Array<{ from_tag_id: string; to_tag_id: string; relation: string }>;
    };
    expect(createdBody.relations).toHaveLength(2);

    const listed = await GET(
      new Request(`http://localhost/api/tags?workspace=${encodeURIComponent(slug)}`),
    );
    const listedBody = (await listed.json()) as {
      relations: Array<{ from_tag_id: string; to_tag_id: string; relation: string }>;
    };
    expect(listedBody.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_tag_id: createdBody.tag.id, to_tag_id: parent.id, relation: "parent" }),
        expect.objectContaining({ from_tag_id: createdBody.tag.id, to_tag_id: sibling.id, relation: "related" }),
      ]),
    );
  });

  it("creates and deletes a tag relation through the [id]/relations REST route", async () => {
    const { slug, storage } = workspace();
    const jsonHeaders = {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
    };
    const child = await storage.createTag({ name: "Child" });
    const parent = await storage.createTag({ name: "Parent" });

    const created = await CREATE_RELATION(
      new Request(`http://localhost/api/tags/${child.id}/relations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ workspace: slug, to_tag_id: parent.id, relation: "parent" }),
      }),
      { params: Promise.resolve({ id: child.id }) },
    );
    expect(created.status).toBe(201);
    expect(await storage.listTagRelations()).toHaveLength(1);

    // Reversing from/to as a parent edge would create a cycle -> 422.
    const cyclic = await CREATE_RELATION(
      new Request(`http://localhost/api/tags/${parent.id}/relations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ workspace: slug, to_tag_id: child.id, relation: "parent" }),
      }),
      { params: Promise.resolve({ id: parent.id }) },
    );
    expect(cyclic.status).toBe(422);

    const deleted = await DELETE_RELATION(
      new Request(
        `http://localhost/api/tags/${child.id}/relations?workspace=${encodeURIComponent(slug)}&to=${parent.id}&relation=parent`,
        { method: "DELETE", headers: { origin: "http://localhost", host: "localhost" } },
      ),
      { params: Promise.resolve({ id: child.id }) },
    );
    expect(deleted.status).toBe(200);
    expect(await storage.listTagRelations()).toHaveLength(0);
  });

  it("inherits tag filters through the hierarchy on GET /api/nodes ?tag= and ?tag_id=", async () => {
    const { slug, storage } = workspace();
    const parent = await storage.createTag({ name: "Platform" });
    const child = await storage.createTag({ name: "API" });
    await storage.createTagRelations(child.id, { parent_ids: [parent.id] });
    const childTagged = await storage.createNode({ title: "Gateway", kind: "doc", parent_id: null, tag_ids: [child.id] });
    const parentTagged = await storage.createNode({ title: "Platform doc", kind: "doc", parent_id: null, tag_ids: [parent.id] });

    const list = async (search: string) => {
      const response = await LIST_NODES(
        new Request(`http://localhost/api/nodes?workspace=${encodeURIComponent(slug)}&${search}`),
      );
      const body = (await response.json()) as { nodes: Array<{ id: string }> };
      return body.nodes.map((item) => item.id);
    };

    // Filtering by the parent (slug or id) includes descendant-tagged nodes.
    expect(await list("tag=platform")).toEqual(expect.arrayContaining([childTagged.id, parentTagged.id]));
    expect(await list(`tag_id=${parent.id}`)).toEqual(expect.arrayContaining([childTagged.id, parentTagged.id]));
    // No reverse inheritance: filtering by the child excludes the parent-tagged node.
    expect(await list("tag=api")).toEqual([childTagged.id]);
  });

  it("rejects legacy REST category writes", async () => {
    const { slug, storage } = workspace();
    const node = await storage.createNode({
      title: "Legacy REST client",
      kind: "doc",
      parent_id: null,
    });
    const response = await PATCH_NODE(
      new Request(`http://localhost/api/nodes/${node.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          host: "localhost",
        },
        body: JSON.stringify({ workspace: slug, category: "product" }),
      }),
      { params: Promise.resolve({ id: node.id }) },
    );
    const body = (await response.json()) as { error?: unknown };
    expect(response.status).toBe(400);
    expect(JSON.stringify(body.error)).toMatch(/category/i);
    expect(await storage.getNode(node.id)).toBeTruthy();
  });
});

interface WorkspaceTagShape {
  id: string;
}

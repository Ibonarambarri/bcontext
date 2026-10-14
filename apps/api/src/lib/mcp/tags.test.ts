import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { scopedStorage } from "@/lib/storage/scoped";

const mocks = vi.hoisted(() => ({
  listAuthorizedCapabilityTools: vi.fn(),
}));

vi.mock("@/lib/capabilities/catalog", () => ({
  listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools,
}));
vi.mock("@/lib/capabilities/gateway", () => ({
  CapabilityGatewayError: class CapabilityGatewayError extends Error {},
  invokeAuthorizedCapability: vi.fn(),
}));

import { buildMcpServer } from "./server";

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  if (!first || first.type !== "text") throw new Error("missing text result");
  return JSON.parse(first.text ?? "{}") as Record<string, unknown>;
}

describe("MCP first-class tags", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-tags-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "MCP tags", slug });
    const storage = resolveDemoStorage(slug);
    if (!storage) throw new Error("demo storage missing");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id,
      workspaceRef: slug,
      scopes: ["nodes:read", "nodes:write", "admin:*"],
      tokenId: "demo-token",
      tokenScope: "workspace",
      subjectUserId: null,
    grant: { workspaceId: "ws-1", principal: { kind: "user", id: "u1" }, verbs: ["read","write","delete","tags:create","tags:update","tags:delete","admin"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "tag-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => close());

  it("advertises and enforces the folderless writer schema", async () => {
    const tools = (await client.listTools()).tools;
    const write = tools.find((tool) => tool.name === "nodes_write")!;
    // One tool, one branch per op: find them through `oneOf` on the `op` const.
    const branch = (op: string) =>
      ((write.inputSchema.oneOf ?? []) as Array<{
        properties: Record<string, { const?: string } & Record<string, unknown>>;
      }>).find((b) => b.properties.op?.const === op)!;
    const createProperties = branch("create").properties as Record<string, {
      enum?: string[];
    }>;
    const updateProperties = branch("update").properties as Record<string, {
      properties?: Record<string, unknown>;
    }>;
    expect(createProperties.kind?.enum).not.toContain("folder");
    expect(createProperties).not.toHaveProperty("category");
    expect(updateProperties.patch?.properties).not.toHaveProperty("category");

    const folder = await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", title: "Legacy folder", kind: "folder" },
    });
    expect(folder.isError).toBe(true);
    const category = await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", title: "Categorized", kind: "doc", category: "product" },
    });
    expect(category.isError).toBe(true);
  });

  it("lists, creates and assigns existing tag ids without duplicating nodes", async () => {
    const createdTag = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Launch" },
    })).tag as { id: string };
    const createdNode = textPayload(await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", title: "Launch brief", kind: "doc", tag_ids: [createdTag.id] },
    })).node as { id: string; tags: Array<{ id: string }> };
    expect(createdNode.tags.map((tag) => tag.id)).toContain(createdTag.id);

    const tags = textPayload(await client.callTool({ name: "tags", arguments: {} }))
      .tags as Array<{ id: string; usage_count: number }>;
    expect(tags.find((tag) => tag.id === createdTag.id)?.usage_count).toBe(1);

    const listed = textPayload(await client.callTool({
      name: "nodes",
      arguments: { op: "list", tag_ids: [createdTag.id] },
    })).nodes as Array<{ id: string }>;
    expect(listed.filter((node) => node.id === createdNode.id)).toHaveLength(1);
  });

  it("preserves assignments across update/merge and removes them on delete", async () => {
    const source = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Customer Success", description: "Post-sale" },
    })).tag as { id: string };
    const target = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Customers" },
    })).tag as { id: string };
    const node = textPayload(await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", title: "Renewal", kind: "doc", tag_ids: [source.id] },
    })).node as { id: string };

    // A partial edit: renaming keeps the description, describing keeps the
    // name, and an empty patch is refused rather than silently a no-op.
    const renamed = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "update", id: source.id, name: "Customer Operations" },
    })).tag as { id: string; normalized_name: string; description: string | null };
    expect(renamed).toMatchObject({
      id: source.id,
      normalized_name: "customer operations",
      description: "Post-sale",
    });
    const described = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "update", id: source.id, description: "Everything after the signature" },
    })).tag as { name: string; description: string | null };
    expect(described).toMatchObject({ name: "Customer Operations", description: "Everything after the signature" });
    const empty = await client.callTool({ name: "tags_write", arguments: { op: "update", id: source.id } });
    expect(empty.isError).toBe(true);
    const taken = await client.callTool({
      name: "tags_write",
      arguments: { op: "update", id: source.id, name: "Customers" },
    });
    expect(taken.isError).toBe(true);
    expect((taken.content as Array<{ text?: string }>)[0]?.text).toContain("409 conflict");

    await client.callTool({
      name: "tags_write",
      arguments: { op: "merge", source_id: source.id, target_id: target.id },
    });
    const afterMerge = textPayload(await client.callTool({
      name: "nodes",
      arguments: { op: "get", id: node.id },
    })).node as { tags: Array<{ id: string }> };
    expect(afterMerge.tags.map((tag) => tag.id)).toEqual([target.id]);

    const deleted = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "delete", id: target.id },
    }));
    expect(deleted.ok).toBe(true);
    const afterDelete = textPayload(await client.callTool({
      name: "nodes",
      arguments: { op: "get", id: node.id },
    })).node as { tags: unknown[] };
    expect(afterDelete.tags).toEqual([]);
  });

  it("lets a writer shape the taxonomy but keeps merge and delete for admins", async () => {
    const slug = `mcp-tag-scopes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "MCP tag scopes", slug });
    const storage = resolveDemoStorage(slug);
    if (!storage) throw new Error("demo storage missing");
    // What a plain `nodes:write` token resolves to (`verbsForScopes`): the
    // taxonomy is the writer's to shape, so the tags come from whoever files
    // the work — but not the writer's to dissolve.
    const writerGrant = {
      workspaceId: workspace.id,
      principal: { kind: "agent", id: "a1" },
      verbs: ["read", "write", "delete", "tags:create", "tags:update"],
      reach: { type: "all" },
    } as never;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const scopedServer = buildMcpServer({
      workspaceId: workspace.id,
      workspaceRef: slug,
      scopes: ["nodes:read", "nodes:write"],
      tokenId: "writer-token",
      tokenScope: "workspace",
      subjectUserId: null,
    // The grant decides, not the token scope: the scoped storage checks the
    // verb per operation and names it when it refuses.
    grant: writerGrant,
      storage: scopedStorage(storage, writerGrant),
    });
    const scopedClient = new Client({ name: "tag-scope-test", version: "0.1.0" });
    await scopedServer.connect(serverTransport);
    await scopedClient.connect(clientTransport);
    try {
      const tags = textPayload(await scopedClient.callTool({
        name: "tags",
        arguments: {},
      })).tags as Array<{ id: string; normalized_name: string }>;
      const node = textPayload(await scopedClient.callTool({
        name: "nodes_write",
        arguments: { op: "create", title: "Assignable", kind: "doc" },
      })).node as { id: string };
      const assigned = await scopedClient.callTool({
        // Assigning tags to a node is a node write, not taxonomy management —
        // it needs nodes:write, which is why it lives in nodes_write.
        name: "nodes_write",
        arguments: {
        op: "set_node_tags",
          node_id: node.id,
          tag_ids: [tags.find((tag) => tag.normalized_name === "product")!.id],
        },
      });
      expect(assigned.isError).not.toBe(true);

      // The tool is advertised to the writer — it would be useless hidden.
      const names = (await scopedClient.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("tags_write");

      // Create, describe, hang under a parent, relate: all a writer's.
      const parent = textPayload(await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "create", name: "Go-to-market" },
      })).tag as { id: string };
      const created = textPayload(await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "create", name: "Launch", description: "Release work", parent_ids: [parent.id] },
      }));
      const child = created.tag as { id: string };
      expect(created.relations).toHaveLength(1);
      const updated = await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "update", id: child.id, description: "Everything around a release" },
      });
      expect(updated.isError).not.toBe(true);
      const related = await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "link", from_tag_id: child.id, to_tag_id: tags[0]!.id, relation: "related" },
      });
      expect(related.isError).not.toBe(true);
      const unlinked = textPayload(await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "unlink", from_tag_id: child.id, to_tag_id: tags[0]!.id, relation: "related" },
      }));
      expect(unlinked.removed).toBe(true);

      // Merging and deleting rewrite what every node under a tag means — and
      // other principals' reaches when those are tag-based — so they stay
      // with `tags:delete`, and the refusal names the verb.
      const forbiddenText = (result: Awaited<ReturnType<typeof scopedClient.callTool>>) =>
        (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      const merge = await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "merge", source_id: child.id, target_id: parent.id },
      });
      expect(merge.isError).toBe(true);
      expect(forbiddenText(merge)).toContain('lacks the "tags:delete" permission');
      const remove = await scopedClient.callTool({
        name: "tags_write",
        arguments: { op: "delete", id: child.id },
      });
      expect(remove.isError).toBe(true);
      expect(forbiddenText(remove)).toContain('lacks the "tags:delete" permission');
    } finally {
      await scopedClient.close();
      await scopedServer.close();
    }
  });

  it("creates a tag with parent_ids/related_ids and surfaces relations via list_tags", async () => {
    const parent = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Backend" },
    })).tag as { id: string };
    const sibling = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Infra" },
    })).tag as { id: string };

    const createdPayload = textPayload(await client.callTool({
      name: "tags_write",
      arguments: {
        op: "create",
        name: "API",
        parent_ids: [parent.id],
        related_ids: [sibling.id],
      },
    }));
    const created = createdPayload.tag as { id: string };
    const relations = createdPayload.relations as Array<{
      from_tag_id: string;
      to_tag_id: string;
      relation: string;
    }>;
    expect(relations).toHaveLength(2);
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_tag_id: created.id, to_tag_id: parent.id, relation: "parent" }),
        expect.objectContaining({ from_tag_id: created.id, to_tag_id: sibling.id, relation: "related" }),
      ]),
    );

    const listed = textPayload(await client.callTool({ name: "tags", arguments: {} }));
    const listedRelations = listed.relations as Array<{
      from_tag_id: string;
      to_tag_id: string;
      relation: string;
    }>;
    expect(listedRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_tag_id: created.id, to_tag_id: parent.id, relation: "parent" }),
        expect.objectContaining({ from_tag_id: created.id, to_tag_id: sibling.id, relation: "related" }),
      ]),
    );
  });

  it("links and unlinks tags via link_tags/unlink_tags", async () => {
    const child = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Child" },
    })).tag as { id: string };
    const parent = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Parent" },
    })).tag as { id: string };

    const linked = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "link", from_tag_id: child.id, to_tag_id: parent.id, relation: "parent" },
    }));
    expect(linked.ok).toBe(true);
    const linkedRelations = linked.relations as Array<{ from_tag_id: string; to_tag_id: string; relation: string }>;
    expect(linkedRelations).toEqual([
      expect.objectContaining({ from_tag_id: child.id, to_tag_id: parent.id, relation: "parent" }),
    ]);

    const listed = textPayload(await client.callTool({ name: "tags", arguments: {} }));
    expect(listed.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_tag_id: child.id, to_tag_id: parent.id, relation: "parent" }),
      ]),
    );

    const unlinked = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "unlink", from_tag_id: child.id, to_tag_id: parent.id, relation: "parent" },
    }));
    expect(unlinked).toEqual({ ok: true, removed: true });

    const afterUnlink = textPayload(await client.callTool({ name: "tags", arguments: {} }));
    expect(afterUnlink.relations).toEqual([]);
  });

  it("rejects a link_tags call that would create a hierarchy cycle, with a clear message", async () => {
    const child = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Cyclic child" },
    })).tag as { id: string };
    const parent = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Cyclic parent" },
    })).tag as { id: string };

    await client.callTool({
      name: "tags_write",
      arguments: { op: "link", from_tag_id: child.id, to_tag_id: parent.id, relation: "parent" },
    });

    const cyclic = await client.callTool({
      name: "tags_write",
      arguments: { op: "link", from_tag_id: parent.id, to_tag_id: child.id, relation: "parent" },
    });
    expect(cyclic.isError).toBe(true);
    const cyclicContent = cyclic.content as Array<{ type: string; text?: string }>;
    expect(cyclicContent[0]?.text).toContain("cycle in the tag hierarchy");
  });

  it("rejects create_tag's own parent_ids self-reference is impossible; rejects a 3-hop cycle assembled via link_tags", async () => {
    const a = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Chain A" },
    })).tag as { id: string };
    const b = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Chain B", parent_ids: [a.id] },
    })).tag as { id: string };
    const c = textPayload(await client.callTool({
      name: "tags_write",
      arguments: { op: "create", name: "Chain C", parent_ids: [b.id] },
    })).tag as { id: string };

    // a -> b -> c already exists (each is-a-child-of the previous). Closing
    // the loop by making `a` a child of `c` must be rejected as a cycle.
    const closingTheLoop = await client.callTool({
      name: "tags_write",
      arguments: { op: "link", from_tag_id: a.id, to_tag_id: c.id, relation: "parent" },
    });
    expect(closingTheLoop.isError).toBe(true);
    const content = closingTheLoop.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("cycle in the tag hierarchy");
  });
});

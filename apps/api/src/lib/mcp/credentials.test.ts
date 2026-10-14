import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";

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

describe("MCP credential redaction", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: NonNullable<ReturnType<typeof resolveDemoStorage>>;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "MCP creds", slug });
    const resolved = resolveDemoStorage(slug);
    if (!resolved) throw new Error("demo storage missing");
    storage = resolved;
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
    client = new Client({ name: "creds-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("redacts credential field values from nodes(op=get) but preserves structure", async () => {
    const credential = await storage.createNode({
      title: "Stripe keys",
      kind: "credential",
      parent_id: null,
      content_md: "Keys for the Stripe integration.",
      data: {
        fields: [
          { name: "Publishable key", value: "pk_live_demo123", secret: false },
          { name: "Secret key", value: "sk_live_demo456", secret: true },
        ],
      },
    });

    const result = await client.callTool({
      name: "nodes",
      arguments: { op: "get", id: credential.id, include_links: false },
    });
    const payload = textPayload(result);
    const node = payload.node as {
      data: { fields: Array<{ name: string; value: string; secret: boolean }> };
      content_md: string;
    };

    expect(node.data.fields).toHaveLength(2);
    for (const field of node.data.fields) {
      expect(field.value).toBe("[redacted]");
    }
    const [publishable, secret] = node.data.fields;
    expect(publishable?.name).toBe("Publishable key");
    expect(publishable?.secret).toBe(false);
    expect(secret?.name).toBe("Secret key");
    expect(secret?.secret).toBe(true);
    // Never the real secret values, anywhere in the serialized response.
    expect(JSON.stringify(payload)).not.toContain("pk_live_demo123");
    expect(JSON.stringify(payload)).not.toContain("sk_live_demo456");
  });

  it("leaves non-credential nodes untouched", async () => {
    const doc = await storage.createNode({
      title: "Runbook",
      kind: "doc",
      parent_id: null,
      content_md: "Some runbook content.",
      data: { source: "manual" },
    });

    const result = await client.callTool({
      name: "nodes",
      arguments: { op: "get", id: doc.id, include_links: false },
    });
    const payload = textPayload(result);
    const node = payload.node as { data: Record<string, unknown>; content_md: string };
    expect(node.data).toEqual({ source: "manual" });
    expect(node.content_md).toBe("Some runbook content.");
  });

  it("redacts credential values from nodes_write create and update responses", async () => {
    // The create branch has no `data` input (agents can't seed
    // credential fields at creation time) — the redaction still applies
    // defensively to whatever the storage layer returns.
    const created = await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", title: "AWS keys", kind: "credential", parent_id: null },
    });
    const createdPayload = textPayload(created);
    const createdNode = createdPayload.node as { id: string; data: Record<string, unknown> };
    expect(createdNode.id).toBeTruthy();

    // The update branch's `patch.data` is how an agent (or the app on its behalf)
    // would actually write credential field values — the response must
    // never echo the real value back.
    const updated = await client.callTool({
      name: "nodes_write",
      arguments: {
        op: "update",
        id: createdNode.id,
        patch: {
          data: {
            fields: [{ name: "Access key", value: "AKIA_REAL_SECRET", secret: true }],
          },
        },
      },
    });
    const updatedPayload = textPayload(updated);
    const updatedNode = updatedPayload.node as { data: { fields: Array<{ value: string }> } };
    expect(updatedNode.data.fields[0]?.value).toBe("[redacted]");
    expect(JSON.stringify(updatedPayload)).not.toContain("AKIA_REAL_SECRET");
  });

  it("excludes credential nodes from nodes(op=search) retrieval (memory keyword fallback)", async () => {
    await storage.createNode({
      title: "Datadog credential",
      kind: "credential",
      parent_id: null,
      content_md: "Datadog credential unique-marker-xyz for the monitoring stack.",
      data: {
        fields: [{ name: "API key", value: "dd_real_secret", secret: true }],
      },
    });
    await storage.createNode({
      title: "Datadog runbook",
      kind: "doc",
      parent_id: null,
      content_md: "Datadog runbook unique-marker-xyz for the monitoring stack.",
      data: {},
    });

    const result = await client.callTool({
      name: "nodes",
      arguments: { op: "search", query: "unique-marker-xyz Datadog", limit: 10 },
    });
    const payload = textPayload(result);
    const hits = payload.hits as Array<{ kind: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.kind !== "credential")).toBe(true);
  });
});

describe("MCP credential shape and use recipe", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: NonNullable<ReturnType<typeof resolveDemoStorage>>;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-creds-use-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "MCP creds use", slug });
    const resolved = resolveDemoStorage(slug);
    if (!resolved) throw new Error("demo storage missing");
    storage = resolved;
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
    client = new Client({ name: "creds-use-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("hands back the typed shape and a way to use it, never the value", async () => {
    const credential = await storage.createNode({
      title: "Stripe — API keys",
      kind: "credential",
      parent_id: null,
      content_md: "Billing.",
      data: {
        credential: { schema_version: 1, type: "api_key_pair", environment: "prod", service: "Stripe" },
        fields: [
          { key: "public_key", name: "Public / publishable key", value: "pk_live_x", secret: false },
          { key: "secret_key", name: "Secret key", value: "sk_live_REAL", secret: true },
        ],
      },
    });

    const result = await client.callTool({ name: "nodes", arguments: { op: "get", id: credential.id } });
    const payload = textPayload(result);
    const node = payload.node as { data: { credential: Record<string, unknown>; fields: Array<Record<string, unknown>> } };

    expect(node.data.credential).toMatchObject({ type: "api_key_pair", environment: "prod", service: "Stripe" });
    expect(node.data.fields.map((f) => f.key)).toEqual(["public_key", "secret_key"]);
    expect(node.data.fields.every((f) => f.value === "[redacted]")).toBe(true);

    const use = payload.credential_use as { refs: Array<{ ref: string }>; shell: string; requires_scope: string };
    expect(use.requires_scope).toBe("credentials:use");
    expect(use.refs.map((r) => r.ref)).toContain(`bx://credential/${credential.id}#secret_key`);
    expect(use.shell).toContain("STRIPE_SECRET_KEY=$(curl");
    expect(use.shell).toContain("field=secret_key");
    expect(JSON.stringify(payload)).not.toContain("sk_live_REAL");
    expect(JSON.stringify(payload)).not.toContain("pk_live_x");
  });
});

describe("a secret pasted into the prose", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: NonNullable<ReturnType<typeof resolveDemoStorage>>;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-creds-md-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "MCP creds md", slug });
    const resolved = resolveDemoStorage(slug);
    if (!resolved) throw new Error("demo storage missing");
    storage = resolved;
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
    client = new Client({ name: "creds-md-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("is scrubbed out of content_md too — people paste, and prose is not a field", async () => {
    const node = await storage.createNode({
      title: "Grafana — panel",
      kind: "credential",
      parent_id: null,
      content_md: "Entra en el panel con la contraseña Sup3rSecretPassw0rd y luego ve a Servers.",
      data: { fields: [{ name: "Password", value: "Sup3rSecretPassw0rd", secret: true }] },
    });
    const payload = textPayload(await client.callTool({ name: "nodes", arguments: { op: "get", id: node.id } }));
    expect(JSON.stringify(payload)).not.toContain("Sup3rSecretPassw0rd");
    expect((payload.node as { content_md: string }).content_md).toContain("[redacted]");
    // The rest of the note survives — this is a net, not a shredder.
    expect((payload.node as { content_md: string }).content_md).toContain("luego ve a Servers");
  });
});

/**
 * `ask_nexo` through the MCP harness on the demo backend, with the gateway
 * mocked. What is asserted here is the contract an agent relies on: grants
 * apply before anything reaches the model, a superseded hit brings its
 * successor into the citations, open conflicts and pending signals surface,
 * `auto` explains the mode it picked, and no gateway degrades explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { scopedStorage } from "@/lib/storage/scoped";
import { ViewQuerySchema } from "@bcontext-dev/contract/views/schema";
import type { Grant } from "@/lib/auth/grants";
import type { Storage } from "@/lib/storage";
import type { NexoConflict } from "@bcontext-dev/contract/nexo/conflicts";

const mocks = vi.hoisted(() => ({
  listAuthorizedCapabilityTools: vi.fn(),
  generateText: vi.fn(),
  generateObject: vi.fn(),
  conflicts: [] as NexoConflict[],
  pending: 0,
}));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  generateObject: mocks.generateObject,
  createGateway: () => (model: string) => model,
  embed: vi.fn(),
  embedMany: vi.fn(),
  rerank: vi.fn(),
}));
// The two signal sources need Supabase; everything else in ask_nexo is real.
vi.mock("@/lib/nexo/ask", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nexo/ask")>();
  return {
    ...actual,
    resolveNexoSignals: () => ({
      listOpenConflicts: async () => mocks.conflicts,
      countPendingSignals: async () => mocks.pending,
    }),
  };
});
import { buildMcpServer } from "./server";

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown> & {
    citations: Array<{ node_id: string; via: string; superseded_by?: string; title: string }>;
    suggested_actions: Array<{ action: string; node_id?: string; conflict_id?: string }>;
    conflicts: Array<{ id: string }>;
    freshness: { status: string };
  };
}

function grantFor(workspaceId: string, reach: Grant["reach"] = { type: "all" }): Grant {
  return { workspaceId, principal: { kind: "agent", id: "agent-1" }, verbs: ["read"], reach };
}

async function connect(workspace: { id: string; slug: string }, storage: Storage, grant: Grant) {
  const pair = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer({
    workspaceId: workspace.id,
    workspaceRef: workspace.slug,
    scopes: ["nodes:read", "chat:run"],
    tokenId: "nexo-token",
    tokenScope: "workspace",
    subjectUserId: null,
    grant,
    storage,
  });
  const client = new Client({ name: "ask-nexo-test", version: "1" });
  await server.connect(pair[1]);
  await client.connect(pair[0]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("MCP ask_nexo", () => {
  let close: () => Promise<void> = async () => {};
  const savedKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(() => {
    mocks.listAuthorizedCapabilityTools.mockResolvedValue([]);
    mocks.conflicts = [];
    mocks.pending = 0;
    mocks.generateText.mockReset().mockResolvedValue({ text: "Nomad on the VPS [1].", usage: { inputTokens: 10, outputTokens: 5 } });
    mocks.generateObject.mockReset().mockResolvedValue({
      object: { answer: "Hosting moved to Nomad [2]; Vercel [1] is history.", knowledge_gaps: ["no runbook cited"], suggested_actions: [{ action: "read_runbook", reason: "confirm the cutover date" }] },
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });
  afterEach(async () => {
    await close();
    if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedKey;
  });

  function freshWorkspace(label: string) {
    const workspace = createWorkspace({ name: label, slug: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    return { workspace, storage: resolveDemoStorage(workspace.slug)! };
  }

  it("applies the grant before rerank and before any model context", async () => {
    const { workspace, storage } = freshWorkspace("nexo-scope");
    const visible = await storage.createNode({ title: "Deploy target", kind: "doc", parent_id: null, content_md: "The deploy target is Nomad on the VPS." });
    const hidden = await storage.createNode({ title: "Deploy target history", kind: "adr", parent_id: null, content_md: "The deploy target was Vercel before the move." });
    await storage.createEdge({ from_node: hidden.id, to_node: visible.id, relation: "references" });
    // A reader narrowed to the `public` tag: the adr exists, but not for them.
    const tag = await storage.createTag({ name: "public" });
    await storage.setNodeTags(visible.id, [tag.id]);
    const grant = grantFor(workspace.id, {
      type: "query",
      // By slug: reach refs that are not UUIDs resolve as tag slugs.
      query: ViewQuerySchema.parse({ schema_version: 1, tags_any: ["public"] }),
    });
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));

    const res = payload(await client.callTool({ name: "ask_nexo", arguments: { question: "what is the deploy target", mode: "deep" } }));
    expect(res.citations.map((c) => c.node_id)).toEqual([visible.id]);
    expect(res.citations.map((c) => c.node_id)).not.toContain(hidden.id);
    expect(res.answer).toBe("Hosting moved to Nomad [2]; Vercel [1] is history.");
    // The model saw only what the caller may read: no Vercel, no adr.
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    const call = mocks.generateObject.mock.calls[0]![0] as { prompt: string; system: string };
    expect(call.prompt).toContain("Nomad on the VPS");
    expect(call.prompt).not.toContain("Vercel");
    expect(call.prompt).not.toContain(hidden.id);
    expect(call.system).toMatch(/Inference:/);
    expect(res.relations).toEqual([]);
  });

  it("cites the superseding node when a hit is superseded, and auto goes deep for it", async () => {
    const { workspace, storage } = freshWorkspace("nexo-supersedes");
    const old = await storage.createNode({ title: "Hosting platform", kind: "decision", parent_id: null, content_md: "Hosting platform: hosting on Vercel." });
    // Deliberately does not match the query: only the supersedes edge can bring it in.
    const current = await storage.createNode({ title: "Moved to Nomad", kind: "decision", parent_id: null, content_md: "We host on Nomad now." });
    await storage.createEdge({ from_node: current.id, to_node: old.id, relation: "supersedes" });
    const grant = grantFor(workspace.id);
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));

    const res = payload(await client.callTool({ name: "ask_nexo", arguments: { question: "hosting platform" } }));
    expect(res.mode_requested).toBe("auto");
    expect(res.mode_effective).toBe("deep");
    expect(res.mode_reason).toMatch(/superseded/);
    // The old node is still cited (never hidden), labeled, and its successor follows.
    expect(res.citations[0]).toMatchObject({ node_id: old.id, via: "retrieval", superseded_by: current.id });
    expect(res.citations.find((c) => c.node_id === current.id)).toMatchObject({ via: "supersedes" });
    expect(res.freshness).toMatchObject({ status: "superseded", superseded_count: 1, staleness_signal: "unavailable" });
    expect(res.relations).toEqual([{ from_node: current.id, to_node: old.id, relation: "supersedes" }]);
    expect(res.suggested_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "read_superseding_node", node_id: current.id }),
      expect.objectContaining({ action: "read_runbook" }),
    ]));
    expect(res.knowledge_gaps).toEqual(["no runbook cited"]);
    expect(res.confidence_reason).toMatch(/top hit superseded/);
    // Both nodes reached the model, the superseded one marked as such.
    const call = mocks.generateObject.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain(`SUPERSEDED by /n/${current.id}`);
    expect(call.prompt).toContain("We host on Nomad now.");
  });

  it("surfaces open conflicts touching the cited nodes and lowers confidence", async () => {
    const { workspace, storage } = freshWorkspace("nexo-conflict");
    const node = await storage.createNode({ title: "Pricing tiers", kind: "doc", parent_id: null, content_md: "Pricing tiers: free and team." });
    const other = await storage.createNode({ title: "Unrelated", kind: "doc", parent_id: null, content_md: "Nothing about money." });
    mocks.conflicts = [
      { id: "c-1", workspace_id: workspace.id, kind: "contradiction", summary: "Slack says three tiers, the doc says two.", context_md: "", evidence: [], related_node_ids: [node.id], candidate_id: null, status: "open", decision_text: null, resolution: null, resolved_by: null, resolved_at: null, created_at: "2026-09-08T00:00:00Z" },
      { id: "c-2", workspace_id: workspace.id, kind: "doubt", summary: "Not about the cited nodes.", context_md: "", evidence: [], related_node_ids: [other.id], candidate_id: null, status: "open", decision_text: null, resolution: null, resolved_by: null, resolved_at: null, created_at: "2026-09-08T00:00:00Z" },
    ] as NexoConflict[];
    const grant = grantFor(workspace.id);
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));

    const res = payload(await client.callTool({ name: "ask_nexo", arguments: { question: "pricing tiers", mode: "fast" } }));
    expect(res.mode_effective).toBe("fast");
    expect(res.conflicts).toEqual([expect.objectContaining({ id: "c-1", kind: "contradiction", related_node_ids: [node.id] })]);
    expect(res.suggested_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "resolve_conflict", conflict_id: "c-1" })]));
    expect(res.confidence_reason).toMatch(/1 open conflict/);
    expect(res.confidence).not.toBe("high");
    // Fast mode: today's ask_rag path — plain text synthesis, no gap extraction.
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.generateObject).not.toHaveBeenCalled();
    const call = mocks.generateText.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("Slack says three tiers");
  });

  it("reports how many ingest signals are still pending", async () => {
    const { workspace, storage } = freshWorkspace("nexo-pending");
    await storage.createNode({ title: "Release notes", kind: "doc", parent_id: null, content_md: "Release notes for the week." });
    mocks.pending = 3;
    const grant = grantFor(workspace.id);
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));

    const res = payload(await client.callTool({ name: "ask_nexo", arguments: { question: "release notes", mode: "fast" } }));
    expect(res.signals_pending).toBe(3);
    expect(res.suggested_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "re_ask_after_ingest" })]));
  });

  it("auto picks deep on a why/history cue and fast otherwise, saying why", async () => {
    const { workspace, storage } = freshWorkspace("nexo-auto");
    await storage.createNode({ title: "Nomad decision", kind: "decision", parent_id: null, content_md: "We chose Nomad for hosting." });
    const grant = grantFor(workspace.id);
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));

    const why = payload(await client.callTool({ name: "ask_nexo", arguments: { query: "why did we choose nomad for hosting" } }));
    expect(why.mode_effective).toBe("deep");
    expect(why.mode_reason).toMatch(/"why"/);

    const plain = payload(await client.callTool({ name: "ask_nexo", arguments: { question: "nomad hosting" } }));
    expect(plain.mode_effective).toBe("fast");
    expect(plain.mode_reason).toMatch(/current/);
    expect(plain.freshness).toMatchObject({ status: "current" });
  });

  it("degrades explicitly without an AI gateway: retrieval-only shape, answer null", async () => {
    const { workspace, storage } = freshWorkspace("nexo-nokey");
    const node = await storage.createNode({ title: "Backup policy", kind: "doc", parent_id: null, content_md: "Backup policy: nightly dumps." });
    delete process.env.AI_GATEWAY_API_KEY;
    const grant = grantFor(workspace.id);
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));

    const res = payload(await client.callTool({ name: "ask_nexo", arguments: { question: "backup policy", mode: "deep" } }));
    expect(res.answer).toBeNull();
    expect(res.answer_note).toMatch(/no AI model configured/);
    expect(res.citations.map((c) => c.node_id)).toEqual([node.id]);
    expect(res.knowledge_gaps).toEqual([]);
    expect(res.confidence).not.toBe("high");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("is a read tool: visible to a reader, and needs chat:run to answer", async () => {
    const { workspace, storage } = freshWorkspace("nexo-visible");
    const grant = grantFor(workspace.id);
    let client: Client;
    ({ client, close } = await connect(workspace, scopedStorage(storage, grant), grant));
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "ask_nexo");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});

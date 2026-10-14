/**
 * The capability gateway over the MCP: external tools and skills are never
 * in tools/list; `capability_search` ranks what this caller may use and
 * `capability_call(ref, args)` re-resolves the ref, validates the args and
 * routes it — to the gateway for an external ref, to the skill runner for a
 * `skill/…` ref. The catalog and the gateway are mocked at the module
 * boundary; the skill half runs against the demo store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";
import type { AuthorizedCapabilityTool } from "@/lib/capabilities/types";
import { searchCapabilities, skillCandidates } from "./capability-search";

const mocks = vi.hoisted(() => ({
  listAuthorizedCapabilityTools: vi.fn(),
  invokeAuthorizedCapability: vi.fn(),
  runSkill: vi.fn(),
}));

vi.mock("@/lib/capabilities/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capabilities/catalog")>("@/lib/capabilities/catalog");
  return { ...actual, listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools };
});

vi.mock("@/lib/capabilities/gateway", () => {
  class CapabilityGatewayError extends Error {
    constructor(
      public code: string,
      message: string,
      public retryAfterSec?: number,
    ) { super(message); }
  }
  return {
    CapabilityGatewayError,
    invokeAuthorizedCapability: mocks.invokeAuthorizedCapability,
  };
});

// The skill runner calls the AI Gateway; here it only has to prove it was
// reached with the right skill and the validated input.
vi.mock("@/lib/skills/run", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skills/run")>("@/lib/skills/run");
  return { ...actual, runSkill: mocks.runSkill };
});

import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}
function body<T = Record<string, unknown>>(result: ToolResult): T {
  return JSON.parse(text(result)) as T;
}

interface Hit { ref: string; kind: "external" | "skill"; provider?: string; title: string; description: string; input_schema?: unknown }
interface SearchOut { hits: Hit[]; total: number; hint?: string }

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function externalTool(
  provider: string,
  capability: string,
  tool: string,
  description: string,
  extra: Partial<AuthorizedCapabilityTool> = {},
): AuthorizedCapabilityTool {
  return {
    workspaceId: WORKSPACE_ID,
    ref: `${provider}/${capability}/${tool}`,
    remoteName: tool,
    description,
    capabilityTitle: `${provider} ${capability}`,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    capabilityId: "22222222-2222-4222-8222-222222222222",
    capabilityVersionId: "33333333-3333-4333-8333-333333333333",
    capabilityKey: capability,
    capabilityType: "mcp_server",
    provider,
    principalId: "44444444-4444-4444-8444-444444444444",
    contract: {
      protocol: "mcp_streamable_http",
      tools: [{ name: tool, description, inputSchema: { type: "object" } }],
    },
    connection: {
      id: "55555555-5555-4555-8555-555555555555",
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "none",
      authHeaderName: null,
      secretRef: null,
      allowedHosts: ["mcp.example.com"],
      timeoutMs: 5000,
    },
    constraints: {},
    ...extra,
  };
}

const createIssue = externalTool("github", "issues", "create_issue", "Create a GitHub issue in a repository");
const searchIssues = externalTool("github", "issues", "search_issues", "Search GitHub issues by text");
const linearCreate = externalTool("linear", "issues", "linear_create_issue", "Create an issue in Linear");
const slackPost = externalTool("slack", "chat", "post_message", "Post a message to a Slack channel");

const SKILL_MD = `---
name: record-decision
description: Record a decision taken in a session.
input_schema:
  fields:
    - name: topic
      type: string
      required: true
    - name: max_candidates
      type: number
      default: 3
---

Search for up to {{max_candidates}} decisions about {{topic}}; if none, create one.
`;

describe("capability gateway over MCP: search, then call by ref", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;

  async function open(scopes: Scope[] = ["nodes:read", "nodes:write", "chat:run"]) {
    const slug = `mcp-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Gateway", slug });
    storage = resolveDemoStorage(slug)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id,
      workspaceRef: slug,
      scopes,
      tokenId: "66666666-6666-4666-8666-666666666666",
      tokenScope: "workspace",
      subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "a" }, verbs: ["read", "write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "gateway-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  }

  async function search(args: Record<string, unknown>): Promise<SearchOut> {
    const res = await client.callTool({ name: "capability_search", arguments: args });
    expect(res.isError, text(res)).toBeFalsy();
    return body<SearchOut>(res);
  }

  async function importSkill(): Promise<string> {
    const res = await client.callTool({ name: "skills_write", arguments: { op: "import", name: "record-decision", body_md: SKILL_MD } });
    expect(res.isError, text(res)).toBeFalsy();
    return body<{ id: string }>(res).id;
  }

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([createIssue, searchIssues, linearCreate, slackPost]);
    mocks.invokeAuthorizedCapability.mockReset().mockResolvedValue({
      content: [{ type: "text", text: "created" }],
    });
    mocks.runSkill.mockReset().mockImplementation(async (_storage: Storage, input: { skill_id: string; input: Record<string, unknown> }) => ({
      skill_id: input.skill_id,
      rendered_prompt: `about ${String(input.input.topic)}`,
      output: "done",
      model_used: "test-model",
      input_validated: input.input,
    }));
    await open();
  });

  afterEach(async () => close());

  it("never puts external tools in tools/list: the list is native tools plus the two routing tools, whatever is granted", async () => {
    const routing = ["capability_search", "capability_call"];
    const withGrants = (await client.listTools()).tools.map((tool) => tool.name);
    expect(withGrants.filter((name) => routing.includes(name))).toEqual(routing);
    expect(withGrants).not.toContain(createIssue.ref);
    expect(withGrants.some((name) => name.includes("__"))).toBe(false);

    mocks.listAuthorizedCapabilityTools.mockResolvedValue([]);
    const withoutGrants = (await client.listTools()).tools.map((tool) => tool.name);
    expect(withoutGrants).toEqual(withGrants);
    // And listing did not even ask the catalog.
    expect(mocks.listAuthorizedCapabilityTools).not.toHaveBeenCalled();
  });

  it("ranks by name first, then provider and capability, then description", async () => {
    const byWords = await search({ query: "create issue" });
    expect(byWords.total).toBe(3);
    expect(byWords.hits.map((hit) => hit.ref)).toEqual([
      "github/issues/create_issue",
      "linear/issues/linear_create_issue",
      "github/issues/search_issues",
    ]);
    expect(byWords.hits[0]).toMatchObject({ kind: "external", provider: "github", title: "create_issue" });

    const byProvider = await search({ query: "slack" });
    expect(byProvider.hits.map((hit) => hit.ref)).toEqual(["slack/chat/post_message"]);

    const byExactName = await search({ query: "post_message" });
    expect(byExactName.hits[0]!.ref).toBe("slack/chat/post_message");

    const filtered = await search({ query: "issue", provider: "linear" });
    expect(filtered.hits.map((hit) => hit.ref)).toEqual(["linear/issues/linear_create_issue"]);

    const nothing = await search({ query: "calendar" });
    expect(nothing).toEqual({ hits: [], total: 0 });
  });

  it("inlines input_schema for few hits or an exact ref, and says how to get it otherwise", async () => {
    // Four hits: names only, plus the hint.
    const everything = await search({ query: "*" });
    expect(everything.total).toBe(4);
    expect(everything.hits.every((hit) => hit.input_schema === undefined)).toBe(true);
    expect(everything.hint).toMatch(/ref/);

    // Three or fewer: every hit carries its schema, no hint.
    const few = await search({ query: "create issue" });
    expect(few.hits).toHaveLength(3);
    expect(few.hits.every((hit) => hit.input_schema !== undefined)).toBe(true);
    expect(few.hint).toBeUndefined();

    // An exact ref: that tool, with its schema, first.
    const exact = await search({ query: "github/issues/create_issue" });
    expect(exact.hits[0]).toMatchObject({ ref: "github/issues/create_issue", input_schema: createIssue.inputSchema });

    // `limit` pages; `total` still says how many matched.
    const limited = await search({ query: "*", limit: 2 });
    expect(limited.hits).toHaveLength(2);
    expect(limited.total).toBe(4);
  });

  it("routes capability_call by ref: re-authorized, args validated, same gateway", async () => {
    const result = await client.callTool({
      name: "capability_call",
      arguments: { ref: "github/issues/create_issue", args: { title: "Routed" } },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(mocks.invokeAuthorizedCapability).toHaveBeenCalledWith(
      createIssue,
      { title: "Routed" },
      expect.objectContaining({ workspaceId: storage.workspace.id, tokenId: "66666666-6666-4666-8666-666666666666" }),
    );

    const invalid = await client.callTool({
      name: "capability_call",
      arguments: { ref: "github/issues/create_issue", args: {} },
    });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toMatch(/invalid arguments/);

    // A ref the catalog no longer resolves — revoked, disabled, or made up —
    // is refused before anything upstream is touched.
    mocks.listAuthorizedCapabilityTools.mockResolvedValueOnce([]);
    const revoked = await client.callTool({
      name: "capability_call",
      arguments: { ref: "github/issues/create_issue", args: { title: "x" } },
    });
    expect(revoked.isError).toBe(true);
    expect(text(revoked)).toMatch(/unknown or unauthorized ref/);
    const madeUp = await client.callTool({
      name: "capability_call",
      arguments: { ref: "github/issues/delete_repository", args: { title: "x" } },
    });
    expect(madeUp.isError).toBe(true);
    expect(mocks.invokeAuthorizedCapability).toHaveBeenCalledTimes(1);

    // The old inline names are gone from tools/call too.
    const oldName = await client.callTool({ name: "github__issues__create_issue", arguments: { title: "x" } });
    expect(oldName.isError).toBe(true);
    expect(text(oldName)).toMatch(/unknown tool/);
  });

  it("finds the workspace's skills next to the external tools, under skill/<slug>", async () => {
    const id = await importSkill();
    const node = (await storage.getNode(id))!;

    const found = await search({ query: "record decision" });
    expect(found.hits[0]).toMatchObject({
      ref: `skill/${node.slug}`,
      kind: "skill",
      title: "record-decision",
      description: "Record a decision taken in a session.",
      input_schema: {
        type: "object",
        properties: { topic: { type: "string" }, max_candidates: { type: "number", default: 3 } },
        required: ["topic"],
        additionalProperties: false,
      },
    });
    expect(found.hits[0]).not.toHaveProperty("provider");

    // `provider: skill` narrows to the skills, and an external-only provider excludes them.
    const skillsOnly = await search({ query: "*", provider: "skill" });
    expect(skillsOnly.hits.map((hit) => hit.kind)).toEqual(["skill"]);
    const githubOnly = await search({ query: "*", provider: "github" });
    expect(githubOnly.hits.every((hit) => hit.provider === "github")).toBe(true);
  });

  it("runs a skill ref server-side like skills_run, and says so", async () => {
    const id = await importSkill();
    const node = (await storage.getNode(id))!;

    const result = await client.callTool({
      name: "capability_call",
      arguments: { ref: `skill/${node.slug}`, args: { topic: "pricing" } },
    });
    expect(result.isError, text(result)).toBeFalsy();
    expect(body(result)).toMatchObject({ ref: `skill/${node.slug}`, executed: "server", skill_id: id, output: "done" });
    expect(mocks.runSkill).toHaveBeenCalledWith(storage, { skill_id: id, input: { topic: "pricing" } }, undefined, null);
    expect(mocks.invokeAuthorizedCapability).not.toHaveBeenCalled();

    // The id works as the ref's key too; an unknown skill does not.
    const byId = await client.callTool({ name: "capability_call", arguments: { ref: `skill/${id}`, args: { topic: "x" } } });
    expect(byId.isError, text(byId)).toBeFalsy();
    const unknown = await client.callTool({ name: "capability_call", arguments: { ref: "skill/nope", args: {} } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/unknown skill ref/);
  });

  it("gates a skill run on chat:run, the same scope skills_run needs", async () => {
    const id = await importSkill();
    const node = (await storage.getNode(id))!;
    await close();
    await open(["nodes:read"]);

    const refused = await client.callTool({
      name: "capability_call",
      arguments: { ref: `skill/${node.slug}`, args: { topic: "pricing" } },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/chat:run/);
    expect(mocks.runSkill).not.toHaveBeenCalled();
  });
});

describe("searchCapabilities ranking", () => {
  const tools = [createIssue, searchIssues, linearCreate, slackPost];

  it("puts an exact ref above an exact name above a partial match", () => {
    const exact = searchCapabilities({ query: "github/issues/search_issues", limit: 10 }, tools, []);
    expect(exact.hits[0]!.ref).toBe("github/issues/search_issues");
    const name = searchCapabilities({ query: "search_issues", limit: 10 }, tools, []);
    expect(name.hits[0]!.ref).toBe("github/issues/search_issues");
    const partial = searchCapabilities({ query: "search", limit: 10 }, tools, []);
    expect(partial.hits.map((hit) => hit.ref)).toEqual(["github/issues/search_issues"]);
  });

  it("is case-insensitive and ignores punctuation in the query", () => {
    const out = searchCapabilities({ query: "GitHub: create-issue!", limit: 10 }, tools, []);
    expect(out.hits[0]!.ref).toBe("github/issues/create_issue");
  });

  it("matches the provider display name however it is spelled", () => {
    const branded = externalTool("GitHub Cloud", "issues", "create_issue", "Create", { ref: "github_cloud/issues/create_issue" });
    const out = searchCapabilities({ query: "issue", provider: "GitHub Cloud", limit: 10 }, [branded, linearCreate], []);
    expect(out.hits.map((hit) => hit.ref)).toEqual(["github_cloud/issues/create_issue"]);
  });

  it("skips archived skills and nodes that are not skills", () => {
    const skill = (over: Record<string, unknown>) => ({
      id: "s1", slug: "s1", kind: "skill", status: null, title: "S", content_md: SKILL_MD, ...over,
    }) as never;
    expect(skillCandidates([skill({})])).toHaveLength(1);
    expect(skillCandidates([skill({ status: "archived" })])).toHaveLength(0);
    expect(skillCandidates([skill({ kind: "doc" })])).toHaveLength(0);
    expect(skillCandidates([skill({ content_md: "no frontmatter" })])).toHaveLength(0);
  });
});

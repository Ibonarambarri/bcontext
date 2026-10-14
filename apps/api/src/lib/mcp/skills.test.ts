/**
 * Skills over MCP (F08): a skill is a capability of the connected agent.
 * skills_write(op=import) installs it from SKILL.md markdown (versioned),
 * skills(op=get) hands it back as instructions — prompt rendered with the
 * agent's input, the scopes it needs, the tools of this MCP it uses — and
 * any door that changes the body bumps data.version.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));

import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}
function body<T = Record<string, unknown>>(result: ToolResult): T {
  return JSON.parse(text(result)) as T;
}

const SKILL_MD = `---
name: record-decision
description: Record a decision taken in a session.
scopes: [nodes:read, nodes:write]
tools:
  - { name: nodes, op: search, when: "a similar decision may exist" }
  - { name: nodes_write, op: create }
  - name: links_write
    op: link
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

interface ImportOut { id: string; name: string; version: number; created: boolean; changed: boolean }
interface GetOut {
  skill_id: string; name: string; version: number; prompt: string; system: string | null;
  scopes: string[]; tools: Array<{ name: string; op?: string; when?: string }>;
  unknown_tools?: string[]; input_validated: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
}

describe("skills over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;

  async function open(scopes: Scope[]) {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Skills", slug });
    storage = resolveDemoStorage(slug)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes, tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "a" }, verbs: ["read", "write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  }

  beforeEach(async () => open(["nodes:read", "nodes:write"]));
  afterEach(async () => close());

  async function importSkill(md = SKILL_MD, extra: Record<string, unknown> = {}): Promise<ImportOut> {
    const res = await client.callTool({ name: "skills_write", arguments: { op: "import", name: "record-decision", body_md: md, ...extra } });
    expect(res.isError, text(res)).toBeFalsy();
    return body<ImportOut>(res);
  }

  it("imports a skill at version 1 and lists it", async () => {
    const out = await importSkill(SKILL_MD, { source: "catalog://bcontext/record-decision" });
    expect(out).toMatchObject({ name: "record-decision", version: 1, created: true, changed: true });

    const node = await storage.getNode(out.id);
    expect(node?.kind).toBe("skill");
    expect(node?.data).toEqual({ version: 1, source: "catalog://bcontext/record-decision" });

    const listed = body<{ skills: Array<{ name: string; version: number; source_id: string }> }>(
      await client.callTool({ name: "skills", arguments: {} }),
    );
    expect(listed.skills).toEqual([
      { name: "record-decision", description: "Record a decision taken in a session.", version: 1, source_id: out.id },
    ]);
  });

  it("returns the skill as instructions for the client: rendered prompt, scopes, tools in order", async () => {
    const { id } = await importSkill();
    const res = await client.callTool({ name: "skills", arguments: { op: "get", id, input: { topic: "pricing" } } });
    expect(res.isError, text(res)).toBeFalsy();
    const got = body<GetOut>(res);
    expect(got.skill_id).toBe(id);
    expect(got.name).toBe("record-decision");
    expect(got.version).toBe(1);
    expect(got.prompt.trim()).toBe("Search for up to 3 decisions about pricing; if none, create one.");
    expect(got.input_validated).toEqual({ topic: "pricing", max_candidates: 3 });
    expect(got.scopes).toEqual(["nodes:read", "nodes:write"]);
    expect(got.tools).toEqual([
      { name: "nodes", op: "search", when: "a similar decision may exist" },
      { name: "nodes_write", op: "create" },
      { name: "links_write", op: "link" },
    ]);
    expect(got.unknown_tools).toBeUndefined();
    expect(got.frontmatter).toMatchObject({ name: "record-decision" });
  });

  it("validates the input like skills_run does", async () => {
    const { id } = await importSkill();
    const res = await client.callTool({ name: "skills", arguments: { op: "get", id } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/missing required input: topic/);
  });

  it("refuses to hand over a skill whose declared scope the caller lacks, naming it", async () => {
    const { id } = await importSkill();
    await close();
    await open(["nodes:read"]);
    // Same demo workspace is gone (new slug) — re-import into the new one via storage.
    void id;
    await storage.createNode({ kind: "skill", title: "record-decision", parent_id: null, content_md: SKILL_MD, data: { version: 1 } });
    const listed = body<{ skills: Array<{ source_id: string }> }>(await client.callTool({ name: "skills", arguments: { op: "list" } }));
    const res = await client.callTool({ name: "skills", arguments: { op: "get", id: listed.skills[0]!.source_id, input: { topic: "x" } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/requires scope you do not hold: nodes:write/);
  });

  it("reports declared tools that are not tools of this MCP", async () => {
    const md = SKILL_MD.replace("  - name: links_write\n    op: link\n", "  - github__issues__create\n");
    const { id } = await importSkill(md);
    const got = body<GetOut>(await client.callTool({ name: "skills", arguments: { op: "get", id, input: { topic: "x" } } }));
    expect(got.tools.map((t) => t.name)).toEqual(["nodes", "nodes_write", "github__issues__create"]);
    expect(got.unknown_tools).toEqual(["github__issues__create"]);
  });

  it("re-import: identical body is a no-op, a changed body bumps the version", async () => {
    const first = await importSkill();
    const same = await importSkill();
    expect(same).toMatchObject({ id: first.id, version: 1, created: false, changed: false });

    const changed = await importSkill(SKILL_MD.replace("if none, create one.", "if none, create one and link it."));
    expect(changed).toMatchObject({ id: first.id, version: 2, created: false, changed: true });
    expect((await storage.getNode(first.id))?.data.version).toBe(2);
  });

  it("refuses a body whose frontmatter names another skill, and fills in a missing name", async () => {
    const other = await client.callTool({ name: "skills_write", arguments: { op: "import", name: "record-decision", body_md: SKILL_MD.replace("name: record-decision", "name: other") } });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/frontmatter name "other" does not match/);

    const nameless = await client.callTool({ name: "skills_write", arguments: { op: "import", name: "no-name", body_md: "---\ndescription: d\n---\n\nBody." } });
    expect(nameless.isError, text(nameless)).toBeFalsy();
    const node = await storage.getNode(body<ImportOut>(nameless).id);
    expect(node?.content_md.startsWith("---\nname: no-name\n")).toBe(true);
  });

  it("bumps the version when the body changes through nodes_write, not on metadata patches", async () => {
    const { id } = await importSkill();
    const before = await storage.getNode(id);
    const meta = await client.callTool({ name: "nodes_write", arguments: { op: "update", id, patch: { title: "Record a decision" } } });
    expect(meta.isError, text(meta)).toBeFalsy();
    expect((await storage.getNode(id))?.data.version).toBe(1);

    const now = (await storage.getNode(id))!.updated_at;
    const edit = await client.callTool({
      name: "nodes_write",
      arguments: { op: "update", id, if_updated_at: now, patch: { content_md: before!.content_md + "\nAlways cite the source.\n" } },
    });
    expect(edit.isError, text(edit)).toBeFalsy();
    expect((await storage.getNode(id))?.data.version).toBe(2);
  });

  it("a skill created with nodes_write starts at version 1", async () => {
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "create", kind: "skill", title: "Fresh", content_md: SKILL_MD } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(body<{ node: { data: Record<string, unknown> } }>(res).node.data).toEqual({ version: 1 });
  });

  it("hides skills_write from a read-only principal", async () => {
    await close();
    await open(["nodes:read"]);
    const res = await client.callTool({ name: "skills_write", arguments: { op: "import", name: "x", body_md: "---\nname: x\n---\nb" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/missing scope: nodes:write/);
  });
});

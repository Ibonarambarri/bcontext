/**
 * Two promises the transport makes about every MCP request, tested through
 * the real route (auth and storage lookups mocked, the server real):
 *
 *   - The `request.completed` log line says what happened: which tool and
 *     op, for what kind of principal, how many bytes went back and how long
 *     it took. Before this, the log for a day of agent traffic read
 *     `/mcp → 200` a few thousand times.
 *   - A write made over MCP is attributed to the agent by name. `list_changes`
 *     returns `actor: { kind, id, name }`, where `name` is the registered
 *     agent name and never a hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "@/lib/demo-store";

const AGENT_ID = "8a6f1f0e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const state = { workspaceId: "", agentName: "Codex release agent" as string | null };

vi.mock("@/lib/auth/require", () => ({
  gate: async () => ({
    kind: "agent",
    workspaceId: state.workspaceId,
    scopes: ["nodes:read", "nodes:write"],
    tokenId: "tok-1",
    createdBy: null,
    agentId: AGENT_ID,
  }),
  resolveAgentWorkspaceOr401: async () => ({ workspaceId: state.workspaceId, slug: "telemetry" }),
  actingUserId: () => null,
}));
vi.mock("@/lib/auth/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/grants")>()),
  resolveGrant: async (_actor: unknown, workspaceId: string) => ({
    workspaceId,
    principal: { kind: "agent", id: AGENT_ID },
    verbs: ["read", "write"],
    reach: { type: "all" },
  }),
}));
vi.mock("@/lib/agents/names", () => ({
  agentDisplayName: async (id: string | null) => (id === AGENT_ID ? state.agentName : null),
  agentDisplayNames: async () => new Map<string, string>(),
}));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: async () => [] }));
vi.mock("@/lib/capabilities/gateway", () => ({
  CapabilityGatewayError: class extends Error {},
  invokeAuthorizedCapability: vi.fn(),
}));

import { POST } from "./route";

interface LogLine {
  event: string;
  [key: string]: unknown;
}

let lines: LogLine[];
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const slug = `mcp-telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.workspaceId = createWorkspace({ name: "Telemetry", slug }).id;
  state.agentName = "Codex release agent";
  lines = [];
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    for (const raw of String(chunk).split("\n")) {
      if (!raw.startsWith("{")) continue;
      try {
        lines.push(JSON.parse(raw) as LogLine);
      } catch {
        // Not one of ours.
      }
    }
    return true;
  }) as never);
});
afterEach(() => {
  stdout.mockRestore();
});

async function rpc(body: Record<string, unknown>): Promise<{ status: number; result: Record<string, unknown> | undefined }> {
  const res = await POST(
    new Request("https://api.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
  );
  const json = res.status === 200 ? ((await res.json()) as { result?: Record<string, unknown> }) : undefined;
  return { status: res.status, result: json?.result };
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { status, result } = await rpc({ method: "tools/call", params: { name, arguments: args } });
  expect(status).toBe(200);
  const content = (result as { content: Array<{ text: string }>; isError?: boolean });
  expect(content.isError).toBeFalsy();
  return JSON.parse(content.content[0]!.text) as Record<string, unknown>;
}

function completed(): LogLine {
  const line = lines.filter((l) => l.event === "request.completed").at(-1);
  expect(line, "a request.completed line").toBeDefined();
  return line!;
}

describe("POST /mcp telemetry", () => {
  it("logs tool, op, principal_kind, bytes_out and duration_ms for a tools/call", async () => {
    const created = await call("nodes_write", { op: "create", kind: "doc", title: "Telemetry" });
    expect(created.id).toBeTypeOf("string");

    const line = completed();
    expect(line).toMatchObject({
      method: "POST",
      path: "/mcp",
      status: 200,
      tool: "nodes_write",
      op: "create",
      principal_kind: "agent",
    });
    expect(line.duration_ms).toBeTypeOf("number");
    expect(line.bytes_out).toBeTypeOf("number");
    expect(line.bytes_out as number).toBeGreaterThan(0);
    // The JSON-RPC method rides along too; on a tools/call it is the generic
    // envelope and `tool` is the useful part.
    expect(line.rpc_method).toBe("tools/call");
  });

  it("carries the JSON-RPC method for requests that are not tool calls", async () => {
    const { status } = await rpc({
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(status).toBe(200);
    const line = completed();
    expect(line.rpc_method).toBe("initialize");
    expect(line.tool).toBeUndefined();
    expect(line.principal_kind).toBe("agent");
    expect(line.bytes_out as number).toBeGreaterThan(0);
  });

  it("keeps the fixed shape of the line: annotations add, never overwrite", async () => {
    const { status } = await rpc({ method: "tools/call", params: { name: "ping", arguments: {} } });
    expect(status).toBe(200);
    const line = completed();
    expect(line.method).toBe("POST");
    expect(line.rpc_method).toBe("tools/call");
    expect(line.tool).toBe("ping");
    expect(line.op).toBeUndefined();
    expect(line.request_id).toBeTypeOf("string");
  });
});

describe("POST /mcp authorship", () => {
  it("attributes a write to the agent by name in list_changes", async () => {
    const created = await call("nodes_write", { op: "create", kind: "task", title: "Who wrote this" });
    const changes = await call("list_changes", { node_id: created.id });
    const entries = changes.changes as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor_kind: "agent",
      actor_principal_id: AGENT_ID,
      actor_label: "Codex release agent",
      actor: { kind: "agent", id: AGENT_ID, name: "Codex release agent" },
    });
  });

  it("falls back to a labelled id, never a bare hash, when the name is unknown", async () => {
    state.agentName = null;
    const created = await call("nodes_write", { op: "create", kind: "doc", title: "Anonymous" });
    const changes = await call("list_changes", { node_id: created.id });
    const [entry] = changes.changes as Array<{ actor: { kind: string; id: string; name: string } }>;
    expect(entry!.actor.kind).toBe("agent");
    expect(entry!.actor.id).toBe(AGENT_ID);
    expect(entry!.actor.name).toBe(`Agent · ${AGENT_ID.slice(0, 8)}`);
  });
});

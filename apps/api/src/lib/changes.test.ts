import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { listChangePageForStorage, record } from "@/lib/activity";
import {
  CHANGES_REALTIME_EVENTS,
  changePayload,
  decodeChangeCursor,
  encodeChangeCursor,
  redactChangeValue,
} from "@bcontext-dev/contract/changes";

function workspace(label: string) {
  const ws = createWorkspace({ name: label, slug: `${label}-${Date.now()}-${Math.random()}` });
  return { ws, storage: resolveDemoStorage(ws.slug)! };
}

describe("Changes supervision contract", () => {
  it("redacts secrets and private reasoning recursively before persistence", () => {
    expect(redactChangeValue({
      api_key: "sk-secret",
      nested: { access_token: "bearer", useful: "kept" },
      reasoning: "private chain",
      analysis_notes: "also private",
    })).toEqual({
      api_key: "[REDACTED]",
      nested: { access_token: "[REDACTED]", useful: "kept" },
      reasoning: "[OMITTED: private model reasoning]",
      analysis_notes: "[OMITTED: private model reasoning]",
    });
  });

  it("attributes actors, stores provenance and keeps tenant feeds isolated", async () => {
    const a = workspace("changes-a");
    const b = workspace("changes-b");
    const nodeA = await a.storage.createNode({ title: "Alpha", kind: "doc", parent_id: null, data: { source: "github", references: ["/n/source"] } });
    const nodeB = await b.storage.createNode({ title: "Foreign", kind: "doc", parent_id: null });
    record(a.ws.slug, "create", nodeA.id, nodeA.title, "doc", {
      actorKind: "agent",
      actorId: "user-a",
      principalId: "agent-a",
      principalLabel: "Codex release agent",
      payload: changePayload({ after: nodeA, via: "mcp" }),
    });
    record(b.ws.slug, "create", nodeB.id, nodeB.title, "doc", { actorKind: "human", payload: changePayload({ after: nodeB, via: "web" }) });

    const page = await listChangePageForStorage(a.storage, a.ws.slug, { actorKinds: ["agent"] });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      node_id: nodeA.id,
      actor_kind: "agent",
      actor_principal_id: "agent-a",
      actor_label: "Codex release agent",
      actor: { kind: "agent", id: "agent-a", name: "Codex release agent" },
      source: "github",
      snapshot_state: "available",
    });
    expect(page.entries[0]?.provenance).toMatchObject({ via: "mcp", sources: ["github"], references: ["/n/source"] });
    expect(page.entries.some((entry) => entry.node_id === nodeB.id)).toBe(false);
  });

  it("paginates without duplicates and validates opaque cursors", async () => {
    const { ws, storage } = workspace("changes-pages");
    for (let index = 0; index < 5; index++) record(ws.slug, "update", `node-${index}`, `Node ${index}`);
    const first = await listChangePageForStorage(storage, ws.slug, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = await listChangePageForStorage(storage, ws.slug, { limit: 2, cursor: first.next_cursor! });
    expect(second.entries).toHaveLength(2);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(4);
    const cursor = encodeChangeCursor({ ts: first.entries[0]!.ts, id: first.entries[0]!.id });
    expect(decodeChangeCursor(cursor)).toEqual({ ts: first.entries[0]!.ts, id: first.entries[0]!.id });
    expect(decodeChangeCursor("not-a-cursor")).toBeNull();
  });

  it("refreshes Changes for every node and relation mutation", () => {
    expect(CHANGES_REALTIME_EVENTS).toEqual(expect.arrayContaining([
      "node.created", "node.updated", "node.renamed", "node.moved", "node.deleted", "backlink.changed",
    ]));
  });
});

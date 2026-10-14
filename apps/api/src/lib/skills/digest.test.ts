/**
 * The digest from a demo workspace: the feed is the in-memory buffer
 * `record` fills, the graph is the demo store. No model, no Supabase —
 * the plain renderer is the contract the AI prose decorates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  recordAiUsageEvent: vi.fn(async () => undefined),
}));
vi.mock("ai", () => ({
  createGateway: () => (model: string) => ({ model }),
  generateObject: mocks.generateObject,
}));
vi.mock("@/lib/telemetry/ai-usage", () => ({
  recordAiUsageEvent: mocks.recordAiUsageEvent,
  tokensFromUsage: () => ({ input: 1, output: 1, cached: 0 }),
}));

import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { record } from "@/lib/activity";
import {
  DIGEST_SOURCE,
  collectDigestFacts,
  decisionGist,
  digestTitle,
  publishWeeklyDigest,
  renderDigestMarkdown,
} from "./digest";

/** A minute from now: the seeded feed entries carry the real clock, so the
 *  window has to end after them. */
const NOW = new Date(Date.now() + 60_000);

async function seed() {
  const ws = createWorkspace({ name: "Digest lab", slug: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
  const storage = resolveDemoStorage(ws.slug)!;
  const doc = await storage.createNode({ title: "Pricing page", kind: "doc", parent_id: null, content_md: "# Pricing" });
  const done = await storage.createNode({ title: "Ship billing", kind: "task", parent_id: null, status: "done" });
  const blocker = await storage.createNode({ title: "Stripe account", kind: "task", parent_id: null, status: "in_progress" });
  const blocked = await storage.createNode({ title: "Charge cards", kind: "task", parent_id: null, status: "todo" });
  const free = await storage.createNode({ title: "Write changelog", kind: "task", parent_id: null, status: "todo", priority: "high" });
  const later = await storage.createNode({ title: "Refactor auth", kind: "task", parent_id: null, status: "backlog", priority: "low" });
  const flagged = await storage.createNode({ title: "Legal review", kind: "task", parent_id: null, status: "blocked" });
  const decision = await storage.createNode({
    title: "Charge in EUR only",
    kind: "decision",
    parent_id: null,
    content_md: "## Context\nMany currencies.\n\n## Decision\nWe **charge in EUR** only for the beta.\n\n## Consequences\nSimpler.",
  });
  await storage.createEdge({ from_node: blocked.id, to_node: blocker.id, relation: "blocked_by" });

  record(ws.slug, "create", doc.id, doc.title, "doc", { actorKind: "human" });
  record(ws.slug, "update", doc.id, doc.title, "doc", { actorKind: "agent" });
  record(ws.slug, "update", doc.id, doc.title, "doc", { actorKind: "agent" });
  record(ws.slug, "create", decision.id, decision.title, "decision", { actorKind: "human", payload: { node_kind: "decision" } });
  record(ws.slug, "update", done.id, done.title, "task", { actorKind: "human" });
  return { ws, storage, doc, done, blocker, blocked, free, later, flagged, decision };
}

beforeEach(() => {
  mocks.generateObject.mockReset();
  mocks.recordAiUsageEvent.mockClear();
});

describe("collectDigestFacts", () => {
  it("reads the week: changes, completed, decided, blocked and startable", async () => {
    const s = await seed();
    const facts = await collectDigestFacts(s.storage, { now: new Date(Date.now() + 60_000) });

    expect(facts.workspace.slug).toBe(s.ws.slug);
    expect(facts.changes.total).toBe(5);
    expect(facts.changes.by_action).toEqual({ create: 2, update: 3 });
    expect(facts.changes.by_actor).toEqual({ human: 3, agent: 2, system: 0 });
    expect(facts.changes.top_nodes[0]).toMatchObject({ id: s.doc.id, title: "Pricing page", events: 3 });

    expect(facts.completed.map((n) => n.id)).toEqual([s.done.id]);
    expect(facts.decided).toEqual([
      { id: s.decision.id, title: "Charge in EUR only", kind: "decision", gist: "We charge in EUR only for the beta." },
    ]);
    expect(facts.blocked.map((b) => [b.id, b.blockers.map((x) => x.id)])).toEqual([
      [s.blocked.id, [s.blocker.id]],
      [s.flagged.id, []],
    ]);
    // High priority first; the blocked task is not startable; done is not open.
    expect(facts.startable.map((n) => n.id)).toEqual([s.free.id, s.later.id]);
  });

  it("stops blocking once the blocker is terminal", async () => {
    const s = await seed();
    await s.storage.updateNode(s.blocker.id, { status: "done" });
    const facts = await collectDigestFacts(s.storage, { now: new Date(Date.now() + 60_000) });
    expect(facts.blocked.map((b) => b.id)).toEqual([s.flagged.id]);
    expect(facts.startable.map((n) => n.id)).toContain(s.blocked.id);
  });
});

describe("renderDigestMarkdown", () => {
  it("writes the four H2 blocks with links to the nodes", async () => {
    const s = await seed();
    const facts = await collectDigestFacts(s.storage, { now: new Date(Date.now() + 60_000) });
    const md = renderDigestMarkdown(facts);
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Qué cambió", "## Qué se decidió", "## Qué está bloqueado", "## Qué se puede empezar"]);
    expect(md).toContain(`[Pricing page](/n/${s.doc.id}) (3)`);
    expect(md).toContain(`- [Charge in EUR only](/n/${s.decision.id}) — We charge in EUR only for the beta.`);
    expect(md).toContain(`[Charge cards](/n/${s.blocked.id}) — bloqueada por [Stripe account](/n/${s.blocker.id}) (en curso)`);
    expect(md).toContain(`- [Write changelog](/n/${s.free.id}) (high)`);
    expect(md).toContain("**5 cambios**");
  });

  it("says so honestly when a week is empty", () => {
    const md = renderDigestMarkdown({
      workspace: { id: "w", slug: "w", name: "Quiet" },
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
      changes: { total: 0, by_action: {}, by_actor: { human: 0, agent: 0, system: 0 }, top_nodes: [] },
      completed: [],
      decided: [],
      blocked: [],
      startable: [],
    });
    expect(md).toContain("- Sin cambios registrados esta semana.");
    expect(md).toContain("- Ninguna decisión nueva esta semana.");
    expect(md).toContain("- Nada bloqueado.");
    expect(md).toContain("- No hay tareas libres");
  });

  it("opens each block with the model's prose when given", () => {
    const md = renderDigestMarkdown(
      {
        workspace: { id: "w", slug: "w", name: "Quiet" },
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-08T00:00:00.000Z",
        changes: { total: 0, by_action: {}, by_actor: { human: 0, agent: 0, system: 0 }, top_nodes: [] },
        completed: [],
        decided: [],
        blocked: [],
        startable: [],
      },
      { changed: "Semana tranquila.", decided: "", blocked: "Nada.", startable: "Empieza por el changelog." },
    );
    expect(md).toContain("## Qué cambió\n\nSemana tranquila.\n\n- Sin cambios");
    expect(md).toContain("## Qué se decidió\n\n- Ninguna decisión");
    expect(md).toContain("## Qué se puede empezar\n\nEmpieza por el changelog.\n\n- No hay tareas libres");
  });
});

describe("decisionGist", () => {
  it("takes the Decision block, stripped of markdown, bounded", () => {
    expect(decisionGist("## Context\nx\n## Decision\n_Use_ `pg-boss`.\n## Consequences\ny")).toBe("Use pg-boss.");
    expect(decisionGist("plain body only")).toBe("plain body only");
    expect(decisionGist("")).toBeNull();
    expect(decisionGist(`## Decision\n${"a".repeat(300)}`)?.length).toBe(218);
  });
});

describe("publishWeeklyDigest", () => {
  it("publishes a dated doc node tagged AI, sourced nexo.digest, without a model", async () => {
    const s = await seed();
    // The default workspace taxonomy already carries an "AI" tag.
    const ai = (await s.storage.listTags()).find((t) => t.slug === "ai")!;
    expect(ai).toBeDefined();
    const result = await publishWeeklyDigest(s.storage, { now: NOW, apiKey: "" });

    expect(result.created).toBe(true);
    expect(result.model_used).toBeNull();
    expect(result.node.kind).toBe("doc");
    expect(result.node.title).toBe(`Digest semanal ${NOW.toISOString().slice(0, 10)}`);
    expect(result.node.data.source).toBe(DIGEST_SOURCE);
    expect(result.node.data.digest).toMatchObject({ kind: "digest_weekly", decided: 1, blocked: 2, startable: 2, model: null });
    expect(result.node.tags.map((t) => t.id)).toEqual([ai.id]);
    expect(result.node.content_md).toContain("## Qué se decidió");
    expect(result.delivered).toEqual({ webhook: false, email: 0 });
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(digestTitle(NOW)).toBe(result.node.title);
  });

  it("refreshes the same day's digest instead of publishing a second one", async () => {
    const s = await seed();
    const first = await publishWeeklyDigest(s.storage, { now: NOW, apiKey: "" });
    await s.storage.createNode({ title: "Late addition", kind: "task", parent_id: null, status: "todo", priority: "urgent" });
    const second = await publishWeeklyDigest(s.storage, { now: NOW, apiKey: "" });

    expect(second.created).toBe(false);
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.content_md).toContain("Late addition");
    const digests = (await s.storage.listNodeSummaries()).filter((n) => n.source === DIGEST_SOURCE);
    expect(digests).toHaveLength(1);
  });

  it("leaves its own publication out of next week's 'what changed'", async () => {
    const s = await seed();
    await publishWeeklyDigest(s.storage, { now: NOW, apiKey: "" });
    const facts = await collectDigestFacts(s.storage, { now: new Date(Date.now() + 60_000) });
    expect(facts.changes.total).toBe(5);
    expect(facts.changes.top_nodes.some((n) => n.title.startsWith("Digest semanal"))).toBe(false);
  });

  it("asks the gateway for the prose when a key is present, and records the usage", async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: { changed: "Mucho movimiento en pricing.", decided: "Solo EUR.", blocked: "Stripe.", startable: "El changelog." },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const s = await seed();
    const result = await publishWeeklyDigest(s.storage, { now: NOW, apiKey: "gw-key", model: "test/model" });

    expect(result.model_used).toBe("test/model");
    expect(result.node.content_md).toContain("## Qué cambió\n\nMucho movimiento en pricing.\n\n- **5 cambios**");
    expect(result.node.data.digest).toMatchObject({ model: "test/model" });
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(mocks.recordAiUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: s.ws.id, surface: "skill_run", model: "test/model", metadata: expect.objectContaining({ kind: "digest_weekly" }) }),
    );
  });

  it("falls back to the plain digest when the model fails", async () => {
    mocks.generateObject.mockRejectedValueOnce(new Error("gateway down"));
    const s = await seed();
    const result = await publishWeeklyDigest(s.storage, { now: NOW, apiKey: "gw-key" });
    expect(result.model_used).toBeNull();
    expect(result.node.content_md).toContain("## Qué cambió\n\n- **5 cambios**");
  });
});

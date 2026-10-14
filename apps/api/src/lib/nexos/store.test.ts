/**
 * The Nexo store over the in-memory backend: the same contract the runtime
 * and the triggers rely on in Postgres — one general Nexo, one owner per
 * channel, runs that close once, inbox items that resolve once, and windows
 * that collect, cap, get claimed and flush.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { renderNexoPrompt } from "@bcontext-dev/contract/nexos";
import { ensureGeneralNexo } from "./general";
import { createNexo, deleteNexo, NexoError, updateNexo } from "./lifecycle";
import { nexoActor, scopesForBrainTools } from "./principal";
import {
  appendWindowEvent,
  claimDueWindows,
  countOpenInbox,
  createBindings,
  createInboxItem,
  createRun,
  findBindingForEvent,
  finishRun,
  getNexo,
  listBindings,
  listDueHeartbeats,
  listInbox,
  listNexos,
  listRuns,
  markWindowFlushed,
  NexoConflictError,
  resetNexoStoreForTests,
  resolveInboxItem,
  setNextHeartbeat,
} from "./store";
import type { NexoTarget } from "./types";

const t: NexoTarget = { workspaceId: "ws-store", backend: "demo" };
const other: NexoTarget = { workspaceId: "ws-other", backend: "demo" };

const questionnaire = {
  name: "Soporte",
  mission: "Atender clientes",
  sources: ["slack"],
  can_do_alone: ["read", "draft_replies"] as const,
  escalate_when: "",
  tone: "cercano" as const,
  language: "es",
  routine: "",
};

async function specialist(target = t, name = "Soporte") {
  return createNexo(target, {
    name,
    template: "support",
    questionnaire: { ...questionnaire, name, can_do_alone: [...questionnaire.can_do_alone] },
    prompt_md: renderNexoPrompt({ ...questionnaire, name, can_do_alone: [...questionnaire.can_do_alone] }),
    createdBy: null,
  });
}

beforeEach(() => resetNexoStoreForTests());

describe("nexos", () => {
  it("creates the general Nexo once and lists it first", async () => {
    const s = await specialist();
    const g1 = await ensureGeneralNexo(t);
    const g2 = await ensureGeneralNexo(t);
    expect(g1.id).toBe(g2.id);
    expect(g1.is_general).toBe(true);
    expect(g1.slug).toBe("nexo");
    const list = await listNexos(t);
    expect(list.map((n) => n.id)).toEqual([g1.id, s.id]);
  });

  it("derives settings from the questionnaire and keeps slugs unique", async () => {
    const a = await specialist();
    const b = await specialist(t, "Soporte");
    expect(a.slug).toBe("soporte");
    expect(b.slug).toBe("soporte-2");
    expect(a.autonomy).toBe("draft");
    expect(a.brain_tools).toEqual({ read: true, write: false });
    expect(a.heartbeat.enabled).toBe(false);
  });

  it("is scoped by workspace", async () => {
    const s = await specialist();
    expect(await getNexo(other, s.id)).toBeNull();
    expect(await listNexos(other)).toEqual([]);
  });

  it("refuses to delete the general Nexo and deletes a specialist with its children", async () => {
    const g = await ensureGeneralNexo(t);
    await expect(deleteNexo(t, g.id)).rejects.toMatchObject({ status: 409, code: "general_nexo" });
    await expect(deleteNexo(t, g.id)).rejects.toBeInstanceOf(NexoError);
    const s = await specialist();
    await createRun(t, { nexoId: s.id, trigger: "manual" });
    await deleteNexo(t, s.id);
    expect(await getNexo(t, s.id)).toBeNull();
    expect(await listRuns(t, { nexoId: s.id })).toEqual([]);
  });

  it("clears the heartbeat schedule when the cadence changes", async () => {
    const s = await specialist();
    await setNextHeartbeat(t, s.id, "2026-01-01T10:00:00.000Z");
    const updated = await updateNexo(t, (await getNexo(t, s.id))!, {
      heartbeat: { ...s.heartbeat, enabled: true },
    });
    expect(updated.heartbeat.enabled).toBe(true);
    expect(updated.next_heartbeat_at).toBeNull();
  });
});

describe("principal", () => {
  it("maps brain tools to scopes and acts as the agent", async () => {
    expect(scopesForBrainTools({ read: true, write: false })).toEqual(["nodes:read", "chat:run"]);
    expect(scopesForBrainTools({ read: true, write: true })).toEqual(["nodes:read", "chat:run", "nodes:write"]);
    expect(scopesForBrainTools({ read: false, write: false })).toEqual([]);
    const s = await specialist();
    expect(nexoActor(s)).toMatchObject({ kind: "agent", agentId: s.agent_id, tokenId: s.agent_id, workspaceId: t.workspaceId });
  });
});

describe("heartbeats", () => {
  it("lists due active Nexos and advances under compare-and-set", async () => {
    const s = await specialist();
    const due = "2026-01-01T10:00:00.000Z";
    await setNextHeartbeat(t, s.id, due);
    const now = new Date("2026-01-01T10:01:00.000Z");
    expect((await listDueHeartbeats({ now, backend: "demo" })).map((n) => n.id)).toEqual([s.id]);
    expect(await setNextHeartbeat(t, s.id, "2026-01-01T11:00:00.000Z", { expected: due })).toBe(true);
    // A second runner holding the stale value loses.
    expect(await setNextHeartbeat(t, s.id, "2026-01-01T11:00:00.000Z", { expected: due })).toBe(false);
    expect(await listDueHeartbeats({ now, backend: "demo" })).toEqual([]);
    await updateNexo(t, (await getNexo(t, s.id))!, { status: "paused" });
    await setNextHeartbeat(t, s.id, due);
    expect(await listDueHeartbeats({ now, backend: "demo" })).toEqual([]);
  });
});

describe("bindings", () => {
  it("binds per channel, is idempotent for the owner and refuses another Nexo", async () => {
    const a = await specialist();
    const b = await specialist(t, "Marketing");
    const install = "11111111-1111-4111-8111-111111111111";
    const first = await createBindings(t, { nexoId: a.id, installId: install, connectorId: "slack", channels: ["C1", "C2"], mode: "listen", createdBy: null });
    expect(first.map((x) => x.scope_key).sort()).toEqual(["channel:C1", "channel:C2"]);
    const again = await createBindings(t, { nexoId: a.id, installId: install, connectorId: "slack", channels: ["C1"], mode: "listen_reply", createdBy: null });
    expect(again[0]!.mode).toBe("listen_reply");
    expect((await listBindings(t, a.id)).length).toBe(2);
    await expect(
      createBindings(t, { nexoId: b.id, installId: install, connectorId: "slack", channels: ["C2", "C3"], mode: "listen", createdBy: null }),
    ).rejects.toBeInstanceOf(NexoConflictError);
    // Nothing was written for the refused request.
    expect(await listBindings(t, b.id)).toEqual([]);
    const whole = await createBindings(t, { nexoId: b.id, installId: install, connectorId: "slack", channels: [], mode: "listen", createdBy: null });
    expect(whole[0]!.scope_key).toBe("*");
    expect((await findBindingForEvent(t, install, ["channel:C1", "*"]))!.nexo_id).toBe(a.id);
    expect((await findBindingForEvent(t, install, ["channel:C9", "*"]))!.nexo_id).toBe(b.id);
    expect(await findBindingForEvent(t, "22222222-2222-4222-8222-222222222222", ["*"])).toBeNull();
  });
});

describe("runs", () => {
  it("opens, closes once and stamps last_run_at", async () => {
    const s = await specialist();
    const run = await createRun(t, { nexoId: s.id, trigger: "heartbeat", input: { why: "beat" } });
    expect(run.status).toBe("running");
    const done = await finishRun(t, run.id, { status: "skipped", output_md: "NO_REPLY" });
    expect(done).toMatchObject({ status: "skipped", output_md: "NO_REPLY" });
    expect(done!.finished_at).not.toBeNull();
    expect(await finishRun(t, run.id, { status: "failed" })).toBeNull();
    expect((await getNexo(t, s.id))!.last_run_at).toBe(done!.finished_at);
    expect(await listRuns(other)).toEqual([]);
  });
});

describe("inbox", () => {
  it("creates, counts, and resolves exactly once", async () => {
    const s = await specialist();
    const item = await createInboxItem(t, {
      nexoId: s.id,
      kind: "draft_reply",
      title: "Respuesta a cliente",
      payload: { channel: "C1", draft_text: "Hola" },
    });
    expect((await countOpenInbox(t)).get(s.id)).toBe(1);
    const resolved = await resolveInboxItem(t, item.id, { status: "edited", resolvedBy: "u1", payload: { draft_text: "Hola!" } });
    expect(resolved).toMatchObject({ status: "edited", resolved_by: "u1", payload: { channel: "C1", draft_text: "Hola!" } });
    expect(await resolveInboxItem(t, item.id, { status: "approved", resolvedBy: "u2" })).toBeNull();
    expect((await countOpenInbox(t)).get(s.id)).toBeUndefined();
    expect((await listInbox(t, { status: "edited" })).length).toBe(1);
    expect(await listInbox(t, { status: "open" })).toEqual([]);
  });
});

describe("windows", () => {
  it("collects per thread, flushes after the quiet period, and is claimed once", async () => {
    const s = await specialist();
    const base = { nexoId: s.id, bindingId: null, sourceKey: "slack:T:C1:1.0" };
    const w1 = await appendWindowEvent(t, { ...base, event: { ts: "1", author: "ana", text: "hola" }, quietSeconds: 60 });
    const w2 = await appendWindowEvent(t, { ...base, event: { ts: "2", author: "ana", text: "sigo" }, quietSeconds: 60 });
    expect(w2.id).toBe(w1.id);
    expect(w2.message_count).toBe(2);
    expect(w2.events.map((e) => e.text)).toEqual(["hola", "sigo"]);

    expect(await claimDueWindows({ backend: "demo" })).toEqual([]);
    const later = new Date(Date.now() + 61_000);
    const claimed = await claimDueWindows({ now: later, backend: "demo" });
    expect(claimed.map((w) => w.id)).toEqual([w1.id]);
    expect(claimed[0]!.state).toBe("flushing");
    expect(await claimDueWindows({ now: later, backend: "demo" })).toEqual([]);

    // A new message on the same thread opens a fresh window.
    const w3 = await appendWindowEvent(t, { ...base, event: { ts: "3", author: "ana", text: "otra" } });
    expect(w3.id).not.toBe(w1.id);

    expect(await markWindowFlushed(w1.id, { backend: "demo" })).toBe(true);
    expect(await markWindowFlushed(w1.id, { backend: "demo" })).toBe(false);
  });

  it("flushes immediately at the message cap and reclaims abandoned flushes", async () => {
    const s = await specialist();
    const base = { nexoId: s.id, bindingId: null, sourceKey: "slack:T:C2:2.0", maxMessages: 2 };
    await appendWindowEvent(t, { ...base, event: { ts: "1", author: "a", text: "x".repeat(10_000) } });
    const capped = await appendWindowEvent(t, { ...base, event: { ts: "2", author: "a", text: "y" } });
    expect(capped.events[0]!.text.length).toBe(4_000);
    const now = new Date(Date.now() + 1000);
    const [claimed] = await claimDueWindows({ now, backend: "demo" });
    expect(claimed!.id).toBe(capped.id);
    const muchLater = new Date(now.getTime() + 16 * 60_000);
    const [reclaimed] = await claimDueWindows({ now: muchLater, backend: "demo" });
    expect(reclaimed!.id).toBe(capped.id);
  });

  it("stops storing text past the ceiling while a due window waits for its flush", async () => {
    const s = await specialist();
    const base = { nexoId: s.id, bindingId: null, sourceKey: "slack:T:C3:3.0" };
    let w;
    for (let i = 0; i < 205; i++) w = await appendWindowEvent(t, { ...base, event: { ts: String(i), author: "a", text: "flood" } });
    expect(w!.message_count).toBe(205);
    expect(w!.events).toHaveLength(200);
  });
});

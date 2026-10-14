/**
 * Nexo triggers over the in-memory store: who hears an inbound message, how
 * messages pile into windows and flush once, the heartbeat clock across
 * timezones, and the guard that keeps a Nexo-owned channel from being
 * ingested twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderNexoPrompt } from "@bcontext-dev/contract/nexos";
import type { IngestCandidate } from "@bcontext-dev/contract/ingest";
import { ensureGeneralNexo } from "../general";
import { createNexo } from "../lifecycle";
import {
  claimDueWindows,
  createBindings,
  getNexo,
  listWindows,
  resetNexoStoreForTests,
  setNextHeartbeat,
  updateNexoRow,
} from "../store";
import type { NexoTarget } from "../types";
import { flushDueWindows, flushWindow, setFlushDepsForTests } from "./flush";
import {
  isWithinActiveHours,
  nextActiveInstant,
  nextHeartbeatAt,
  scheduleDueHeartbeats,
} from "./heartbeat";
import { chunkText, parseSlackSignalId, routeNangoSignalsToNexos } from "./nango-inbound";
import { isOwnBotMessage, routeInbound, type InboundMessage } from "./routing";
import { runNexoJob, setRunJobDepsForTests } from "./run-job";
import { dropOwnedMessageNodes, routeSlackEventToNexos } from "./slack-inbound";
import { acceptInbound, slackSourceKey } from "./windows";

const t: NexoTarget = { workspaceId: "ws-triggers", backend: "demo" };
const INSTALL = "11111111-1111-4111-8111-111111111111";

const questionnaire = {
  name: "Soporte",
  mission: "Atender clientes",
  sources: ["slack"],
  can_do_alone: ["read", "draft_replies"],
  escalate_when: "facturación",
  tone: "cercano" as const,
  language: "es",
  routine: "",
};

async function specialist(name = "Soporte") {
  const q = { ...questionnaire, name, can_do_alone: [...questionnaire.can_do_alone] as ("read" | "draft_replies")[] };
  return createNexo(t, { name, template: "support", questionnaire: q, prompt_md: renderNexoPrompt(q), createdBy: null });
}

async function bind(nexoId: string, channel: string, mode: "listen" | "listen_reply" = "listen_reply") {
  return createBindings(t, { nexoId, installId: INSTALL, connectorId: "slack", channels: [channel], mode, createdBy: null });
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectorId: "slack",
    installId: INSTALL,
    teamId: "T1",
    channel: "C1",
    ts: "1760000000.000100",
    user: "U_HUMAN",
    text: "hola",
    ...over,
  };
}

beforeEach(() => resetNexoStoreForTests());
afterEach(() => {
  setFlushDepsForTests(null);
  setRunJobDepsForTests(null);
});

describe("routing", () => {
  it("sends a bound channel to its owner and marks the channel owned", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const d = await routeInbound(t, msg(), { installConfig: {}, bot: { userId: "U_BOT" } });
    expect(d.kind).toBe("nexo");
    expect(d.kind === "nexo" && d.nexo.id).toBe(s.id);
    expect(d.ownsChannel).toBe(true);
  });

  it("falls back to the general Nexo only for channels the legacy path already ingests", async () => {
    const g = await ensureGeneralNexo(t);
    const open = await routeInbound(t, msg({ channel: "C9" }), { installConfig: {}, bot: {} });
    expect(open.kind === "nexo" && open.nexo.id).toBe(g.id);
    expect(open.ownsChannel).toBe(false);

    const allow = { channels: ["C2"] };
    const outside = await routeInbound(t, msg({ channel: "C9" }), { installConfig: allow, bot: {} });
    expect(outside).toMatchObject({ kind: "ignore", reason: "not_ingested" });
  });

  it("ignores our own bot (loop guard), and any bot when the identity is unknown", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const own = await routeInbound(t, msg({ user: "U_BOT", botId: "B1" }), { installConfig: {}, bot: { userId: "U_BOT" } });
    expect(own).toMatchObject({ kind: "ignore", reason: "own_bot" });
    expect(isOwnBotMessage({ botId: "B9" }, {})).toBe(true);
    expect(isOwnBotMessage({ user: "U_OTHER", botId: "B9" }, { userId: "U_BOT" })).toBe(false);
  });

  it("lets a paused owner yield the channel back to the legacy path", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    await updateNexoRow(t, s.id, { status: "paused" });
    const d = await routeInbound(t, msg(), { installConfig: {}, bot: {} });
    expect(d).toMatchObject({ kind: "ignore", reason: "owner_paused", ownsChannel: false });
  });
});

describe("windows", () => {
  it("groups a thread under one source key and enqueues a debounced fast turn for mentions", async () => {
    const s = await specialist();
    await bind(s.id, "C1", "listen_reply");
    const enqueueRun = vi.fn(async () => "job");
    const route = async (m: InboundMessage) => {
      const d = await routeInbound(t, m, { installConfig: {}, bot: { userId: "U_BOT" } });
      if (d.kind !== "nexo") throw new Error("not routed");
      return acceptInbound(t, m, d, { bot: { userId: "U_BOT" }, enqueueRun });
    };
    await route(msg({ ts: "1.000001" }));
    await route(msg({ ts: "1.000002", threadTs: "1.000001", text: "<@U_BOT> ¿me ayudas?" }));
    const r = await route(msg({ ts: "1.000003", threadTs: "1.000001", text: "<@U_BOT> ¿hola?" }));
    expect(r.window.source_key).toBe(slackSourceKey("T1", "C1", "1.000001"));
    expect(r.window.message_count).toBe(3);
    expect(enqueueRun).toHaveBeenCalledTimes(2);
    const calls = enqueueRun.mock.calls as unknown as [string, Record<string, unknown>, { singletonKey: string; startAfter: number }][];
    expect(calls[0]![2].singletonKey).toBe(calls[1]![2].singletonKey);
    expect(calls[0]![2].startAfter).toBe(2);
  });

  it("does not fast-run on a listen-only binding", async () => {
    const s = await specialist();
    await bind(s.id, "C1", "listen");
    const enqueueRun = vi.fn(async () => "job");
    const d = await routeInbound(t, msg({ text: "<@U_BOT> hola" }), { installConfig: {}, bot: { userId: "U_BOT" } });
    if (d.kind !== "nexo") throw new Error("not routed");
    const r = await acceptInbound(t, msg({ text: "<@U_BOT> hola" }), d, { bot: { userId: "U_BOT" }, enqueueRun });
    expect(r.fastRun).toBe(false);
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});

describe("flush", () => {
  function fakePipeline() {
    const candidates = new Map<string, IngestCandidate>();
    const turns: unknown[] = [];
    setFlushDepsForTests({
      extractBatch: vi.fn(async (input) => ({
        model: "test",
        skipped: 0,
        candidates: [{
          kind: "task" as const,
          title: "Responder al cliente",
          contentMd: "## Qué\nx",
          confidence: 0.9,
          evidence: [{ external_id: input.signals[0]!.external_id, excerpt: "hola" }],
        }],
      })),
      proposeCandidate: vi.fn(async (input) => {
        const c = { id: input.externalId, status: "pending", ...input } as unknown as IngestCandidate;
        candidates.set(input.externalId, c);
        return c;
      }),
      triageCandidate: vi.fn(async () => ({ kind: "accepted" as const, nodeId: "n1" })),
      runNexo: vi.fn(async (args) => {
        turns.push(args);
        return { runId: "r1", status: "succeeded" as const, output_md: "NO_REPLY" };
      }),
    });
    return { candidates, turns };
  }

  it("extracts a bound window once, runs one batch turn, and is idempotent on retry", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const { candidates, turns } = fakePipeline();
    for (const ts of ["1.000001", "1.000002"]) {
      const m = msg({ ts, threadTs: "1.000001" });
      const d = await routeInbound(t, m, { installConfig: {}, bot: {} });
      if (d.kind !== "nexo") throw new Error("not routed");
      await acceptInbound(t, m, d, { bot: {} });
    }
    const later = new Date(Date.now() + 3600_000);
    const [claimed] = await claimDueWindows({ now: later, backend: "demo" });
    expect(claimed).toBeDefined();

    const first = await flushWindow(claimed!, { backend: "demo", now: later });
    expect(first).toMatchObject({ state: "flushed", candidates: 1, accepted: 1, turn: true });
    // A retry of the same window (worker died before it noticed) proposes the same ids.
    await flushWindow(claimed!, { backend: "demo", now: later });
    expect(candidates.size).toBe(1);
    const [provenance] = [...candidates.values()].map((c) => (c as unknown as { provenance: Record<string, unknown> }).provenance);
    expect(provenance).toMatchObject({ nexo_id: s.id, extractor: "nexo_window" });
    expect((turns[0] as { trigger: string; input: { block: { messages: unknown[]; thread_ts: string } } }).trigger).toBe("batch");
    expect((turns[0] as { input: { block: { messages: unknown[]; thread_ts: string } } }).input.block.thread_ts).toBe("1.000001");

    const [stored] = await listWindows(t, { nexoId: s.id });
    expect(stored!.state).toBe("flushed");
    expect((await flushDueWindows({ now: later, backend: "demo" })).claimed).toBe(0);
  });

  it("skips the extraction of a Nexo over its monthly budget (it is billed to the Nexo)", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const { candidates, turns } = fakePipeline();
    setFlushDepsForTests({
      checkNexoBudget: vi.fn(async () => ({ ok: false as const, reason: "nexo_budget" as const, message: "x", spentUsd: 2, limitUsd: 1 })),
    });
    const m = msg({ ts: "3.000001" });
    const d = await routeInbound(t, m, { installConfig: {}, bot: {} });
    if (d.kind !== "nexo") throw new Error("not routed");
    await acceptInbound(t, m, d, { bot: {} });
    const res = await flushDueWindows({ now: new Date(Date.now() + 3600_000), backend: "demo" });
    expect(res).toMatchObject({ claimed: 1, flushed: 1, candidates: 0 });
    expect(candidates.size).toBe(0);
    // The run still happens: it is the one that skips and files the budget escalation.
    expect(turns).toHaveLength(1);
  });

  it("skips extraction for the general Nexo's fallback windows (legacy already ingests them)", async () => {
    await ensureGeneralNexo(t);
    const { candidates, turns } = fakePipeline();
    const d = await routeInbound(t, msg({ channel: "C7" }), { installConfig: {}, bot: {} });
    if (d.kind !== "nexo") throw new Error("not routed");
    await acceptInbound(t, msg({ channel: "C7" }), d, { bot: {} });
    const res = await flushDueWindows({ now: new Date(Date.now() + 3600_000), backend: "demo" });
    expect(res).toMatchObject({ claimed: 1, flushed: 1, candidates: 0 });
    expect(candidates.size).toBe(0);
    expect(turns).toHaveLength(1);
  });

  it("defers a window whose extraction fails, so the stale-claim retry picks it up", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    setFlushDepsForTests({ extractBatch: vi.fn(async () => { throw new Error("model down"); }), runNexo: vi.fn() });
    const d = await routeInbound(t, msg(), { installConfig: {}, bot: {} });
    if (d.kind !== "nexo") throw new Error("not routed");
    await acceptInbound(t, msg(), d, { bot: {} });
    const res = await flushDueWindows({ now: new Date(Date.now() + 3600_000), backend: "demo" });
    expect(res).toMatchObject({ claimed: 1, deferred: 1, flushed: 0 });
    const [w] = await listWindows(t, { nexoId: s.id });
    expect(w!.state).toBe("flushing");
  });
});

describe("double-ingest guard", () => {
  const install = { id: INSTALL, workspace_id: t.workspaceId, config: { team_id: "T1", bot_user_id: "U_BOT" } };
  const body = (channel: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "message", channel, user: "U_HUMAN", text: "hola", ts: "1.000001", ...extra } });
  const legacyNodes = (channel: string) => [
    { source: "slack", external_id: `msg:${channel}:1.000001`, kind: "doc" as const, title: "m" },
    { source: "slack", external_id: `pin:${channel}:1.000001`, kind: "doc" as const, title: "p" },
  ];

  it("drops the legacy message node of an owned channel but keeps pins", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const out = await routeSlackEventToNexos(install, body("C1"), { backend: "demo" });
    expect(out).toMatchObject({ ownedChannel: "C1", outcome: "windowed" });
    expect(dropOwnedMessageNodes(legacyNodes("C1"), out.ownedChannel).map((n) => n.external_id)).toEqual(["pin:C1:1.000001"]);
    expect((await listWindows(t, { nexoId: s.id }))).toHaveLength(1);
  });

  it("keeps legacy capture for unbound channels while the general Nexo listens", async () => {
    const g = await ensureGeneralNexo(t);
    const out = await routeSlackEventToNexos(install, body("C2"), { backend: "demo" });
    expect(out.ownedChannel).toBeNull();
    expect(dropOwnedMessageNodes(legacyNodes("C2"), out.ownedChannel)).toHaveLength(2);
    expect(await listWindows(t, { nexoId: g.id })).toHaveLength(1);
  });

  it("never windows our own bot's messages", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const out = await routeSlackEventToNexos(install, body("C1", { user: "U_BOT", bot_id: "B1" }), { backend: "demo" });
    expect(out.outcome).toBe("ignored:own_bot");
    expect(await listWindows(t, { nexoId: s.id })).toHaveLength(0);
  });

  it("splits Nango Slack signals: owned channels to the window, the rest stay legacy", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const signals = [
      { external_id: "thread:C1:1.000001", title: "a", text: "[10:00] ana: hola", at: "2026-10-10T10:00:00Z" },
      { external_id: "channel:C2:2026-10-10", title: "b", text: "[10:00] bea: hey", at: "2026-10-10T10:00:00Z" },
    ];
    const out = await routeNangoSignalsToNexos({
      workspaceId: t.workspaceId, installId: INSTALL, connectorId: "slack-nango", config: { provider: "nango" }, signals, backend: "demo",
    });
    expect(out.legacy.map((x) => x.external_id)).toEqual(["channel:C2:2026-10-10"]);
    expect(out.windowed).toBe(1);
    expect(parseSlackSignalId("channel:C2:2026-10-10")).toEqual({ channel: "C2", thread: "day-2026-10-10" });
    expect(chunkText("a\n".repeat(10), 5).every((c) => c.length <= 5)).toBe(true);
  });

  it("leaves non-Slack Nango signals untouched", async () => {
    const signals = [{ external_id: "issue:1", title: "x", text: "y" }];
    const out = await routeNangoSignalsToNexos({ workspaceId: t.workspaceId, installId: INSTALL, connectorId: "jira", config: {}, signals, backend: "demo" });
    expect(out.legacy).toBe(signals);
  });
});

describe("heartbeat", () => {
  const madrid = { start: "09:00", end: "19:00", tz: "Europe/Madrid" };

  it("reads active hours in the Nexo's timezone, including windows across midnight", () => {
    expect(isWithinActiveHours(madrid, new Date("2026-01-15T08:30:00Z"))).toBe(true); // 09:30 CET
    expect(isWithinActiveHours(madrid, new Date("2026-01-15T18:30:00Z"))).toBe(false); // 19:30 CET
    const night = { start: "22:00", end: "06:00", tz: "America/New_York" };
    expect(isWithinActiveHours(night, new Date("2026-01-15T04:00:00Z"))).toBe(true); // 23:00 EST
    expect(isWithinActiveHours(night, new Date("2026-01-15T17:00:00Z"))).toBe(false); // 12:00 EST
  });

  it("moves a beat that falls outside the hours to the next local opening, across DST", () => {
    const hb = { enabled: true, every_minutes: 60, active_hours: madrid, checklist_md: "" };
    expect(nextHeartbeatAt(hb, new Date("2026-01-15T10:00:00Z"))?.toISOString()).toBe("2026-01-15T11:00:00.000Z");
    expect(nextHeartbeatAt(hb, new Date("2026-01-15T17:30:00Z"))?.toISOString()).toBe("2026-01-16T08:00:00.000Z");
    // Spain moves to CEST on 2026-03-29: the opening is 09:00 local = 07:00Z.
    expect(nextActiveInstant(madrid, new Date("2026-03-28T21:00:00Z")).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(nextHeartbeatAt({ ...hb, enabled: false }, new Date())).toBeNull();
  });

  it("initialises, fires once per beat under the CAS, and skips paused Nexos", async () => {
    const s = await specialist();
    const paused = await specialist("Pausado");
    const hb = { enabled: true, every_minutes: 60, active_hours: { start: "00:00", end: "00:00", tz: "UTC" }, checklist_md: "- revisar" };
    await updateNexoRow(t, s.id, { heartbeat: hb });
    await updateNexoRow(t, paused.id, { heartbeat: hb, status: "paused" });
    const send = vi.fn(async () => "job");
    const now = new Date("2026-10-11T10:00:00Z");

    const init = await scheduleDueHeartbeats({ now, backend: "demo", enqueueRun: send });
    expect(init.initialised).toBe(1);
    expect((await getNexo(t, s.id))!.next_heartbeat_at).toBe("2026-10-11T11:00:00.000Z");
    expect(send).not.toHaveBeenCalled();

    const at = new Date("2026-10-11T11:00:30Z");
    const first = await scheduleDueHeartbeats({ now: at, backend: "demo", enqueueRun: send });
    const second = await scheduleDueHeartbeats({ now: at, backend: "demo", enqueueRun: send });
    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      "nexos.run",
      { nexo_id: s.id, workspace_id: t.workspaceId, trigger: "heartbeat", scheduled_for: "2026-10-11T11:00:00.000Z" },
      { singletonKey: `heartbeat:${s.id}:2026-10-11T11:00:00.000Z` },
    ]);
  });

  it("does not fire a stale beat outside the active hours, and clears a disabled heartbeat", async () => {
    const s = await specialist();
    const off = await specialist("Apagado");
    await updateNexoRow(t, s.id, { heartbeat: { enabled: true, every_minutes: 60, active_hours: { start: "09:00", end: "10:00", tz: "UTC" }, checklist_md: "" } });
    await setNextHeartbeat(t, s.id, "2026-10-11T09:30:00.000Z");
    await setNextHeartbeat(t, off.id, "2026-10-11T09:30:00.000Z");
    const send = vi.fn(async () => "job");
    const res = await scheduleDueHeartbeats({ now: new Date("2026-10-11T15:00:00Z"), backend: "demo", enqueueRun: send });
    expect(res).toMatchObject({ outside_hours: 1, cleared: 1, enqueued: 0 });
    expect((await getNexo(t, s.id))!.next_heartbeat_at).toBe("2026-10-12T09:00:00.000Z");
    expect((await getNexo(t, off.id))!.next_heartbeat_at).toBeNull();
  });
});

describe("nexos.run job", () => {
  it("builds an event turn from the thread's window and skips paused Nexos", async () => {
    const s = await specialist();
    await bind(s.id, "C1");
    const runNexo = vi.fn(async () => ({ runId: "r1", status: "succeeded" as const, output_md: "ok" }));
    setRunJobDepsForTests({ runNexo });
    const m = msg({ text: "<@U_BOT> hola" });
    const d = await routeInbound(t, m, { installConfig: {}, bot: { userId: "U_BOT" } });
    if (d.kind !== "nexo") throw new Error("not routed");
    await acceptInbound(t, m, d, { bot: { userId: "U_BOT" }, enqueueRun: async () => null });

    const sourceKey = slackSourceKey("T1", "C1", m.ts);
    const out = await runNexoJob({ nexo_id: s.id, workspace_id: t.workspaceId, trigger: "event", source_key: sourceKey, install_id: INSTALL, connector_id: "slack", channel: "C1", thread_ts: m.ts }, { backend: "demo" });
    expect(out).toMatchObject({ run_id: "r1", trigger: "event" });
    const args = (runNexo.mock.calls[0] as unknown as [{ input: { block: { messages: { text: string }[]; install_id: string } } }])[0];
    expect(args.input.block.messages.map((x) => x.text)).toEqual(["<@U_BOT> hola"]);
    expect(args.input.block.install_id).toBe(INSTALL);

    await updateNexoRow(t, s.id, { status: "paused" });
    expect(await runNexoJob({ nexo_id: s.id, trigger: "manual" }, { backend: "demo" })).toEqual({ skipped: "nexo_paused" });
    expect(await runNexoJob({ nexo_id: s.id, workspace_id: "ws-else", trigger: "manual" }, { backend: "demo" })).toEqual({ skipped: "workspace_mismatch" });
  });
});

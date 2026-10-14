/**
 * The runtime's routes on the demo backend: a manual run answers 202 with
 * its id (or the outcome with `?wait=1`), and resolving a draft through
 * `POST /api/nexos/inbox/:itemId` sends it and answers the resolved item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText,
}));
const sendNexoMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nexos/outbound", () => ({ sendNexoMessage }));

import { createWorkspace } from "@/lib/demo-store";
import { ensureGeneralNexo } from "@/lib/nexos/general";
import { createBindings, createInboxItem, getRun, resetNexoStoreForTests } from "@/lib/nexos/store";
import { POST as RUN } from "./route";
import { POST as RESOLVE } from "../../inbox/[itemId]/route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
let slug: string;
let workspaceId: string;
beforeEach(() => {
  resetNexoStoreForTests();
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
  generateText.mockReset().mockResolvedValue({ text: "Revisado.", steps: [{}], totalUsage: { inputTokens: 1, outputTokens: 1 } });
  sendNexoMessage.mockReset().mockResolvedValue({ ok: true, ts: "5.5" });
  const ws = createWorkspace({ name: "Run", slug: `run-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  slug = ws.slug;
  workspaceId = ws.id;
});

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });

describe("POST /api/nexos/:id/run", () => {
  it("waits for the outcome with ?wait=1", async () => {
    const n = await ensureGeneralNexo({ workspaceId, backend: "demo" });
    const res = await RUN(post(`/api/nexos/${n.id}/run?workspace=${slug}&wait=1`, { instruction: "Revisa" }), {
      params: Promise.resolve({ id: n.id }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { run_id: string; status: string; output_md: string };
    expect(out).toMatchObject({ status: "succeeded", output_md: "Revisado." });
    expect(await getRun({ workspaceId, backend: "demo" }, out.run_id)).toMatchObject({ trigger: "manual", status: "succeeded" });
  });

  it("answers 202 with the run id by default", async () => {
    const n = await ensureGeneralNexo({ workspaceId, backend: "demo" });
    const res = await RUN(post(`/api/nexos/${n.id}/run?workspace=${slug}`, {}), { params: Promise.resolve({ id: n.id }) });
    expect(res.status).toBe(202);
    const out = (await res.json()) as { run_id: string; status: string };
    expect(out.status).toBe("running");
    await vi.waitFor(async () =>
      expect((await getRun({ workspaceId, backend: "demo" }, out.run_id))?.status).toBe("succeeded"),
    );
  });

  it("rejects an unknown body field", async () => {
    const n = await ensureGeneralNexo({ workspaceId, backend: "demo" });
    const res = await RUN(post(`/api/nexos/${n.id}/run?workspace=${slug}`, { nope: 1 }), { params: Promise.resolve({ id: n.id }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/nexos/inbox/:itemId", () => {
  it("approves a draft by sending it", async () => {
    const t = { workspaceId, backend: "demo" as const };
    const n = await ensureGeneralNexo(t);
    // A draft is only sent while the Nexo still replies on that channel.
    await createBindings(t, { nexoId: n.id, installId: "i1", connectorId: "slack", channels: ["C1"], mode: "listen_reply", createdBy: null });
    const item = await createInboxItem(t, {
      nexoId: n.id,
      kind: "draft_reply",
      title: "Respuesta",
      payload: { install_id: "i1", channel: "C1", draft_text: "Hola" },
    });
    const res = await RESOLVE(post(`/api/nexos/inbox/${item.id}?workspace=${slug}`, { action: "approve" }), {
      params: Promise.resolve({ itemId: item.id }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { status: string } }).item.status).toBe("approved");
    expect(sendNexoMessage).toHaveBeenCalledWith(expect.objectContaining({ installId: "i1", channel: "C1", text: "Hola" }));

    const again = await RESOLVE(post(`/api/nexos/inbox/${item.id}?workspace=${slug}`, { action: "approve" }), {
      params: Promise.resolve({ itemId: item.id }),
    });
    expect(again.status).toBe(409);
  });

  it("404s an unknown item and 400s an edit without text", async () => {
    const missing = await RESOLVE(post(`/api/nexos/inbox/nope?workspace=${slug}`, { action: "done" }), {
      params: Promise.resolve({ itemId: "nope" }),
    });
    expect(missing.status).toBe(404);
    const bad = await RESOLVE(post(`/api/nexos/inbox/nope?workspace=${slug}`, { action: "edit" }), {
      params: Promise.resolve({ itemId: "nope" }),
    });
    expect(bad.status).toBe(400);
  });
});

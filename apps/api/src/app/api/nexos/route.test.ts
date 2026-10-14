/**
 * `/api/nexos/*` on the demo backend: the general Nexo appears on first read
 * and cannot be deleted, a specialist goes through create → detail → patch →
 * bindings → delete, and a caller whose grant only reads is refused every
 * write with the verb it lacked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/lib/auth/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace")>();
  return {
    ...actual,
    openWorkspace: async (...args: Parameters<typeof actual.openWorkspace>) => {
      const verb = args[2];
      if (gate.readOnly && verb !== "read") return Response.json({ error: "forbidden", verb }, { status: 403 });
      return actual.openWorkspace(...args);
    },
  };
});

import { createWorkspace } from "@/lib/demo-store";
import { resetNexoStoreForTests } from "@/lib/nexos/store";
import { GET as LIST, POST as CREATE } from "./route";
import { DELETE, GET as DETAIL, PATCH } from "./[id]/route";
import { POST as PROMPT } from "./[id]/prompt/route";
import { GET as BINDINGS, POST as BIND } from "./[id]/bindings/route";
import { DELETE as UNBIND } from "./[id]/bindings/[bindingId]/route";
import { GET as TOOLS, PUT as SET_TOOLS } from "./[id]/tools/route";
import { GET as RUNS } from "./[id]/runs/route";
import { GET as SESSIONS } from "./[id]/sessions/route";
import { GET as INBOX } from "./inbox/route";
import { GET as CHANNELS } from "./channels/route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
function req(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const questionnaire = {
  name: "Soporte",
  mission: "Atender las preguntas de clientes en Slack.",
  sources: ["slack"],
  can_do_alone: ["read", "summarize", "draft_replies"],
  escalate_when: "Un cliente se queja de facturación.",
  tone: "cercano",
  language: "es",
  routine: "",
};

let slug: string;
beforeEach(() => {
  gate.readOnly = false;
  resetNexoStoreForTests();
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  slug = createWorkspace({ name: "Nexos", slug: `nexos-${Date.now()}-${Math.random().toString(36).slice(2)}` }).slug;
});

async function create(name = "Soporte") {
  const res = await CREATE(req(`/api/nexos?workspace=${slug}`, "POST", { template: "support", questionnaire: { ...questionnaire, name } }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { nexo: { id: string; slug: string; prompt_md: string } }).nexo;
}

describe("/api/nexos", () => {
  it("lists the general Nexo first, created on first read", async () => {
    const res = await LIST(req(`/api/nexos?workspace=${slug}`));
    expect(res.status).toBe(200);
    const { nexos } = (await res.json()) as { nexos: Array<{ is_general: boolean; open_inbox_count: number; integrations: string[] }> };
    expect(nexos).toHaveLength(1);
    expect(nexos[0]).toMatchObject({ is_general: true, open_inbox_count: 0, integrations: [] });
    const again = (await (await LIST(req(`/api/nexos?workspace=${slug}`))).json()) as { nexos: unknown[] };
    expect(again.nexos).toHaveLength(1);
  });

  it("previews without creating, then creates with the generated prompt", async () => {
    const preview = await CREATE(req(`/api/nexos?workspace=${slug}`, "POST", { template: "support", questionnaire, preview: true }));
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { prompt_md: string; source: string };
    expect(body.source).toBe("template");
    expect(body.prompt_md).toContain("## Cuándo avisar");

    const nexo = await create();
    expect(nexo.slug).toBe("soporte");
    expect(nexo.prompt_md).toBe(body.prompt_md);
    const { nexos } = (await (await LIST(req(`/api/nexos?workspace=${slug}`))).json()) as { nexos: Array<{ id: string }> };
    expect(nexos.map((n) => n.id)).toContain(nexo.id);
  });

  it("turns the heartbeat on for a routine, in the sent timezone, unless the body says otherwise", async () => {
    type Created = { nexo: { heartbeat: { enabled: boolean; every_minutes: number; checklist_md: string; active_hours: { start: string; end: string; tz: string } }; escalation: { notify_user_ids: string[]; via: string[] } } };
    const post = (body: Record<string, unknown>) => CREATE(req(`/api/nexos?workspace=${slug}`, "POST", { template: "support", ...body }));

    const quiet = (await (await post({ questionnaire: { ...questionnaire, name: "Sin rutina" } })).json()) as Created;
    expect(quiet.nexo.heartbeat.enabled).toBe(false);
    // The demo backend has no person behind the request: nobody to notify yet.
    expect(quiet.nexo.escalation).toEqual({ notify_user_ids: [], via: ["inbox"] });

    const routine = "Revisar hilos sin respuesta.";
    const on = await post({ questionnaire: { ...questionnaire, name: "Con rutina", routine }, heartbeat: { active_hours: { tz: "Europe/Madrid" } } });
    expect(on.status).toBe(201);
    expect(((await on.json()) as Created).nexo.heartbeat).toEqual({
      enabled: true,
      every_minutes: 60,
      active_hours: { start: "09:00", end: "19:00", tz: "Europe/Madrid" },
      checklist_md: routine,
    });

    const off = (await (await post({ questionnaire: { ...questionnaire, name: "Apagado", routine }, heartbeat: { enabled: false, every_minutes: 30 } })).json()) as Created;
    expect(off.nexo.heartbeat).toMatchObject({ enabled: false, every_minutes: 30, active_hours: { tz: "UTC" } });

    expect((await post({ questionnaire, heartbeat: { active_hours: { tz: "Mars/Olympus" } } })).status).toBe(400);
  });

  it("validates the body", async () => {
    const res = await CREATE(req(`/api/nexos?workspace=${slug}`, "POST", { template: "support", questionnaire: { name: "" } }));
    expect(res.status).toBe(400);
  });

  it("answers detail, patch, prompt, tools, runs, sessions and inbox", async () => {
    const nexo = await create();
    const detail = await DETAIL(req(`/api/nexos/${nexo.id}?workspace=${slug}`), params({ id: nexo.id }));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ nexo: { id: nexo.id }, bindings: [], recent_runs: [], open_inbox_count: 0, tools: { grants: [] } });

    const patched = await PATCH(req(`/api/nexos/${nexo.id}?workspace=${slug}`, "PATCH", { autonomy: "act", status: "paused" }), params({ id: nexo.id }));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ nexo: { autonomy: "act", status: "paused" } });

    const prompt = await PROMPT(req(`/api/nexos/${nexo.id}/prompt?workspace=${slug}`, "POST"), params({ id: nexo.id }));
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toMatchObject({ source: "template" });

    const tools = await SET_TOOLS(req(`/api/nexos/${nexo.id}/tools?workspace=${slug}`, "PUT", { brain_tools: { read: true, write: true } }), params({ id: nexo.id }));
    expect(tools.status).toBe(200);
    expect(await tools.json()).toMatchObject({ tools: { brain_tools: { read: true, write: true } } });
    const caps = await SET_TOOLS(
      req(`/api/nexos/${nexo.id}/tools?workspace=${slug}`, "PUT", { capability_ids: ["11111111-1111-4111-8111-111111111111"] }),
      params({ id: nexo.id }),
    );
    expect(caps.status).toBe(400);
    expect((await TOOLS(req(`/api/nexos/${nexo.id}/tools?workspace=${slug}`), params({ id: nexo.id }))).status).toBe(200);

    expect(await (await RUNS(req(`/api/nexos/${nexo.id}/runs?workspace=${slug}`), params({ id: nexo.id }))).json()).toEqual({ runs: [] });
    expect(await (await SESSIONS(req(`/api/nexos/${nexo.id}/sessions?workspace=${slug}`), params({ id: nexo.id }))).json()).toEqual({ sessions: [] });
    expect(await (await INBOX(req(`/api/nexos/inbox?workspace=${slug}&nexo_id=${nexo.id}`))).json()).toEqual({ items: [] });
    expect((await INBOX(req(`/api/nexos/inbox?workspace=${slug}&status=weird`))).status).toBe(400);
  });

  it("404s a Nexo of another workspace", async () => {
    const nexo = await create();
    const elsewhere = createWorkspace({ name: "Other", slug: `other-${Date.now()}-${Math.random().toString(36).slice(2)}` }).slug;
    const res = await DETAIL(req(`/api/nexos/${nexo.id}?workspace=${elsewhere}`), params({ id: nexo.id }));
    expect(res.status).toBe(404);
  });

  it("binds channels with one owner each and unbinds", async () => {
    const a = await create("Soporte");
    const b = await create("Ventas");
    const install = "22222222-2222-4222-8222-222222222222";
    const bound = await BIND(req(`/api/nexos/${a.id}/bindings?workspace=${slug}`, "POST", { install_id: install, channels: ["C1"], mode: "listen_reply" }), params({ id: a.id }));
    expect(bound.status).toBe(201);
    const { bindings } = (await bound.json()) as { bindings: Array<{ id: string; scope_key: string }> };
    expect(bindings[0]!.scope_key).toBe("channel:C1");

    const clash = await BIND(req(`/api/nexos/${b.id}/bindings?workspace=${slug}`, "POST", { install_id: install, channels: ["C1"] }), params({ id: b.id }));
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ error: "scope_owned" });

    const listed = (await (await BINDINGS(req(`/api/nexos/${a.id}/bindings?workspace=${slug}`), params({ id: a.id }))).json()) as { bindings: unknown[] };
    expect(listed.bindings).toHaveLength(1);
    const cards = (await (await LIST(req(`/api/nexos?workspace=${slug}`))).json()) as {
      nexos: Array<{ id: string; integrations: string[]; bindings: Array<{ install_id: string; scope_key: string }> }>;
    };
    const card = cards.nexos.find((n) => n.id === a.id)!;
    expect(card.bindings).toEqual([{ install_id: install, connector_id: "demo", scope_key: "channel:C1" }]);
    expect(card.integrations).toEqual(["demo"]);
    expect(cards.nexos.find((n) => n.id === b.id)!.bindings).toEqual([]);
    const gone = await UNBIND(req(`/api/nexos/${a.id}/bindings/${bindings[0]!.id}?workspace=${slug}`, "DELETE"), params({ id: a.id, bindingId: bindings[0]!.id }));
    expect(gone.status).toBe(200);
    const again = await UNBIND(req(`/api/nexos/${a.id}/bindings/${bindings[0]!.id}?workspace=${slug}`, "DELETE"), params({ id: a.id, bindingId: bindings[0]!.id }));
    expect(again.status).toBe(404);
  });

  it("channels: requires install_id and is unsupported on the demo backend", async () => {
    const missing = await CHANNELS(req(`/api/nexos/channels?workspace=${slug}`));
    expect(missing.status).toBe(400);
    const demo = await CHANNELS(req(`/api/nexos/channels?workspace=${slug}&install_id=22222222-2222-4222-8222-222222222222`));
    expect(demo.status).toBe(400);
    expect(await demo.json()).toMatchObject({ error: "unsupported" });
  });

  it("refuses to delete the general Nexo with 409 and deletes a specialist", async () => {
    const { nexos } = (await (await LIST(req(`/api/nexos?workspace=${slug}`))).json()) as { nexos: Array<{ id: string }> };
    const general = nexos[0]!;
    const refused = await DELETE(req(`/api/nexos/${general.id}?workspace=${slug}`, "DELETE"), params({ id: general.id }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "general_nexo" });

    const nexo = await create();
    const deleted = await DELETE(req(`/api/nexos/${nexo.id}?workspace=${slug}`, "DELETE"), params({ id: nexo.id }));
    expect(deleted.status).toBe(200);
    expect((await DETAIL(req(`/api/nexos/${nexo.id}?workspace=${slug}`), params({ id: nexo.id }))).status).toBe(404);
  });

  it("refuses every write to a read-only grant but still reads", async () => {
    const nexo = await create();
    gate.readOnly = true;
    expect((await LIST(req(`/api/nexos?workspace=${slug}`))).status).toBe(200);
    const denied = await CREATE(req(`/api/nexos?workspace=${slug}`, "POST", { template: "custom", questionnaire }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "forbidden", verb: "write" });
    expect((await PATCH(req(`/api/nexos/${nexo.id}?workspace=${slug}`, "PATCH", { autonomy: "act" }), params({ id: nexo.id }))).status).toBe(403);
    expect((await DELETE(req(`/api/nexos/${nexo.id}?workspace=${slug}`, "DELETE"), params({ id: nexo.id }))).status).toBe(403);
    const tools = await SET_TOOLS(req(`/api/nexos/${nexo.id}/tools?workspace=${slug}`, "PUT", {}), params({ id: nexo.id }));
    expect(tools.status).toBe(403);
    expect(await tools.json()).toMatchObject({ verb: "admin" });
  });
});

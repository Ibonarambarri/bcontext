import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The digest route over a demo workspace: GET answers the defaults, PUT
 * needs Supabase (there is no clock in the demo store), POST publishes now
 * and is the sales demo. Supabase settings are exercised in
 * `src/lib/skills/schedules.test.ts`; here the settings functions are mocks.
 */
const state: { ctx: unknown } = { ctx: null };
const mocks = vi.hoisted(() => ({
  getDigestSettings: vi.fn(async () => ({ enabled: true, cron: "0 9 * * 1", timezone: "UTC", delivery: { webhook: false, email: false }, last_run_at: null, next_run_at: "2026-09-14T09:00:00.000Z" })),
  upsertDigestSettings: vi.fn(async (_admin: unknown, _ws: string, patch: Record<string, unknown>) => ({ enabled: true, cron: "0 9 * * 1", timezone: "UTC", delivery: { webhook: false, email: false }, last_run_at: null, next_run_at: null, ...patch })),
}));

vi.mock("@/lib/auth/workspace", () => ({ openWorkspace: async () => state.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ marker: "admin" }) }));
vi.mock("@/lib/skills/schedules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/skills/schedules")>()),
  getDigestSettings: mocks.getDigestSettings,
  upsertDigestSettings: mocks.upsertDigestSettings,
}));

import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET, POST, PUT } from "./route";

const workspace = createWorkspace({ name: "Digest route", slug: `digest-route-${Date.now()}` });
const storage = resolveDemoStorage(workspace.slug)!;
const demoCtx = () => ({ actor: { kind: "demo" }, storage });
const supabaseCtx = () => ({ actor: { kind: "user", userId: "u1" }, storage: { backend: "supabase", workspace: { id: "ws-1", slug: "acme" } } });

function call(handler: typeof GET, method: string, body?: unknown) {
  return handler(
    new Request(`http://localhost/api/workspaces/${workspace.slug}/digest`, {
      method,
      headers: { origin: "http://localhost", host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ ws: workspace.slug }) },
  );
}

afterEach(() => {
  state.ctx = demoCtx();
  mocks.getDigestSettings.mockClear();
  mocks.upsertDigestSettings.mockClear();
});

describe("/api/workspaces/:ws/digest", () => {
  it("returns the gate's answer untouched", async () => {
    state.ctx = Response.json({ error: "workspace not found" }, { status: 404 });
    expect((await call(GET, "GET")).status).toBe(404);
    expect((await call(POST, "POST")).status).toBe(404);
  });

  it("GET answers the defaults on the demo store and the stored settings on Supabase", async () => {
    state.ctx = demoCtx();
    const demo = await call(GET, "GET");
    expect(demo.status).toBe(200);
    expect(await demo.json()).toMatchObject({ digest: { enabled: false, cron: "0 9 * * 1", timezone: "UTC" }, backend: "demo" });

    state.ctx = supabaseCtx();
    const stored = await call(GET, "GET");
    expect(await stored.json()).toMatchObject({ digest: { enabled: true, next_run_at: "2026-09-14T09:00:00.000Z" } });
    expect(mocks.getDigestSettings).toHaveBeenCalledWith({ marker: "admin" }, "ws-1");
  });

  it("PUT validates, refuses the demo store, and writes the settings on Supabase as the signed-in user", async () => {
    state.ctx = demoCtx();
    expect((await call(PUT, "PUT", { enabled: "yes" })).status).toBe(400);
    expect((await call(PUT, "PUT", { nope: true })).status).toBe(400);
    const demo = await call(PUT, "PUT", { enabled: true });
    expect(demo.status).toBe(400);
    expect(await demo.json()).toMatchObject({ error: "unsupported" });

    state.ctx = supabaseCtx();
    const res = await call(PUT, "PUT", { enabled: true, timezone: "Europe/Madrid", delivery: { email: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ digest: { enabled: true, timezone: "Europe/Madrid" } });
    expect(mocks.upsertDigestSettings).toHaveBeenCalledWith({ marker: "admin" }, "ws-1", { enabled: true, timezone: "Europe/Madrid", delivery: { email: true } }, { createdBy: "u1" });
  });

  it("PUT surfaces a cron the settings layer rejects as a 400 on that field", async () => {
    state.ctx = supabaseCtx();
    const { DigestSettingsError } = await import("@/lib/skills/schedules");
    mocks.upsertDigestSettings.mockRejectedValueOnce(new DigestSettingsError("bad cron", "cron"));
    const res = await call(PUT, "PUT", { cron: "every monday" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body", field: "cron" });
  });

  it("POST publishes a digest now, then refreshes it on a second call", async () => {
    state.ctx = demoCtx();
    await storage.createNode({ title: "Open task", kind: "task", parent_id: null, status: "todo" });
    const first = await call(POST, "POST");
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body.created).toBe(true);
    expect(body.node).toMatchObject({ kind: "doc", data: { source: "nexo.digest" } });
    expect(body.node.title).toMatch(/^Digest semanal \d{4}-\d{2}-\d{2}$/);
    expect(body.facts).toMatchObject({ startable: 1 });

    const second = await call(POST, "POST", { days: 14 });
    expect(second.status).toBe(200);
    expect((await second.json()).created).toBe(false);

    expect((await call(POST, "POST", { days: 0 })).status).toBe(400);
  });
});

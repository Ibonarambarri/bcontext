import { afterEach, describe, expect, it, vi } from "vitest";

const state: {
  gate: unknown;
  storage: unknown;
  grant: unknown;
} = { gate: null, storage: null, grant: null };

vi.mock("./require", () => ({
  gate: async () => state.gate,
}));
vi.mock("@/lib/storage", () => ({
  getStorage: async () => state.storage,
  getStorageById: async () => state.storage,
}));
vi.mock("./grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grants")>();
  return { ...actual, resolveGrant: async () => state.grant };
});
vi.mock("@/lib/storage/scoped", () => ({
  scopedStorage: (inner: unknown) => ({ ...(inner as object), __scoped: true }),
}));

import { openWorkspace, openWorkspaceById, openWorkspaceForActor } from "./workspace";

const req = {} as Request;
const actor = { kind: "user", userId: "u1" };
const inner = { backend: "supabase", workspace: { id: "ws-1", slug: "ws" } };

const grantWith = (verbs: string[]) => ({
  workspaceId: "ws-1",
  principal: { kind: "user", id: "u1" },
  verbs,
  reach: { type: "all" },
});

afterEach(() => {
  state.gate = actor;
  state.storage = inner;
  state.grant = grantWith(["read", "write"]);
});

describe("openWorkspace", () => {
  it("returns a scoped storage, never the raw one", async () => {
    // The point of the helper: a route cannot end up holding an unscoped
    // storage by forgetting a step.
    state.gate = actor;
    state.storage = inner;
    state.grant = grantWith(["read"]);
    const ctx = await openWorkspace(req, "ws", "read");
    expect(ctx).not.toBeInstanceOf(Response);
    if (!(ctx instanceof Response)) {
      expect((ctx.storage as unknown as { __scoped: boolean }).__scoped).toBe(true);
    }
  });

  it("404s a workspace with no grant, rather than 403", async () => {
    // A 403 confirms the workspace exists. "If you were only given one
    // workspace, that is the only one that exists for you" is not enforceable
    // if the error distinguishes the two cases.
    state.gate = actor;
    state.storage = inner;
    state.grant = { denied: "not_found" };
    const res = await openWorkspace(req, "ws", "read");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
  });

  it("404s a workspace that does not exist, identically", async () => {
    state.gate = actor;
    state.storage = null;
    const res = (await openWorkspace(req, "ws", "read")) as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workspace not found" });
  });

  it("403s when the grant exists but lacks the verb", async () => {
    // Here 403 is right: they already know the workspace is there.
    state.gate = actor;
    state.storage = inner;
    state.grant = grantWith(["read"]);
    const res = (await openWorkspace(req, "ws", "delete")) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden", verb: "delete" });
  });

  it("400s without a workspace slug", async () => {
    const res = (await openWorkspace(req, null, "read")) as Response;
    expect(res.status).toBe(400);
  });

  it("passes the gate's response straight through", async () => {
    // An expired token must surface as the gate wrote it, with its
    // WWW-Authenticate intact, not repackaged as a 404.
    state.gate = Response.json({ error: "invalid_token" }, { status: 401 });
    const res = (await openWorkspace(req, "ws", "read")) as Response;
    expect(res.status).toBe(401);
  });
});

describe("the demo backend keeps working", () => {
  it("does not 404 when there is no Supabase behind it", async () => {
    // `gate` hands back a `demo` actor outside production and `resolveGrant`
    // denies that actor by design, so without a carve-out every request in dev
    // would 404 — including the documented "runs without Supabase" path. The
    // old boundary skipped membership entirely for a non-Supabase backend; this
    // mirrors it.
    state.gate = { kind: "demo" };
    state.storage = { backend: "demo", workspace: { id: "demo", slug: "demo" } };
    state.grant = { denied: "not_found" };
    const ctx = await openWorkspace(req, "demo", "write");
    expect(ctx).not.toBeInstanceOf(Response);
  });

  it("hands the demo backend an unscoped storage", async () => {
    // There is no tenant data to protect in an in-memory store, and wrapping it
    // would make the demo path behave differently from what it documents.
    state.gate = { kind: "demo" };
    state.storage = { backend: "demo", workspace: { id: "demo", slug: "demo" } };
    const ctx = await openWorkspace(req, "demo", "read");
    if (!(ctx instanceof Response)) {
      expect((ctx.storage as unknown as { __scoped?: boolean }).__scoped).toBeUndefined();
    }
  });

  it("still denies a demo actor against a real Supabase workspace", async () => {
    // The carve-out is about the backend, not the actor. A demo actor pointed at
    // real tenant data must still be turned away.
    state.gate = { kind: "demo" };
    state.storage = inner;
    state.grant = { denied: "not_found" };
    const res = (await openWorkspace(req, "ws", "read")) as Response;
    expect(res.status).toBe(404);
  });
});

describe("openWorkspaceById", () => {
  it("resolves a workspace addressed by uuid", async () => {
    // Six routes take the workspace id from the request body and have no slug to
    // resolve. Without this they would need an exemption that is not true.
    state.gate = actor;
    state.storage = inner;
    state.grant = grantWith(["read"]);
    const ctx = await openWorkspaceById(req, "ws-1", "read");
    expect(ctx).not.toBeInstanceOf(Response);
  });

  it("400s without an id", async () => {
    const res = (await openWorkspaceById(req, null, "read")) as Response;
    expect(res.status).toBe(400);
  });
});

describe("scope: null", () => {
  it("demands no scope for routes that demand none today", async () => {
    // Adding a scope requirement is observable for existing agent tokens. This
    // change adds reach; tightening scopes is a separate decision.
    state.gate = actor;
    state.storage = inner;
    state.grant = grantWith(["read"]);
    const ctx = await openWorkspace(req, "ws", "read", { scope: null });
    expect(ctx).not.toBeInstanceOf(Response);
  });
});

describe("openWorkspaceForActor", () => {
  it("authorises an already-authenticated actor without gating again", async () => {
    // For routes whose workspace only appears after parsing the body. Gating
    // twice would charge two rate-limit tokens per request; parsing before
    // authenticating would let an anonymous caller make the server read
    // megabytes. Splitting the two avoids both.
    state.storage = inner;
    state.grant = grantWith(["read", "write"]);
    const ctx = await openWorkspaceForActor(actor as never, "ws", "write");
    expect(ctx).not.toBeInstanceOf(Response);
  });

  it("still 404s a workspace the actor has no grant for", async () => {
    state.storage = inner;
    state.grant = { denied: "not_found" };
    const res = (await openWorkspaceForActor(actor as never, "ws", "write")) as Response;
    expect(res.status).toBe(404);
  });

  it("still enforces the verb", async () => {
    state.storage = inner;
    state.grant = grantWith(["read"]);
    const res = (await openWorkspaceForActor(actor as never, "ws", "delete")) as Response;
    expect(res.status).toBe(403);
  });
});

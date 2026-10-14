import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the consent screen may know about a client: enough to name it and
 * check its redirect_uri, nothing that identifies the registrant or could
 * be replayed. Revoked reads as unknown.
 */
const state: { row: Record<string, unknown> | null; configured: boolean } = { row: null, configured: true };

vi.mock("@/lib/auth/require", () => ({
  gate: async () => ({ kind: "user", userId: "u1" }),
}));
vi.mock("@bcontext-dev/contract/env", () => ({
  isSupabaseConfigured: () => state.configured,
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.row }) }),
      }),
    }),
  }),
}));

import { GET } from "./route";

const get = () =>
  GET(new Request("http://localhost/api/oauth/clients/c1"), { params: Promise.resolve({ clientId: "c1" }) });

const registered = {
  client_id: "c1",
  client_secret_hash: "sha256:never",
  client_name: "Claude Desktop",
  redirect_uris: ["http://127.0.0.1:9999/cb"],
  scope: "nodes:read nodes:write",
  client_uri: "https://claude.ai",
  logo_uri: null,
  registered_by: "u-registrant",
  revoked_at: null,
};

afterEach(() => {
  state.row = null;
  state.configured = true;
});

describe("GET /api/oauth/clients/:clientId", () => {
  it("404s an unknown client", async () => {
    state.row = null;
    expect((await get()).status).toBe(404);
  });

  it("404s a revoked client identically", async () => {
    state.row = { ...registered, revoked_at: "2026-01-01T00:00:00.000Z" };
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("404s when there is no registry at all", async () => {
    state.configured = false;
    state.row = registered;
    expect((await get()).status).toBe(404);
  });

  it("returns the consent screen's fields and no more", async () => {
    state.row = registered;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      client: {
        client_id: "c1",
        client_name: "Claude Desktop",
        redirect_uris: ["http://127.0.0.1:9999/cb"],
        scope: "nodes:read nodes:write",
        client_uri: "https://claude.ai",
        logo_uri: null,
      },
    });
  });
});

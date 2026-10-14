import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/me` is the web side's only way to ask "is this person a platform
 * admin" now that the allowlist stays on the API. Session-cookie only: an
 * anonymous caller is a 401 even in development, where the gate's escape
 * hatch would otherwise let a demo actor through.
 */
let sessionUser:
  | { id: string; email: string; user_metadata?: Record<string, unknown> }
  | null = null;

vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => {
    throw new Error("no admin client in this test");
  },
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET } from "./route";

const request = () =>
  new Request("http://localhost/api/me", { headers: { origin: "http://localhost", host: "localhost" } });

afterEach(() => {
  sessionUser = null;
  delete process.env.ADMIN_EMAILS;
  delete process.env.ORG_CREATION;
});

describe("GET /api/me", () => {
  it("is a 401 without a session", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it("answers the person and a false is_admin for everyone else", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: "u-1",
        email: "ana@example.com",
        first_name: null,
        last_name: null,
        full_name: null,
      },
      is_admin: false,
      has_password: true,
      can_create_organization: true,
    });
  });

  it("keeps organization creation to admins when ORG_CREATION=admin", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    process.env.ORG_CREATION = "admin";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    const ana = (await (await GET(request())).json()) as { can_create_organization: boolean };
    expect(ana.can_create_organization).toBe(false);
    sessionUser = { id: "u-2", email: "root@example.com" };
    const root = (await (await GET(request())).json()) as { can_create_organization: boolean };
    expect(root.can_create_organization).toBe(true);
  });

  it("carries the name the person gave, joined for display", async () => {
    sessionUser = {
      id: "u-3",
      email: "ana@example.com",
      user_metadata: { first_name: "Ana", last_name: "Ruiz" },
    };
    const body = (await (await GET(request())).json()) as {
      user: { first_name: string; last_name: string; full_name: string };
    };
    expect(body.user).toMatchObject({
      first_name: "Ana",
      last_name: "Ruiz",
      full_name: "Ana Ruiz",
    });
  });

  it("recognises the allowlist, case-insensitively", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-2", email: "Root@Example.com" };
    const res = await GET(request());
    expect((await res.json()).is_admin).toBe(true);
  });
});

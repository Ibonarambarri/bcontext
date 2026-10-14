import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The one door into account creation while signup is closed. It opens for a
 * live token and nothing else; the address comes from the invitation, never
 * from the body, so the token cannot be used to create an account for
 * someone it was not sent to.
 */
const state: {
  invite: unknown;
  userState: Array<{ state: string; user_id?: string }>;
  created: unknown[];
  deleted: string[];
} = { invite: null, userState: [], created: [], deleted: [] };

vi.mock("@/lib/auth/require", () => ({
  gate: async () => ({ kind: "demo" }),
}));
vi.mock("@/lib/workspaces/orgs", () => ({
  findInviteByToken: async () => state.invite,
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    rpc: async () => ({ data: state.userState, error: null }),
    auth: {
      admin: {
        createUser: async (input: unknown) => {
          state.created.push(input);
          return { error: null };
        },
        deleteUser: async (id: string) => {
          state.deleted.push(id);
          return { error: null };
        },
      },
    },
  }),
}));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/invites/tok/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token: "tok" }) },
  );

afterEach(() => {
  state.invite = { email: "ana@example.com", role: "editor" };
  state.userState = [];
  state.created = [];
  state.deleted = [];
});

describe("POST /api/invites/:token/signup", () => {
  it("404s without a live invitation, before reading the body", async () => {
    state.invite = null;
    expect((await post({ password: "hunter22" })).status).toBe(404);
    expect(state.created).toEqual([]);
  });

  it("holds the password floor", async () => {
    state.invite = { email: "ana@example.com" };
    const res = await post({ password: "short" });
    expect(res.status).toBe(400);
    expect(state.created).toEqual([]);
  });

  it("creates the account for the invited address, confirmed and marked complete", async () => {
    state.invite = { email: "ana@example.com" };
    const res = await post({ password: "hunter22", email: "mallory@example.com" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ email: "ana@example.com" });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      email: "ana@example.com",
      password: "hunter22",
      email_confirm: true,
      user_metadata: { signup_complete: true, source: "workspace_invite" },
    });
  });

  it("sends an existing account to sign in instead", async () => {
    state.invite = { email: "ana@example.com" };
    state.userState = [{ state: "confirmed", user_id: "u-old" }];
    const res = await post({ password: "hunter22" });
    expect(res.status).toBe(409);
    expect(state.created).toEqual([]);
    expect(state.deleted).toEqual([]);
  });

  it("clears a half-built row from an older invite first", async () => {
    state.invite = { email: "ana@example.com" };
    state.userState = [{ state: "pending", user_id: "u-half" }];
    const res = await post({ password: "hunter22" });
    expect(res.status).toBe(201);
    expect(state.deleted).toEqual(["u-half"]);
    expect(state.created).toHaveLength(1);
  });
});

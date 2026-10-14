import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Changing a password is a change, not a reset: the current one is the proof
 * of presence. What matters here is that a wrong one never reaches the write,
 * and that the verification sign-in leaves nothing behind.
 */
let sessionUser: { id: string; email: string } | null = null;
let authUser: Record<string, unknown> | null = null;
const signIn = vi.fn(async (_: { email: string; password: string }) => ({
  error: null as { message: string } | null,
}));
const signOut = vi.fn(async () => ({ error: null }));
const updateUserById = vi.fn(async () => ({ data: { user: authUser }, error: null }));

vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: authUser } }),
        updateUserById,
      },
    },
  }),
}));
vi.mock("@/lib/supabase/anon", () => ({
  getSupabaseAnon: () => ({ auth: { signInWithPassword: signIn, signOut } }),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "./route";

const request = (body: unknown) =>
  new Request("http://localhost/api/me/password", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      host: "localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

afterEach(() => {
  sessionUser = null;
  authUser = null;
  signIn.mockClear();
  signIn.mockImplementation(async () => ({ error: null }));
  signOut.mockClear();
  updateUserById.mockClear();
});

describe("POST /api/me/password", () => {
  it("is a 401 without a session", async () => {
    expect((await POST(request({ current_password: "a", new_password: "abcdefgh" }))).status).toBe(401);
  });

  it("refuses a new password shorter than the floor", async () => {
    sessionUser = { id: "u-1", email: "ana@example.com" };
    const res = await POST(request({ current_password: "old-secret", new_password: "short" }));
    expect(res.status).toBe(400);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("refuses the password the account already has", async () => {
    sessionUser = { id: "u-1", email: "ana@example.com" };
    const same = "the-same-one";
    const res = await POST(request({ current_password: same, new_password: same }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("same_password");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password without writing", async () => {
    sessionUser = { id: "u-1", email: "ana@example.com" };
    authUser = { id: "u-1", email: "ana@example.com", identities: [{ provider: "email" }] };
    signIn.mockImplementation(async () => ({ error: { message: "Invalid login credentials" } }));
    const res = await POST(request({ current_password: "wrong", new_password: "new-secret-1" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("wrong_password");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("verifies, writes, and does not leave the check session open", async () => {
    sessionUser = { id: "u-1", email: "ana@example.com" };
    authUser = { id: "u-1", email: "ana@example.com", identities: [{ provider: "email" }] };
    const res = await POST(request({ current_password: "old-secret", new_password: "new-secret-1" }));
    expect(res.status).toBe(200);
    expect(signIn).toHaveBeenCalledWith({ email: "ana@example.com", password: "old-secret" });
    expect(updateUserById).toHaveBeenCalledWith("u-1", { password: "new-secret-1" });
    expect(signOut).toHaveBeenCalled();
  });

  it("has nothing to change for an account with no password identity", async () => {
    sessionUser = { id: "u-1", email: "ana@example.com" };
    authUser = { id: "u-1", email: "ana@example.com", identities: [{ provider: "google" }] };
    const res = await POST(request({ current_password: "old-secret", new_password: "new-secret-1" }));
    expect(res.status).toBe(409);
    expect(signIn).not.toHaveBeenCalled();
  });
});

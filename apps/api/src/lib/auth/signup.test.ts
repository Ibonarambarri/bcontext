import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a self-service signup promises about the confirmation email. The
 * answer `email_sent` is a promise that a letter left; when the transport
 * fails the account must not stay behind unconfirmable, and the caller must
 * hear that it failed.
 */
const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  supabaseConfigured: () => true,
}));

const auth = {
  generateLink: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUserById: vi.fn(),
};
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    auth: { admin: auth },
  }),
}));

import { signUp, SignupError } from "./signup";

const INPUT = { email: "Ana@Acme.test", password: "correct horse", firstName: "Ana" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Acme <no-reply@acme.test>";
  auth.generateLink.mockResolvedValue({
    data: { user: { id: "u1" }, properties: { action_link: "https://auth.test/confirm" } },
    error: null,
  });
  auth.deleteUser.mockResolvedValue({ error: null });
  auth.updateUserById.mockResolvedValue({ error: null });
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.ORG_CREATION;
});

describe("signUp", () => {
  it("answers email_sent only when the letter left, from EMAIL_FROM", async () => {
    send.mockResolvedValue({ data: { id: "m1" }, error: null });
    await expect(signUp(INPUT)).resolves.toEqual({
      email: "ana@acme.test",
      confirmation: "email_sent",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "Acme <no-reply@acme.test>" }));
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("fails and removes the account when the transport refuses the letter", async () => {
    send.mockResolvedValue({ data: null, error: { message: "domain not verified" } });
    const err = await signUp(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignupError);
    expect(err).toMatchObject({ status: 503, code: "confirm_email_failed" });
    expect(auth.deleteUser).toHaveBeenCalledWith("u1");
  });

  it("fails the same way when the transport throws", async () => {
    send.mockRejectedValue(new Error("network down"));
    await expect(signUp(INPUT)).rejects.toMatchObject({ code: "confirm_email_failed" });
    expect(auth.deleteUser).toHaveBeenCalledWith("u1");
  });

  it("confirms on creation when the instance has no sender", async () => {
    delete process.env.EMAIL_FROM;
    await expect(signUp(INPUT)).resolves.toMatchObject({ confirmation: "not_required" });
    expect(send).not.toHaveBeenCalled();
    expect(auth.updateUserById).toHaveBeenCalledWith("u1", { email_confirm: true });
  });
});

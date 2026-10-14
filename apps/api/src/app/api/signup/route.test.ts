import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Self-service signup is the instance's choice: closed (403) when
 * `ORG_CREATION=admin`, where accounts arrive by invitation. The account
 * creation itself needs the auth server, so without Supabase the open path
 * stops at 503 — after validation, which is what is under test here.
 */
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "./route";

const post = (body: unknown, ip = "10.0.0.1") =>
  POST(
    new Request("http://localhost/api/signup", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    }),
  );

const VALID = { email: "ana@acme.test", password: "correct horse", first_name: "Ana" };

afterEach(() => {
  delete process.env.ORG_CREATION;
});

describe("POST /api/signup", () => {
  it("is closed when organizations are created by an administrator", async () => {
    process.env.ORG_CREATION = "admin";
    const res = await post(VALID, "10.0.0.2");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "signup_closed" });
  });

  it("validates the body before anything else", async () => {
    const res = await post({ ...VALID, password: "short" }, "10.0.0.3");
    expect(res.status).toBe(400);
  });

  it("needs the auth server to create an account", async () => {
    const res = await post(VALID, "10.0.0.4");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_configured" });
  });
});

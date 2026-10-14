import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Changing and removing people. The gate comes first, and a refusal the
 * library makes — the last owner, somebody stripping their own owner role —
 * reaches the caller as a message it can show, not a 500.
 */
import { OrgAdminError } from "@/lib/organizations/admin";

const calls: unknown[] = [];
let gated: unknown = null;
let refuse: OrgAdminError | null = null;

vi.mock("@/lib/organizations/admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/organizations/admin")>(
    "@/lib/organizations/admin",
  );
  return {
    ...actual,
    gateOrgAdmin: async () => gated,
    updateOrgMember: async (...args: unknown[]) => {
      calls.push(["update", ...args]);
      if (refuse) throw refuse;
    },
    removeOrgMember: async (...args: unknown[]) => {
      calls.push(["remove", ...args]);
      if (refuse) throw refuse;
    },
  };
});
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { DELETE, PATCH } from "./route";

const headers = {
  origin: "http://localhost",
  host: "localhost",
  "content-type": "application/json",
};
const params = (userId: string) => ({ params: Promise.resolve({ org: "acme", userId }) });
const url = (userId: string) => `http://localhost/api/organizations/acme/members/${userId}`;
const patch = (userId: string, body: unknown) =>
  PATCH(
    new Request(url(userId), { method: "PATCH", headers, body: JSON.stringify(body) }),
    params(userId),
  );
const remove = (userId: string) =>
  DELETE(new Request(url(userId), { method: "DELETE", headers }), params(userId));

const asAdmin = () => {
  gated = {
    org: { id: "org-1", slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" },
    actor: { userId: "u-owner" },
    role: "owner",
  };
};

afterEach(() => {
  gated = null;
  refuse = null;
  calls.length = 0;
});

describe("PATCH /api/organizations/:org/members/:userId", () => {
  it("refuses somebody who does not administer this organization", async () => {
    gated = Response.json({ error: "not_found" }, { status: 404 });
    expect((await patch("u-2", { role: "viewer" })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuses a role outside the four a person can hold", async () => {
    asAdmin();
    expect((await patch("u-2", { role: "agent" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("passes the whole workspace list through, caller included", async () => {
    asAdmin();
    const ws = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect((await patch("u-2", { workspaces: [ws] })).status).toBe(200);
    expect(calls).toEqual([
      ["update", "org-1", "u-2", { role: undefined, workspaces: [ws] }, "u-owner"],
    ]);
  });

  it("says why the last owner cannot be demoted", async () => {
    asAdmin();
    refuse = new OrgAdminError(409, "last_owner", "This is the organization's only owner.");
    const res = await patch("u-owner", { role: "admin" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "last_owner",
      message: "This is the organization's only owner.",
    });
  });
});

describe("DELETE /api/organizations/:org/members/:userId", () => {
  it("says why the last owner cannot be removed", async () => {
    asAdmin();
    refuse = new OrgAdminError(409, "last_owner", "This is the organization's only owner.");
    const res = await remove("u-owner");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_owner" });
  });

  it("removes anybody else", async () => {
    asAdmin();
    expect((await remove("u-2")).status).toBe(200);
    expect(calls).toEqual([["remove", "org-1", "u-2", "u-owner"]]);
  });
});

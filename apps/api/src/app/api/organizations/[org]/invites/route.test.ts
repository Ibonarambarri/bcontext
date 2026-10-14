import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Adding somebody to a company. Two things are load-bearing: the gate runs
 * before anything is written, and a creation answers with a link and sends
 * nothing — the email is its own route, asked for by name.
 */
const created: unknown[] = [];
const emailed: unknown[] = [];
let gated: unknown = null;

vi.mock("@/lib/organizations/admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/organizations/admin")>(
    "@/lib/organizations/admin",
  );
  return {
    ...actual,
    gateOrgAdmin: async () => gated,
    createOrgInvite: async (orgId: string, input: unknown, invitedBy: string) => {
      created.push({ orgId, input, invitedBy });
      return {
        id: "inv-1",
        email: "ana@acme.test",
        role: "editor",
        url: "https://app.example.com/invite/tok-1",
        expires_at: "2030-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        workspace_ids: [],
        email_status: null,
        email_sent_at: null,
        email_error: null,
      };
    },
  };
});
vi.mock("@/lib/workspaces/invite-email", () => ({
  sendWorkspaceInviteEmail: async (input: unknown) => {
    emailed.push(input);
    return { status: "sent", error: null };
  },
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "./route";

const headers = {
  origin: "http://localhost",
  host: "localhost",
  "content-type": "application/json",
};
const params = { params: Promise.resolve({ org: "acme" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/organizations/acme/invites", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    params,
  );

const asAdmin = () => {
  gated = {
    org: { id: "org-1", slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" },
    actor: { userId: "u-owner" },
    role: "owner",
  };
};

afterEach(() => {
  gated = null;
  created.length = 0;
  emailed.length = 0;
});

describe("POST /api/organizations/:org/invites", () => {
  it("refuses somebody who does not administer this organization", async () => {
    gated = Response.json({ error: "not_found" }, { status: 404 });
    const res = await post({ email: "ana@acme.test" });
    expect(res.status).toBe(404);
    expect(created).toEqual([]);
  });

  it("needs an address that is one", async () => {
    asAdmin();
    const res = await post({ email: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Enter a valid email address." });
    expect(created).toEqual([]);
  });

  it("answers with the link and sends nothing", async () => {
    asAdmin();
    const res = await post({ email: "Ana@Acme.test", workspaces: [] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      invite: { url: "https://app.example.com/invite/tok-1", email_status: null },
    });
    expect(created).toEqual([
      {
        orgId: "org-1",
        // The least an invitation can be worth: widening it is deliberate.
        input: { email: "ana@acme.test", role: "editor", workspaces: [] },
        invitedBy: "u-owner",
      },
    ]);
    expect(emailed).toEqual([]);
  });
});

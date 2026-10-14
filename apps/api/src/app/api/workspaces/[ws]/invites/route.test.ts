import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Inviting from the roster. The route owns the admin check, the personal-zone
 * refusal comes back as a 400 the form can show, and creating an invitation
 * sends nothing: the reply carries the link, and emailing it is the separate
 * `POST .../invites/:id/email`.
 */
const state: {
  ctx: unknown;
  created: unknown[];
  fail: string | null;
  sends: number;
} = { ctx: null, created: [], fail: null, sends: 0 };

vi.mock("@/lib/auth/workspace", () => ({
  openWorkspace: async () => state.ctx,
}));
vi.mock("@/lib/workspaces/orgs", () => ({
  createInvite: async (input: unknown) => {
    if (state.fail) throw new Error(state.fail);
    state.created.push(input);
    return {
      id: "inv-1",
      email: (input as { email: string }).email,
      role: (input as { role: string }).role,
      token: "tok-1",
      expires_at: "2030-01-01T00:00:00.000Z",
      accepted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
  },
}));
// The mailer is mocked only to prove it is never reached from here.
vi.mock("@/lib/workspaces/invite-email", () => ({
  sendWorkspaceInviteEmail: async () => {
    state.sends += 1;
    return { status: "sent", error: null, messageId: null };
  },
}));

import { POST } from "./route";

const userCtx = (backend = "supabase") => ({
  actor: { kind: "user", userId: "admin-1" },
  storage: { backend, workspace: { id: "ws-1", organization_id: "org-1", slug: "acme", name: "Acme" } },
});
const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/workspaces/acme/invites", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ ws: "acme" }) },
  );

afterEach(() => {
  state.ctx = userCtx();
  state.created = [];
  state.fail = null;
  state.sends = 0;
});

describe("POST /api/workspaces/:ws/invites", () => {
  it("rejects an address that is not one", async () => {
    state.ctx = userCtx();
    const res = await post({ email: "nope", role: "editor" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Enter a valid email address." });
    expect(state.created).toEqual([]);
  });

  it("creates the invitation against the workspace's org, by the caller", async () => {
    state.ctx = userCtx();
    const res = await post({ email: "Ana@Example.com", role: "viewer" });
    expect(res.status).toBe(201);
    expect(state.created).toEqual([
      {
        organizationId: "org-1",
        email: "ana@example.com",
        role: "viewer",
        invitedBy: "admin-1",
        // From the roster, the invitation is to this workspace only.
        workspaceIds: ["ws-1"],
      },
    ]);
    expect(await res.json()).toMatchObject({
      invite: {
        id: "inv-1",
        email: "ana@example.com",
        role: "viewer",
        token: "tok-1",
        url: "http://localhost:3000/invite/tok-1",
      },
    });
  });

  it("sends nothing — the link is the deliverable", async () => {
    state.ctx = userCtx();
    const res = await post({ email: "ana@example.com" });
    expect(res.status).toBe(201);
    expect(state.sends).toBe(0);
    expect(await res.json()).toMatchObject({
      invite: { url: "http://localhost:3000/invite/tok-1" },
    });
  });

  it("invites an org admin to the organization rather than to this workspace", async () => {
    // Their role reaches every workspace the organization holds, including
    // the ones created after they joined — a snapshot of rows never would.
    state.ctx = userCtx();
    await post({ email: "ana@example.com", role: "admin" });
    expect(state.created).toEqual([
      {
        organizationId: "org-1",
        email: "ana@example.com",
        role: "admin",
        invitedBy: "admin-1",
        workspaceIds: [],
      },
    ]);
  });

  it("is a person's action, not a token's", async () => {
    state.ctx = { ...userCtx(), actor: { kind: "agent", workspaceId: "ws-1" } };
    expect((await post({ email: "ana@example.com" })).status).toBe(403);
    expect(state.created).toEqual([]);
  });
});

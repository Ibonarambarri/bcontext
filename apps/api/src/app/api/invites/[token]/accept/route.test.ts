import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Accepting needs a person — the grant is born with a principal to attach it
 * to — and the answer names the workspace slug the hub understands, not only
 * the org slug the accept helper returns.
 */
const state: {
  gate: unknown;
  invite: unknown;
  result: unknown;
  accepted: Array<[string, unknown]>;
} = { gate: null, invite: null, result: null, accepted: [] };

vi.mock("@/lib/auth/require", () => ({
  gate: async () => state.gate,
}));
vi.mock("@/lib/auth/invitations", () => ({
  acceptInvitation: async (token: string, user: unknown) => {
    state.accepted.push([token, user]);
    return state.result;
  },
}));
vi.mock("@/lib/workspaces/orgs", () => ({
  findInviteByToken: async () => state.invite,
}));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "ana@example.com" } } }) },
  }),
}));
// The lookup is `select → eq → in → order → limit → maybeSingle`: the
// invitation names the workspaces, so the query filters by them.
vi.mock("@/lib/supabase/admin", () => {
  const single = { maybeSingle: async () => ({ data: { slug: "acme" } }) };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.order = () => chain;
  chain.limit = () => single;
  return { getSupabaseAdmin: () => ({ from: () => chain }) };
});

import { POST } from "./route";

const post = (token: string) =>
  POST(
    new Request(`http://localhost/api/invites/${token}/accept`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    { params: Promise.resolve({ token }) },
  );

afterEach(() => {
  state.gate = { kind: "user", userId: "u1" };
  state.invite = { organization_id: "org-1" };
  state.result = { orgSlug: "acme-x1" };
  state.accepted = [];
});

describe("POST /api/invites/:token/accept", () => {
  it("needs a person, not a token", async () => {
    state.gate = { kind: "agent_user", userId: "u1" };
    expect((await post("tok")).status).toBe(401);
    expect(state.accepted).toEqual([]);
  });

  it("404s before touching a token that leads nowhere", async () => {
    state.gate = { kind: "user", userId: "u1" };
    state.invite = null;
    expect((await post("tok")).status).toBe(404);
    expect(state.accepted).toEqual([]);
  });

  it("accepts as the signed-in person and lands them in the workspace they were invited to", async () => {
    state.gate = { kind: "user", userId: "u1" };
    state.invite = { organization_id: "org-1", workspace_ids: ["ws-1"] };
    state.result = { orgSlug: "acme-x1" };
    const res = await post("tok");
    expect(res.status).toBe(200);
    expect(state.accepted).toEqual([["tok", { id: "u1", email: "ana@example.com" }]]);
    expect(await res.json()).toEqual({ orgSlug: "acme-x1", workspaceSlug: "acme" });
  });

  it("lands an organization-only invitation on the hub, not in a workspace", async () => {
    // An owner or admin is invited to the company, not to a list of
    // projects: their role reaches every workspace it holds, so there is no
    // single one to drop them into.
    state.gate = { kind: "user", userId: "u1" };
    state.invite = { organization_id: "org-1", workspace_ids: null };
    state.result = { orgSlug: "acme-x1" };
    const res = await post("tok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgSlug: "acme-x1", workspaceSlug: null });
  });

  it("surfaces a refusal as a 400 with the reason", async () => {
    state.gate = { kind: "user", userId: "u1" };
    state.invite = { organization_id: "org-1" };
    state.result = { error: "This invitation was sent to bob@example.com. Sign in with that email to accept." };
    const res = await post("tok");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invite_rejected", message: expect.stringContaining("bob@example.com") });
  });
});

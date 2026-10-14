import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Revoking is scoped to the workspace's organisation: the id in the URL is
 * caller-supplied, and the delete must name the tenant it may touch.
 */
const state: { ctx: unknown; revoked: Array<[string, string]> } = { ctx: null, revoked: [] };

vi.mock("@/lib/auth/workspace", () => ({
  openWorkspace: async () => state.ctx,
}));
vi.mock("@/lib/workspaces/orgs", () => ({
  revokeInvite: async (org: string, id: string) => {
    state.revoked.push([org, id]);
  },
}));

import { DELETE } from "./route";

const userCtx = (backend = "supabase") => ({
  actor: { kind: "user", userId: "admin-1" },
  storage: { backend, workspace: { id: "ws-1", organization_id: "org-1", slug: "acme" } },
});
const del = (id: string) =>
  DELETE(
    new Request(`http://localhost/api/workspaces/acme/invites/${id}`, {
      method: "DELETE",
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    { params: Promise.resolve({ ws: "acme", id }) },
  );

afterEach(() => {
  state.ctx = userCtx();
  state.revoked = [];
});

describe("DELETE /api/workspaces/:ws/invites/:id", () => {
  it("revokes within the workspace's org only", async () => {
    state.ctx = userCtx();
    expect((await del("inv-9")).status).toBe(200);
    expect(state.revoked).toEqual([["org-1", "inv-9"]]);
  });

  it("returns the gate's answer untouched", async () => {
    state.ctx = Response.json({ error: "forbidden", verb: "admin" }, { status: 403 });
    expect((await del("inv-9")).status).toBe(403);
    expect(state.revoked).toEqual([]);
  });

  it("has no invitations in the demo store", async () => {
    state.ctx = userCtx("demo");
    expect((await del("inv-9")).status).toBe(400);
    expect(state.revoked).toEqual([]);
  });
});

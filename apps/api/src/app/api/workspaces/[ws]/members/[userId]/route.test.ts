import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Role change and removal moved here from the workspaces Server Action.
 * The membership write and the grant mirror were beside each other there and
 * must stay beside each other here — the grant is authoritative, so a role
 * that reached `memberships` alone would be a role nobody actually holds.
 */
const state: {
  ctx: unknown;
  writes: string[];
  synced: Array<[string, string, string | null, unknown]>;
  org: string[];
} = { ctx: null, writes: [], synced: [], org: [] };

vi.mock("@/lib/auth/workspace", () => ({
  openWorkspace: async () => state.ctx,
}));
vi.mock("@/lib/auth/grant-sync", () => ({
  syncGrantFromMembership: async (ws: string, user: string, role: string | null, opts: unknown) => {
    state.synced.push([ws, user, role, opts]);
  },
}));
vi.mock("@/lib/workspaces/orgs", () => ({
  updateMemberRole: async (org: string, user: string, role: string) => {
    state.org.push(`update ${org} ${user} ${role}`);
  },
  removeMember: async (org: string, user: string) => {
    state.org.push(`remove ${org} ${user}`);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const chain = (op: string) => ({
        eq: (col: string, val: string) => {
          state.writes.push(`${table}.${op} ${col}=${val}`);
          return chain(op);
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return {
        update: () => chain("update"),
        delete: () => chain("delete"),
      };
    },
  }),
}));

import { DELETE, PATCH } from "./route";

const userCtx = (backend = "supabase") => ({
  actor: { kind: "user", userId: "admin-1" },
  storage: { backend, workspace: { id: "ws-1", organization_id: "org-1", slug: "acme" } },
});
const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const params = (userId: string) => ({ params: Promise.resolve({ ws: "acme", userId }) });

afterEach(() => {
  state.ctx = userCtx();
  state.writes = [];
  state.synced = [];
  state.org = [];
});

describe("PATCH /api/workspaces/:ws/members/:userId", () => {
  it("refuses a role outside the four a person can hold", async () => {
    state.ctx = userCtx();
    const res = await PATCH(
      new Request("http://localhost/api/workspaces/acme/members/u2", { method: "PATCH", headers, body: JSON.stringify({ role: "agent" }) }),
      params("u2"),
    );
    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
  });

  it("writes the membership and mirrors the grant without reinstating", async () => {
    state.ctx = userCtx();
    const res = await PATCH(
      new Request("http://localhost/api/workspaces/acme/members/u2", { method: "PATCH", headers, body: JSON.stringify({ role: "viewer" }) }),
      params("u2"),
    );
    expect(res.status).toBe(200);
    expect(state.writes).toEqual(["memberships.update workspace_id=ws-1", "memberships.update user_id=u2"]);
    // No `reinstate`: re-picking a role for someone `revokeAccess` removed must
    // not quietly bring them back.
    expect(state.synced).toEqual([["ws-1", "u2", "viewer", undefined]]);
    expect(state.org).toEqual(["update org-1 u2 viewer"]);
  });

  it("is a person's action, not a token's", async () => {
    state.ctx = { ...userCtx(), actor: { kind: "agent_user", userId: "admin-1" } };
    const res = await PATCH(
      new Request("http://localhost/api/workspaces/acme/members/u2", { method: "PATCH", headers, body: JSON.stringify({ role: "viewer" }) }),
      params("u2"),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/workspaces/:ws/members/:userId", () => {
  it("will not remove the caller", async () => {
    state.ctx = userCtx();
    const res = await DELETE(
      new Request("http://localhost/api/workspaces/acme/members/admin-1", { method: "DELETE", headers }),
      params("admin-1"),
    );
    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(state.synced).toEqual([]);
  });

  it("revokes the grant in the same breath as the membership", async () => {
    state.ctx = userCtx();
    const res = await DELETE(
      new Request("http://localhost/api/workspaces/acme/members/u2", { method: "DELETE", headers }),
      params("u2"),
    );
    expect(res.status).toBe(200);
    expect(state.writes).toEqual(["memberships.delete workspace_id=ws-1", "memberships.delete user_id=u2"]);
    expect(state.synced).toEqual([["ws-1", "u2", null, undefined]]);
    expect(state.org).toEqual(["remove org-1 u2"]);
  });
});

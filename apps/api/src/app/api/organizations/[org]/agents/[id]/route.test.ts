import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The gate says which company the caller administers; it says nothing about
 * the agent in the path, and `agents` is global. So what is tested here is the
 * second check — that an id which reaches none of this organization's
 * workspaces is answered as if it did not exist, and never reaches the revoke.
 */
let gated: unknown = null;
/** Workspaces of the organization, and the live access rows for the agent. */
let workspaceIds: string[] = ["ws-1", "ws-2"];
let reached: Array<{ workspace_id: string }> = [];

const revoke = vi.fn(async (_admin: unknown, _agentId: string) => {});
const audit = vi.fn(async (_entry: { workspaceId: string }) => {});

vi.mock("@/lib/organizations/admin", () => ({
  gateOrgAdmin: async () => gated,
}));
vi.mock("@/lib/agents/connections.server", () => ({
  revokeAgentEverywhere: (admin: unknown, agentId: string) => revoke(admin, agentId),
}));
vi.mock("@/lib/audit", () => ({
  appendAudit: (entry: { workspaceId: string }) => audit(entry),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      if (table === "workspaces") {
        return {
          select: () => ({
            eq: async () => ({ data: workspaceIds.map((id) => ({ id })) }),
          }),
        };
      }
      // `agent_workspace_access`: agent id, this org's workspaces, live only.
      return {
        select: () => ({
          eq: () => ({
            in: () => ({ is: async () => ({ data: reached }) }),
          }),
        }),
      };
    },
  }),
}));

import { DELETE } from "./route";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const remove = (id: string) =>
  DELETE(
    new Request(`http://localhost/api/organizations/acme/agents/${id}`, {
      method: "DELETE",
      headers: { origin: "http://localhost", host: "localhost" },
    }),
    { params: Promise.resolve({ org: "acme", id }) },
  );

const asAdmin = () => {
  gated = {
    org: { id: "org-1", slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" },
    actor: { userId: "u-owner" },
    role: "owner",
    via_platform_admin: false,
  };
};

afterEach(() => {
  gated = null;
  workspaceIds = ["ws-1", "ws-2"];
  reached = [];
  revoke.mockClear();
  audit.mockClear();
});

describe("DELETE /api/organizations/:org/agents/:id", () => {
  it("refuses somebody who does not administer this organization", async () => {
    gated = Response.json({ error: "not_found" }, { status: 404 });
    expect((await remove(AGENT)).status).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("does not exist for an agent that reaches none of these workspaces", async () => {
    asAdmin();
    reached = [];
    const res = await remove(AGENT);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes an agent this organization actually holds", async () => {
    asAdmin();
    reached = [{ workspace_id: "ws-1" }, { workspace_id: "ws-2" }];
    const res = await remove(AGENT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]?.[1]).toBe(AGENT);
    // One audit entry per workspace: the chain is per-workspace, so a single
    // entry would leave the other project with no record of the change.
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls.map((c) => c[0].workspaceId)).toEqual(["ws-1", "ws-2"]);
  });

  it("rejects an id that is not a uuid before touching anything", async () => {
    asAdmin();
    expect((await remove("not-a-uuid")).status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });
});

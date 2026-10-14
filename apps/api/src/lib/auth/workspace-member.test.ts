import { afterEach, describe, expect, it, vi } from "vitest";

// Chainable Supabase admin stub: maybeSingle resolves the row configured
// per table.
const tableData: Record<string, unknown> = {};
function makeAdmin() {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: tableData[table] ?? null, error: null });
    return b;
  };
  return { from: (t: string) => builder(t) };
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => makeAdmin(),
}));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => {
    throw new Error("not configured in tests");
  },
}));

import { requireWorkspaceMember, type Actor } from "./require";

const WS = { backend: "supabase" as const, workspace: { id: "ws-1" } };
const DEMO_WS = { backend: "demo" as const, workspace: { id: "demo" } };

const agent = (workspaceId: string): Actor => ({
  kind: "agent",
  workspaceId,
  scopes: [],
  tokenId: "tok-1",
  createdBy: null,
});
const user: Actor = { kind: "user", userId: "u1" };
const agentUser: Actor = {
  kind: "agent_user",
  userId: "u1",
  scopes: [],
  tokenId: "tok-2",
};
const demo: Actor = { kind: "demo" };

async function status(res: Response | null): Promise<number | null> {
  return res ? res.status : null;
}

describe("requireWorkspaceMember", () => {
  afterEach(() => {
    for (const k of Object.keys(tableData)) delete tableData[k];
  });

  it("always allows the in-memory demo backend", async () => {
    for (const actor of [agent("other-ws"), user, agentUser, demo]) {
      expect(await requireWorkspaceMember(actor, DEMO_WS)).toBeNull();
    }
  });

  it("allows a workspace token bound to the same workspace", async () => {
    expect(await requireWorkspaceMember(agent("ws-1"), WS)).toBeNull();
  });

  it("rejects a workspace token bound to another workspace", async () => {
    expect(await status(await requireWorkspaceMember(agent("ws-2"), WS))).toBe(403);
  });

  it("allows a cookie user with a membership row", async () => {
    tableData.memberships = { user_id: "u1" };
    expect(await requireWorkspaceMember(user, WS)).toBeNull();
  });

  it("rejects a cookie user without a membership row", async () => {
    expect(await status(await requireWorkspaceMember(user, WS))).toBe(403);
  });

  it("allows a user-scoped token with a membership row", async () => {
    tableData.memberships = { user_id: "u1" };
    expect(await requireWorkspaceMember(agentUser, WS)).toBeNull();
  });

  it("rejects a user-scoped token without a membership row", async () => {
    expect(await status(await requireWorkspaceMember(agentUser, WS))).toBe(403);
  });

  it("rejects the dev demo actor against a real workspace", async () => {
    expect(await status(await requireWorkspaceMember(demo, WS))).toBe(403);
  });
});

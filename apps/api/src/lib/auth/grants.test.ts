import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Chainable Supabase stub, same shape as workspace-member.test.ts. Each table
 * resolves whatever `tableData` holds, so a test can say "there is no grant row
 * but there is a membership row" and exercise the fallback. `tableError` lets a
 * test make a query fail, which is its own branch: a database error is not the
 * same thing as "no grant".
 */
const tableData: Record<string, unknown> = {};
const tableError: Record<string, { code: string; message: string }> = {};
const queried: string[] = [];

function makeAdmin() {
  const builder = (table: string) => {
    queried.push(table);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.or = () => b;
    b.maybeSingle = async () => ({
      data: tableData[table] ?? null,
      error: tableError[table] ?? null,
    });
    return b;
  };
  return { from: (t: string) => builder(t) };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { resolveGrant, hasVerb, isDenied, systemGrant, verbsForRole, type Grant } from "./grants";
import type { Actor } from "./require";

const WS = "ws-1";
const LIVE = { revoked_at: null, expires_at: null };

const user: Actor = { kind: "user", userId: "u1" };
const demo: Actor = { kind: "demo" };
const agent = (
  workspaceId: string,
  scopes: string[] = ["nodes:read", "nodes:write"],
  agentId: string | null = "a1",
): Actor =>
  ({
    kind: "agent",
    workspaceId,
    scopes,
    tokenId: "tok-1",
    createdBy: null,
    agentId,
  }) as Actor;

afterEach(() => {
  for (const k of Object.keys(tableData)) delete tableData[k];
  for (const k of Object.keys(tableError)) delete tableError[k];
  queried.length = 0;
  vi.clearAllMocks();
});

const asGrant = (v: Grant | { denied: string }): Grant => {
  if (isDenied(v as Grant)) throw new Error(`expected a grant, got ${JSON.stringify(v)}`);
  return v as Grant;
};

describe("absence is not_found, never forbidden", () => {
  it("denies the demo actor", async () => {
    expect(await resolveGrant(demo, WS)).toEqual({ denied: "not_found" });
  });

  it("treats another tenant's workspace as non-existent for an agent token", async () => {
    // Not `forbidden`: a 403 would confirm the workspace exists.
    expect(await resolveGrant(agent("ws-other"), WS)).toEqual({ denied: "not_found" });
  });

  it("denies a user with neither grant nor membership", async () => {
    expect(await resolveGrant(user, WS)).toEqual({ denied: "not_found" });
  });
});

describe("a grant narrows, it never widens", () => {
  it("returns the stored verbs and reach when the legacy tables agree", async () => {
    tableData.memberships = { role: "owner" };
    tableData.workspace_grants = {
      ...LIVE,
      verbs: ["read"],
      reach: { type: "query", query: { schema_version: 1, tags_any: ["finanzas"] } },
    };
    const grant = asGrant(await resolveGrant(user, WS));
    expect(grant.verbs).toEqual(["read"]);
    expect(grant.reach.type).toBe("query");
    expect(hasVerb(grant, "write")).toBe(false);
  });

  it("may grant more than the legacy role, because it is authoritative", async () => {
    // This used to be intersected with the legacy answer, which capped a grant
    // at whatever the membership role allowed. That broke invitations — whose
    // entire purpose is to grant access to someone with no membership yet — and
    // silently capped anyone whose role was narrower than their granted verbs.
    // Safe now because grant-sync mirrors every membership write into the grant
    // table, so the two cannot disagree.
    tableData.memberships = { role: "viewer" };
    tableData.workspace_grants = { ...LIVE, verbs: ["read", "write", "delete"], reach: { type: "all" } };
    expect(asGrant(await resolveGrant(user, WS)).verbs).toEqual(["read", "write", "delete"]);
  });

  it("stands on its own with no membership behind it", async () => {
    // An invited principal has a grant and no membership until acceptance
    // writes one. Requiring both would have made invitations impossible.
    // Removal is handled the other way round: grant-sync revokes the grant when
    // the membership goes, rather than the read path re-checking it every time.
    tableData.workspace_grants = { ...LIVE, verbs: ["read"], reach: { type: "all" } };
    expect(asGrant(await resolveGrant(user, WS)).verbs).toEqual(["read"]);
  });

  it("still refuses a revoked grant, which is how removal now works", async () => {
    tableData.workspace_grants = {
      revoked_at: "2026-01-01T00:00:00Z",
      expires_at: null,
      verbs: ["read"],
      reach: { type: "all" },
    };
    tableData.memberships = { role: "owner" };
    expect(await resolveGrant(user, WS)).toEqual({ denied: "not_found" });
  });

  it("keeps the token-scope bound on the grant path", async () => {
    // A read-only token attached to an agent whose connection was approved for
    // writes must stay read-only.
    tableData.agent_workspace_access = { role: "operator", scopes: ["nodes:read", "nodes:write"] };
    tableData.workspace_grants = { ...LIVE, verbs: ["read", "write", "delete"], reach: { type: "all" } };
    const grant = asGrant(await resolveGrant(agent(WS, ["nodes:read"]), WS));
    expect(grant.verbs).toEqual(["read"]);
  });
});

describe("revocation actually revokes", () => {
  it("denies a revoked grant instead of falling back to the legacy tables", async () => {
    // The bug this guards: filtering revoked rows out of the query makes a
    // revoked grant look like no grant, so the legacy fallback re-derives full
    // access and revoking silently does nothing for the whole coexistence window.
    tableData.workspace_grants = {
      revoked_at: "2026-01-01T00:00:00Z",
      expires_at: null,
      verbs: ["read"],
      reach: { type: "all" },
    };
    tableData.memberships = { role: "owner" };
    expect(await resolveGrant(user, WS)).toEqual({ denied: "not_found" });
  });

  it("denies an expired grant the same way", async () => {
    tableData.workspace_grants = {
      revoked_at: null,
      expires_at: "2020-01-01T00:00:00Z",
      verbs: ["read"],
      reach: { type: "all" },
    };
    tableData.memberships = { role: "owner" };
    expect(await resolveGrant(user, WS)).toEqual({ denied: "not_found" });
  });

  it("honours a grant that expires in the future", async () => {
    tableData.memberships = { role: "owner" };
    tableData.workspace_grants = {
      revoked_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      verbs: ["read"],
      reach: { type: "all" },
    };
    expect(asGrant(await resolveGrant(user, WS)).verbs).toEqual(["read"]);
  });
});

describe("query failures fail closed", () => {
  it("denies on an unexpected database error rather than falling back", async () => {
    // Folding errors into the fallback would hand a narrowed principal the whole
    // workspace on a transient hiccup, silently.
    tableError.workspace_grants = { code: "57014", message: "statement timeout" };
    tableData.memberships = { role: "owner" };
    expect(await resolveGrant(user, WS)).toEqual({ denied: "not_found" });
  });

  it("falls back only when the table does not exist yet (pre-migration)", async () => {
    tableError.workspace_grants = { code: "42P01", message: "undefined_table" };
    tableData.memberships = { role: "editor" };
    expect(asGrant(await resolveGrant(user, WS)).verbs).toEqual(verbsForRole("editor"));
  });
});

describe("an untrustworthy reach denies rather than guessing", () => {
  it("denies when the reach type is unknown", async () => {
    tableData.memberships = { role: "owner" };
    tableData.workspace_grants = { ...LIVE, verbs: ["read"], reach: { type: "new-thing" } };
    const grant = asGrant(await resolveGrant(user, WS));
    expect(grant.reach).not.toEqual({ type: "all" });
    expect(grant.reach.type).toBe("query");
  });

  it("denies a query reach whose query is missing", async () => {
    // The DB only checks that reach is an object with a `type`, so this row is
    // insertable. Trusting it would produce an undefined filter — a fail-open.
    tableData.memberships = { role: "owner" };
    tableData.workspace_grants = { ...LIVE, verbs: ["read"], reach: { type: "query" } };
    const grant = asGrant(await resolveGrant(user, WS));
    expect(grant.reach.type).toBe("query");
    if (grant.reach.type === "query") {
      expect(grant.reach.query.tags_any).toEqual(["00000000-0000-0000-0000-000000000000"]);
    }
  });

  it("denies a query reach that fails validation", async () => {
    tableData.memberships = { role: "owner" };
    tableData.workspace_grants = {
      ...LIVE,
      verbs: ["read"],
      reach: { type: "query", query: { schema_version: 99 } },
    };
    const grant = asGrant(await resolveGrant(user, WS));
    if (grant.reach.type === "query") {
      expect(grant.reach.query.tags_any).toEqual(["00000000-0000-0000-0000-000000000000"]);
    }
  });

  it("produces a sentinel that is a valid ViewQuery, not a malformed one", async () => {
    // A malformed sentinel would throw a 500 downstream instead of denying.
    tableData.memberships = { role: "owner" };
    tableData.workspace_grants = { ...LIVE, verbs: ["read"], reach: { type: "?" } };
    const grant = asGrant(await resolveGrant(user, WS));
    if (grant.reach.type === "query") {
      expect(grant.reach.query.schema_version).toBe(1);
      expect(grant.reach.query.traversal).toBeNull();
    }
  });
});

describe("legacy fallback keeps today's behaviour", () => {
  it("derives verbs from the membership role, with reach all", async () => {
    tableData.memberships = { role: "editor" };
    const grant = asGrant(await resolveGrant(user, WS));
    // `editor` is the default role and could always delete; adding reach must
    // not quietly take that away. The role table itself is pinned in
    // grant-sync.test.ts; here the point is that the fallback uses it.
    expect(grant.verbs).toEqual(verbsForRole("editor"));
    expect(grant.verbs).toContain("delete");
    expect(grant.reach).toEqual({ type: "all" });
  });

  it("gives an unrecognised role the least, not the most", async () => {
    tableData.memberships = { role: "some-future-role" };
    expect(asGrant(await resolveGrant(user, WS)).verbs).toEqual(["read"]);
  });

  it("owner gets the tag verbs, editor does not", async () => {
    tableData.memberships = { role: "owner" };
    expect(asGrant(await resolveGrant(user, WS)).verbs).toContain("tags:delete");
    tableData.memberships = { role: "editor" };
    expect(asGrant(await resolveGrant(user, WS)).verbs).not.toContain("tags:delete");
  });

  it("intersects the token's scopes with the connection's", async () => {
    // A connection approved for writes must not widen a read-only token.
    tableData.agent_workspace_access = { role: "operator", scopes: ["nodes:read", "nodes:write"] };
    expect(asGrant(await resolveGrant(agent(WS, ["nodes:read"]), WS)).verbs).toEqual(["read"]);
  });

  it("denies an agent whose connection was revoked", async () => {
    expect(await resolveGrant(agent(WS), WS)).toEqual({ denied: "not_found" });
  });
});

describe("the admin:* wildcard", () => {
  it("satisfies node verbs, as hasScope does everywhere else", async () => {
    // A token carrying only the wildcard passes gate() today. Resolving it to no
    // verbs would lock out every such token.
    tableData.agent_workspace_access = { role: "operator", scopes: ["admin:*"] };
    const grant = asGrant(await resolveGrant(agent(WS, ["admin:*"]), WS));
    expect(grant.verbs).toContain("read");
    expect(grant.verbs).toContain("write");
    expect(grant.verbs).toContain("tags:delete");
  });
});

describe("workspace tokens with no agent attached", () => {
  it("keep working on their own scopes", async () => {
    // `agent_tokens.agent_id` is nullable and every token minted before agent
    // connections has none. Today's boundary lets these through; denying them
    // would lock out every older token the moment a caller switches over.
    const grant = asGrant(await resolveGrant(agent(WS, ["nodes:read"], null), WS));
    expect(grant.principal).toEqual({ kind: "agent", id: null });
    expect(grant.verbs).toEqual(["read"]);
    expect(grant.reach).toEqual({ type: "all" });
  });
});

describe("systemGrant", () => {
  it("is unrestricted and requires a stated reason", () => {
    const grant = systemGrant(WS, "queue worker drains webhook deliveries");
    expect(grant.principal.kind).toBe("system");
    expect(grant.reach).toEqual({ type: "all" });
    expect(hasVerb(grant, "delete")).toBe(true);
  });
});

describe("scopes that are not nodes:* still grant read", () => {
  it.each(["chat:run", "agents:read", "skills:execute"])(
    "a token carrying only %s can still read",
    async (scope) => {
      // Each is mintable on its own and documented as such. Resolving it to zero
      // verbs would let it pass gate() and then 403 on the very routes it exists
      // for — /api/nexo, /api/agents/context, /api/skills/:id/run.
      tableData.agent_workspace_access = { role: "operator", scopes: [scope] };
      const grant = asGrant(await resolveGrant(agent(WS, [scope]), WS));
      expect(grant.verbs).toContain("read");
    },
  );
});

describe("write implies read", () => {
  it("a write-only token can still read the node it is about to change", async () => {
    // Every write route reads first: PATCH and DELETE both getNode, upload
    // resolves its target. Without this a `nodes:write`-only token passes gate()
    // and then 403s inside the storage's own read check.
    tableData.agent_workspace_access = { role: "operator", scopes: ["nodes:write"] };
    const grant = asGrant(await resolveGrant(agent(WS, ["nodes:write"]), WS));
    expect(grant.verbs).toContain("read");
    expect(grant.verbs).toContain("write");
  });
});

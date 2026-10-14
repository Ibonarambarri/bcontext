import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The five rules, each with the escalation it exists to stop.
 *
 * The two that carry the most weight are rule 3 and rule 4. Rule 3 is not about
 * politeness: a reply that distinguishes "already a member" from "invited" is a
 * membership oracle, and anyone holding `admin` — an agent included — can walk
 * a list of addresses through it. Rule 4 is about stored authority: an
 * invitation is a promise written days before it is used, and honouring it
 * blindly lets a revoked admin keep handing out access.
 */
const single: Record<string, unknown> = {};
const lists: Record<string, unknown[]> = {};
const counts: Record<string, number> = {};
const errors: Record<string, { code?: string; message: string } | null> = {};
const writes: Array<{ table: string; op: string; payload: Record<string, unknown> }> = [];
let rpcRows: unknown[] = [];

function makeAdmin() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const passthrough = ["select", "eq", "is", "in", "gte", "lte", "limit", "order", "not"];
    for (const k of passthrough) b[k] = () => b;
    const record = (op: string) => (payload: Record<string, unknown>) => {
      writes.push({ table, op, payload });
      return b;
    };
    b.insert = record("insert");
    b.update = record("update");
    b.upsert = record("upsert");
    b.delete = record("delete");
    b.maybeSingle = async () => ({
      data: single[table] ?? null,
      error: errors[table] ?? null,
    });
    b.single = async () => ({ data: single[table] ?? null, error: errors[table] ?? null });
    // Awaiting the builder itself is the list / count shape.
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data: lists[table] ?? [],
        error: errors[table] ?? null,
        count: counts[table] ?? 0,
      });
    return b;
  };
  return {
    from,
    rpc: async () => ({ data: rpcRows, error: null }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const appendAudit = vi.fn(async () => null);
vi.mock("@/lib/audit", () => ({ appendAudit: (...args: unknown[]) => appendAudit(...(args as [])) }));

import {
  AGENT_INVITE_RATE_LIMIT,
  InvitationError,
  acceptInvitation,
  inviteToWorkspace,
  listHeldInvitations,
  releaseInvitation,
  roleForVerbs,
} from "./invitations";
import type { Grant, Reach, Verb } from "./grants";
import { ViewQuerySchema } from "@bcontext-dev/contract/views/schema";

const WS = "ws-1";
const ORG = "org-1";

const reachOf = (tags: string[]): Reach => ({
  type: "query",
  query: ViewQuerySchema.parse({ schema_version: 1, tags_any: tags }),
});

const granter = (
  verbs: string[],
  opts: { reach?: Reach; kind?: "user" | "agent"; id?: string } = {},
): Grant => ({
  workspaceId: WS,
  principal: { kind: opts.kind ?? "user", id: opts.id ?? "admin-1" },
  verbs: verbs as Verb[],
  reach: opts.reach ?? { type: "all" },
});

/** A shareable workspace, nobody at the address, no rate pressure. */
function freshWorkspace() {
  single.workspaces = { id: WS, organization_id: ORG };
  single.workspace_invites = null;
  single.workspace_grants = null;
  single.memberships = null;
  counts.workspace_invites = 0;
  rpcRows = [];
}

const inviteRows = () => writes.filter((w) => w.table === "workspace_invites");
const grantRows = () => writes.filter((w) => w.table === "workspace_grants");

/** First recorded write's payload, loudly rather than `undefined`. */
const payloadOf = (rows: typeof writes): Record<string, unknown> => {
  const first = rows[0];
  if (!first) throw new Error("expected a write, got none");
  return first.payload;
};

afterEach(() => {
  for (const bag of [single, lists, counts, errors]) {
    for (const k of Object.keys(bag)) delete (bag as Record<string, unknown>)[k];
  }
  writes.length = 0;
  rpcRows = [];
  vi.clearAllMocks();
});

/* -- Rule 1: the same no-escalation rule as grantAccess --------------------- */

describe("an invitation cannot promise more than a grant could give", () => {
  it("refuses a verb the inviter does not hold", async () => {
    freshWorkspace();
    await expect(
      inviteToWorkspace(granter(["read", "admin"]), {
        email: "new@example.com",
        verbs: ["read", "write"],
        reach: { type: "all" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(inviteRows()).toHaveLength(0);
  });

  it("refuses unrestricted reach from a narrowed inviter", async () => {
    freshWorkspace();
    await expect(
      inviteToWorkspace(granter(["read", "admin"], { reach: reachOf(["finanzas"]) }), {
        email: "new@example.com",
        verbs: ["read"],
        reach: { type: "all" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a tag the inviter cannot see itself", async () => {
    freshWorkspace();
    await expect(
      inviteToWorkspace(granter(["read", "admin"], { reach: reachOf(["finanzas"]) }), {
        email: "new@example.com",
        verbs: ["read"],
        reach: reachOf(["ingenieria"]),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a principal without the admin verb outright", async () => {
    freshWorkspace();
    await expect(
      inviteToWorkspace(granter(["read", "write"]), {
        email: "new@example.com",
        verbs: ["read"],
        reach: { type: "all" },
      }),
    ).rejects.toBeInstanceOf(InvitationError);
  });

  it("allows exactly what the inviter holds", async () => {
    freshWorkspace();
    const out = await inviteToWorkspace(granter(["read", "admin"]), {
      email: "new@example.com",
      verbs: ["read"],
      reach: { type: "all" },
    });
    expect(out.status).toBe("accepted_for_delivery");
    expect(inviteRows()).toHaveLength(1);
  });
});

/* -- Rule 2: the invitation is a promise, not access ------------------------ */

describe("inviting grants nothing until it is accepted", () => {
  it("writes the permission onto the invitation and no grant row", async () => {
    freshWorkspace();
    await inviteToWorkspace(granter(["read", "write", "admin"]), {
      email: "new@example.com",
      name: "  Ada  ",
      verbs: ["read", "write"],
      reach: reachOf(["finanzas"]),
    });
    expect(grantRows()).toHaveLength(0);
    const row = payloadOf(inviteRows());
    expect(row.verbs).toEqual(["read", "write"]);
    expect(row.reach).toMatchObject({ type: "query" });
    expect(row.workspace_id).toBe(WS);
    expect(row.invitee_name).toBe("Ada");
  });

  it("derives a role at least as wide as the verbs, so the legacy intersection cannot void it", () => {
    // resolveGrant intersects the grant with the legacy membership answer: a
    // viewer membership beside a write grant silently resolves to read-only.
    expect(roleForVerbs(["read"])).toBe("viewer");
    expect(roleForVerbs(["read", "write"])).toBe("editor");
    expect(roleForVerbs(["read", "admin"])).toBe("admin");
  });
});

/* -- Rule 3: the reply is not a membership oracle --------------------------- */

describe("the reply never says whether the address is already here", () => {
  it("returns a byte-identical receipt for a member and for a stranger", async () => {
    freshWorkspace();
    // Both receipts derive expires_at from "now". Two real calls land a
    // millisecond apart and the comparison below turns flaky — which it did,
    // in CI, on a change nowhere near this file. Freeze the clock so the only
    // thing that can differ is what the test is actually about.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const input = {
      email: "someone@example.com",
      verbs: ["read"] as Verb[],
      reach: { type: "all" } as Reach,
    };

    // Nobody at that address.
    const stranger = await inviteToWorkspace(granter(["read", "admin"]), input);
    const strangerWrites = inviteRows().length;

    writes.length = 0;
    // Same address, and it already reaches the workspace through a membership.
    rpcRows = [{ user_id: "u-existing", state: "confirmed" }];
    single.memberships = { role: "editor" };
    const member = await inviteToWorkspace(granter(["read", "admin"]), input);

    expect(member).toEqual(stranger);
    expect(Object.keys(member)).toEqual(Object.keys(stranger));
    // The difference exists — it is just not in the reply.
    expect(strangerWrites).toBe(1);
    expect(inviteRows()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("still records the no-op where an auditor can see it", async () => {
    freshWorkspace();
    rpcRows = [{ user_id: "u-existing", state: "confirmed" }];
    single.memberships = { role: "editor" };
    await inviteToWorkspace(granter(["read", "admin"]), {
      email: "someone@example.com",
      verbs: ["read"],
      reach: { type: "all" },
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access.invite_noop" }),
    );
  });

  it("refuses to invite the caller itself", async () => {
    freshWorkspace();
    rpcRows = [{ user_id: "admin-1", state: "confirmed" }];
    await expect(
      inviteToWorkspace(granter(["read", "admin"], { id: "admin-1" }), {
        email: "me@example.com",
        verbs: ["read", "admin"],
        reach: { type: "all" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

/* -- The outbound email: the one irreversible act --------------------------- */

describe("an agent prepares an invitation, a person sends it", () => {
  it("holds an agent's invitation instead of letting it leave", async () => {
    freshWorkspace();
    const out = await inviteToWorkspace(
      granter(["read", "admin"], { kind: "agent", id: "agent-1" }),
      { email: "new@example.com", verbs: ["read"], reach: { type: "all" } },
    );
    expect(out.delivery).toBe("held_for_release");
    const row = payloadOf(inviteRows());
    expect(row.delivery_state).toBe("held");
    expect(row.invited_by_kind).toBe("agent");
    expect(row.invited_by_agent_id).toBe("agent-1");
  });

  it("lets a person's own invitation go out immediately", async () => {
    freshWorkspace();
    const out = await inviteToWorkspace(granter(["read", "admin"]), {
      email: "new@example.com",
      verbs: ["read"],
      reach: { type: "all" },
    });
    expect(out.delivery).toBe("ready_to_send");
    expect(payloadOf(inviteRows()).delivery_state).toBe("pending");
  });

  it("rate limits agents per organisation", async () => {
    freshWorkspace();
    counts.workspace_invites = AGENT_INVITE_RATE_LIMIT;
    await expect(
      inviteToWorkspace(granter(["read", "admin"], { kind: "agent", id: "agent-1" }), {
        email: "new@example.com",
        verbs: ["read"],
        reach: { type: "all" },
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(inviteRows()).toHaveLength(0);
  });

  it("does not rate limit a person", async () => {
    freshWorkspace();
    counts.workspace_invites = 999;
    await expect(
      inviteToWorkspace(granter(["read", "admin"]), {
        email: "new@example.com",
        verbs: ["read"],
        reach: { type: "all" },
      }),
    ).resolves.toMatchObject({ delivery: "ready_to_send" });
  });

  it("refuses to let an agent release its own held invitation", async () => {
    single.workspaces = { id: WS, organization_id: ORG };
    await expect(
      releaseInvitation(granter(["admin"], { kind: "agent", id: "agent-1" }), "inv-1"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      listHeldInvitations(granter(["admin"], { kind: "agent", id: "agent-1" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("releases for a person and audits the decision", async () => {
    single.workspaces = { id: WS, organization_id: ORG };
    lists.workspace_invites = [
      { id: "inv-1", email: "new@example.com", token: "t", delivery_state: "pending" },
    ];
    const out = await releaseInvitation(granter(["admin"]), "inv-1");
    expect(out.token).toBe("t");
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access.invite_release" }),
    );
  });
});

/* -- Rule 4: acceptance revalidates against what the inviter holds NOW ------ */

const pendingInvite = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  organization_id: ORG,
  workspace_id: WS,
  email: "new@example.com",
  role: "editor",
  verbs: ["read", "write"],
  reach: { type: "all" },
  invited_by: "admin-1",
  invited_by_kind: "user",
  invited_by_agent_id: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  accepted_at: null,
  organization: { slug: "acme" },
  ...over,
});

const accepter = { id: "u-new", email: "new@example.com" };

describe("acceptance re-checks the promise against today's reality", () => {
  it("applies the grant when the inviter still holds what they promised", async () => {
    single.workspace_invites = pendingInvite();
    single.workspaces = null;
    single.workspace_grants = {
      verbs: ["read", "write", "admin"],
      reach: { type: "all" },
      revoked_at: null,
      expires_at: null,
    };
    single.memberships = { role: "owner" };

    const out = await acceptInvitation("tok", accepter);
    expect(out).toEqual({ orgSlug: "acme" });
    const grant = payloadOf(grantRows());
    expect(grant.principal_id).toBe("u-new");
    expect(grant.verbs).toEqual(["read", "write"]);
  });

  it("refuses when the inviter has been revoked since", async () => {
    single.workspace_invites = pendingInvite();
    single.workspaces = null;
    single.workspace_grants = {
      verbs: ["read", "write", "admin"],
      reach: { type: "all" },
      revoked_at: new Date().toISOString(),
      expires_at: null,
    };
    single.memberships = { role: "owner" };

    const out = await acceptInvitation("tok", accepter);
    expect(out).toMatchObject({ error: expect.stringContaining("no longer has access") });
    expect(grantRows()).toHaveLength(0);
  });

  it("refuses when the inviter lost the admin verb", async () => {
    single.workspace_invites = pendingInvite();
    single.workspaces = null;
    single.workspace_grants = {
      verbs: ["read", "write"],
      reach: { type: "all" },
      revoked_at: null,
      expires_at: null,
    };
    single.memberships = { role: "owner" };

    const out = await acceptInvitation("tok", accepter);
    expect(out).toMatchObject({ error: expect.stringContaining("hand out access") });
    expect(grantRows()).toHaveLength(0);
  });

  it("refuses — rather than quietly trimming — when the inviter was narrowed", async () => {
    // The whole point: the invitee gets an error they can act on, not a grant
    // nobody chose and nobody can explain six months later.
    single.workspace_invites = pendingInvite();
    single.workspaces = null;
    single.workspace_grants = {
      verbs: ["read", "write", "admin"],
      reach: { type: "query", query: { schema_version: 1, tags_any: ["finanzas"] } },
      revoked_at: null,
      expires_at: null,
    };
    single.memberships = { role: "owner" };

    const out = await acceptInvitation("tok", accepter);
    expect(out).toMatchObject({ error: expect.stringContaining("promises more") });
    expect(grantRows()).toHaveLength(0);
    // The invitation is left pending: restore the inviter and the link works.
    expect(
      writes.some(
        (w) => w.table === "workspace_invites" && "accepted_at" in (w.payload ?? {}),
      ),
    ).toBe(false);
  });

  it("refuses an invitation whose sender no longer has an account", async () => {
    single.workspace_invites = pendingInvite({ invited_by: null });
    single.workspaces = null;
    const out = await acceptInvitation("tok", accepter);
    expect(out).toMatchObject({ error: expect.stringContaining("no longer has an account") });
    expect(grantRows()).toHaveLength(0);
  });

  it("refuses to hand the inviter a grant from their own invitation", async () => {
    single.workspace_invites = pendingInvite({ invited_by: "u-new" });
    single.workspaces = null;
    const out = await acceptInvitation("tok", { id: "u-new", email: "new@example.com" });
    expect(out).toMatchObject({ error: expect.stringContaining("person who sent it") });
    expect(grantRows()).toHaveLength(0);
  });

  it("refuses an expired invitation and one addressed to somebody else", async () => {
    single.workspace_invites = pendingInvite({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await acceptInvitation("tok", accepter)).toMatchObject({
      error: expect.stringContaining("invalid or expired"),
    });

    single.workspace_invites = pendingInvite();
    expect(
      await acceptInvitation("tok", { id: "u-x", email: "other@example.com" }),
    ).toMatchObject({ error: expect.stringContaining("was sent to") });
  });

  it("grants only the invited workspace, not every project in the org", async () => {
    single.workspace_invites = pendingInvite();
    single.workspaces = null;
    single.workspace_grants = {
      verbs: ["read", "write", "admin"],
      reach: { type: "all" },
      revoked_at: null,
      expires_at: null,
    };
    single.memberships = { role: "owner" };

    await acceptInvitation("tok", accepter);
    const memberships = writes.filter((w) => w.table === "memberships");
    expect(memberships).toHaveLength(1);
    expect(payloadOf(memberships)).toMatchObject({ workspace_id: WS });
  });
});

/* -- Rule 5: audit with the actor ------------------------------------------ */

describe("every invitation names who made it", () => {
  it("records a person as a user", async () => {
    freshWorkspace();
    await inviteToWorkspace(granter(["read", "admin"]), {
      email: "new@example.com",
      verbs: ["read"],
      reach: { type: "all" },
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "access.invite",
        actorType: "user",
        actorId: "admin-1",
      }),
    );
  });

  it("records an agent as an agent", async () => {
    freshWorkspace();
    await inviteToWorkspace(granter(["read", "admin"], { kind: "agent", id: "agent-1" }), {
      email: "new@example.com",
      verbs: ["read"],
      reach: { type: "all" },
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access.invite", actorType: "agent" }),
    );
  });

  it("records acceptance too", async () => {
    single.workspace_invites = pendingInvite();
    single.workspaces = null;
    single.workspace_grants = {
      verbs: ["read", "write", "admin"],
      reach: { type: "all" },
      revoked_at: null,
      expires_at: null,
    };
    single.memberships = { role: "owner" };
    await acceptInvitation("tok", accepter);
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access.invite_accepted", actorId: "u-new" }),
    );
  });
});

/* -- Input hygiene ---------------------------------------------------------- */

// Every workspace is shareable now: the personal zone, which this suite used
// to check was refused, no longer exists.
describe("what an invitation refuses to store", () => {
  it("rejects an unusable address", async () => {
    freshWorkspace();
    await expect(
      inviteToWorkspace(granter(["read", "admin"]), {
        email: "not an email",
        verbs: ["read"],
        reach: { type: "all" },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects a reach the resolver would silently deny later", async () => {
    freshWorkspace();
    await expect(
      inviteToWorkspace(granter(["read", "admin"]), {
        email: "new@example.com",
        verbs: ["read"],
        reach: {
          type: "query",
          query: ViewQuerySchema.parse({
            schema_version: 1,
            tags_any: ["finanzas"],
            kinds: ["task"],
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("caps how long an invitation stays usable", async () => {
    freshWorkspace();
    const out = await inviteToWorkspace(granter(["read", "admin"]), {
      email: "new@example.com",
      verbs: ["read"],
      reach: { type: "all" },
      expiresInDays: 3650,
    });
    const days = (new Date(out.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(91);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules a customer's own administration surface exists to enforce.
 *
 * Three of them are load-bearing: not administering the organization looks
 * exactly like the organization not being there, an organization can never be
 * left without an owner, and the workspace list on a member is a statement
 * about every workspace — so it has to be reconciled, not appended to.
 */
type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
const synced: Array<[string, string, string | null, unknown]> = [];
let actor: unknown = { kind: "user", userId: "u-owner" };
let signedInEmail = "owner@acme.test";

function query(table: string) {
  let rows = [...(db[table] ?? [])];
  const match = (r: Row) => rows.includes(r);
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (col: string, value: unknown) => {
      rows = rows.filter((r) => r[col] === value);
      return api;
    },
    is: (col: string, value: unknown) => {
      rows = rows.filter((r) => r[col] === value);
      return api;
    },
    in: (col: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes(r[col]));
      return api;
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
  };
  return {
    api,
    apply: (op: "update" | "delete" | "upsert", patch?: Row, inserted?: Row[]) => {
      const finish = () => {
        const table_ = db[table] ?? [];
        if (op === "delete") db[table] = table_.filter((r) => !match(r));
        if (op === "update") {
          for (const r of table_) if (match(r)) Object.assign(r, patch);
        }
        if (op === "upsert") db[table] = [...table_, ...(inserted ?? [])];
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {
        eq: (col: string, value: unknown) => {
          rows = rows.filter((r) => r[col] === value);
          return chain;
        },
        in: (col: string, values: unknown[]) => {
          rows = rows.filter((r) => values.includes(r[col]));
          return chain;
        },
        select: () => chain,
        single: async () => finish(),
        then: (resolve: (v: unknown) => void) => resolve(finish()),
      };
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const q = query(table);
      return {
        ...(q.api as object),
        update: (patch: Row) => q.apply("update", patch),
        delete: () => q.apply("delete"),
        upsert: (rows: Row | Row[]) =>
          q.apply("upsert", undefined, Array.isArray(rows) ? rows : [rows]),
      };
    },
    auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } },
  }),
}));
vi.mock("@/lib/auth/grant-sync", () => ({
  syncGrantFromMembership: async (
    ws: string,
    user: string,
    role: string | null,
    opts: unknown,
  ) => {
    synced.push([ws, user, role, opts]);
  },
}));
vi.mock("@/lib/auth/require", () => ({ gate: async () => actor }));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: { email: signedInEmail } } }) },
  }),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from "@bcontext-dev/contract/log";
import {
  OrgAdminError,
  gateOrgAdmin,
  removeOrgMember,
  updateOrgMember,
} from "./admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const headers = { origin: "http://localhost", host: "localhost" };
const req = () => new Request("http://localhost/api/organizations/acme", { headers });

beforeEach(() => {
  actor = { kind: "user", userId: "u-owner" };
  signedInEmail = "owner@acme.test";
  process.env.ADMIN_EMAILS = "founder@example.com";
  db.organizations = [
    { id: ORG, slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  db.organization_memberships = [
    { organization_id: ORG, user_id: "u-owner", role: "owner" },
    { organization_id: ORG, user_id: "u-2", role: "editor" },
  ];
  db.workspaces = [
    { id: "w-1", organization_id: ORG },
    { id: "w-2", organization_id: ORG },
    { id: "w-3", organization_id: ORG },
    { id: "w-other", organization_id: OTHER_ORG },
  ];
  db.memberships = [
    { user_id: "u-2", workspace_id: "w-1", role: "editor" },
    { user_id: "u-2", workspace_id: "w-2", role: "editor" },
  ];
});

afterEach(() => {
  synced.length = 0;
});

describe("gateOrgAdmin", () => {
  it("answers 404 to somebody who does not administer the organization", async () => {
    actor = { kind: "user", userId: "u-2" };
    const res = await gateOrgAdmin(req(), "acme");
    expect(res).toBeInstanceOf(Response);
    // Identical to a missing organization: a 403 here would confirm the
    // company is a customer, which is the fact an outsider is fishing for.
    expect((res as Response).status).toBe(404);
    expect(await (res as Response).json()).toEqual({ error: "not_found" });
    const stranger = await gateOrgAdmin(req(), "does-not-exist");
    expect((stranger as Response).status).toBe(404);
  });

  it("is a person's action, not a token's", async () => {
    actor = { kind: "agent", workspaceId: "w-1", scopes: [], tokenId: "t", createdBy: null };
    expect(((await gateOrgAdmin(req(), "acme")) as Response).status).toBe(401);
  });

  it("takes the slug or the id, and names the caller's role", async () => {
    const bySlug = await gateOrgAdmin(req(), "acme");
    const byId = await gateOrgAdmin(req(), ORG);
    expect(bySlug).toMatchObject({ org: { id: ORG }, role: "owner" });
    expect(byId).toMatchObject({ org: { slug: "acme" }, role: "owner" });
    // The customer's own administrators are in by their membership, not by
    // any allowlist, and nothing about that is an override.
    expect(bySlug).toMatchObject({ via_platform_admin: false });
  });

  it("lets the platform admin read a customer they belong to in no way", async () => {
    actor = { kind: "user", userId: "u-founder" };
    signedInEmail = "founder@example.com";
    // The organization exists and answers 404 all the same, until the route
    // asks for the override by name.
    expect(((await gateOrgAdmin(req(), "acme")) as Response).status).toBe(404);

    const reading = await gateOrgAdmin(req(), "acme", { platformAdmin: "read" });
    expect(reading).toMatchObject({
      org: { id: ORG },
      role: "admin",
      via_platform_admin: true,
    });
  });

  it("keeps the override to the allowlist", async () => {
    actor = { kind: "user", userId: "u-2" };
    signedInEmail = "ana@acme.test";
    const res = await gateOrgAdmin(req(), "acme", { platformAdmin: "read" });
    expect((res as Response).status).toBe(404);
  });

  it("says in the log that the allowlist, not a membership, is what let them in", async () => {
    actor = { kind: "user", userId: "u-founder" };
    signedInEmail = "founder@example.com";
    await gateOrgAdmin(req(), "acme", { platformAdmin: "read" });
    expect(log.info).toHaveBeenCalledWith(
      "org.admin.platform_override",
      expect.objectContaining({ organization_id: ORG, actor_id: "u-founder" }),
    );
  });
});

describe("the last owner", () => {
  it("cannot be demoted", async () => {
    await expect(
      updateOrgMember(ORG, "u-owner", { role: "admin" }, "u-2"),
    ).rejects.toMatchObject({ code: "last_owner", status: 409 });
    expect(db.organization_memberships?.[0]).toMatchObject({ role: "owner" });
  });

  it("cannot be removed", async () => {
    await expect(removeOrgMember(ORG, "u-owner", "u-2")).rejects.toBeInstanceOf(
      OrgAdminError,
    );
    expect(db.organization_memberships).toHaveLength(2);
  });

  it("stops being the last one once there is another", async () => {
    db.organization_memberships?.push({
      organization_id: ORG,
      user_id: "u-3",
      role: "owner",
    });
    await updateOrgMember(ORG, "u-owner", { role: "admin" }, "u-3");
    expect(db.organization_memberships?.[0]).toMatchObject({ role: "admin" });
  });
});

describe("an owner cannot strip their own role", () => {
  it("refuses with a message rather than a 500", async () => {
    db.organization_memberships?.push({
      organization_id: ORG,
      user_id: "u-3",
      role: "owner",
    });
    await expect(
      updateOrgMember(ORG, "u-owner", { role: "viewer" }, "u-owner"),
    ).rejects.toMatchObject({
      code: "self_demotion",
      message: "You cannot change your own owner role — ask another owner to do it.",
    });
  });
});

describe("updateOrgMember reconciles workspace access", () => {
  it("adds what is missing and takes away what is not on the list", async () => {
    await updateOrgMember(ORG, "u-2", { workspaces: ["w-2", "w-3"] }, "u-owner");

    const reach = (db.memberships ?? [])
      .filter((m) => m.user_id === "u-2")
      .map((m) => m.workspace_id)
      .sort();
    expect(reach).toEqual(["w-2", "w-3"]);
    // The grant is authoritative, so both halves have to travel together: the
    // admission reinstates, the removal revokes.
    expect(synced).toEqual([
      ["w-3", "u-2", "editor", { reinstate: true }],
      ["w-1", "u-2", null, undefined],
    ]);
  });

  it("refuses a workspace that belongs to another organization", async () => {
    await expect(
      updateOrgMember(ORG, "u-2", { workspaces: ["w-other"] }, "u-owner"),
    ).rejects.toMatchObject({ code: "invalid_workspaces", status: 400 });
    expect(db.memberships).toHaveLength(2);
  });

  it("leaves an administrator's rows alone — their reach is the org role", async () => {
    await updateOrgMember(ORG, "u-2", { role: "admin", workspaces: [] }, "u-owner");
    expect(db.memberships).toHaveLength(2);
    // Deleting those rows would revoke the grants, and a revoked grant denies
    // before the org role is ever consulted.
    expect(synced).toEqual([]);
  });
});

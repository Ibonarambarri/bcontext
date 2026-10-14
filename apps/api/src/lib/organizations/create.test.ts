import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Self-service organization creation: who may do it (`ORG_CREATION`), the
 * slug rule (an explicit one is taken as is or refused), and the rollback
 * that keeps a half-made organization from surviving a failed step.
 */
type Write = { table: string; op: "insert" | "delete"; payload?: Record<string, unknown> };

const writes: Write[] = [];
let existingSlugs: string[] = [];
let failMembership = false;
let failWorkspace = false;

function makeAdmin() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let pending: Write | null = null;
    b.select = () => b;
    b.eq = () => b;
    b.insert = (payload: Record<string, unknown>) => {
      pending = { table, op: "insert", payload };
      writes.push(pending);
      return b;
    };
    b.delete = () => {
      writes.push({ table, op: "delete" });
      return b;
    };
    b.single = async () => ({
      data: {
        id: "org-1",
        slug: pending?.payload?.slug,
        name: pending?.payload?.name,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      error: null,
    });
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === "organizations" && !pending) {
        return resolve({ data: existingSlugs.map((slug) => ({ slug })), error: null });
      }
      if (table === "organization_memberships" && pending && failMembership) {
        return resolve({ data: null, error: { message: "boom" } });
      }
      return resolve({ data: null, error: null });
    };
    return b;
  };
  return { from };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@/lib/workspaces/registry", () => ({
  WorkspaceCreateError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code);
    }
  },
  createWorkspaceForUser: async (_userId: string, input: { organization: string; name: string }) => {
    if (failWorkspace) throw new Error("workspace insert failed");
    return { id: "ws-1", slug: "general", name: input.name, organization_id: input.organization };
  },
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createOrganizationForUser, mayCreateOrganization } from "./create";

const create = (over: Partial<Parameters<typeof createOrganizationForUser>[0]> = {}) =>
  createOrganizationForUser({ userId: "u-1", email: "ana@acme.test", name: "Acme", ...over });

afterEach(() => {
  writes.length = 0;
  existingSlugs = [];
  failMembership = false;
  failWorkspace = false;
  delete process.env.ORG_CREATION;
  delete process.env.ADMIN_EMAILS;
});

describe("mayCreateOrganization", () => {
  it("is open to everyone by default", () => {
    expect(mayCreateOrganization("anyone@example.com")).toBe(true);
  });

  it("keeps creation to instance admins with ORG_CREATION=admin", () => {
    process.env.ORG_CREATION = "admin";
    process.env.ADMIN_EMAILS = "root@example.com";
    expect(mayCreateOrganization("anyone@example.com")).toBe(false);
    expect(mayCreateOrganization("Root@Example.com")).toBe(true);
  });
});

describe("createOrganizationForUser", () => {
  it("creates the organization, makes the caller its owner and opens a first workspace", async () => {
    const result = await create();
    expect(result.organization).toMatchObject({ id: "org-1", slug: "acme", name: "Acme" });
    expect(result.workspace).toMatchObject({ name: "General", organization_id: "org-1" });
    expect(writes).toEqual([
      { table: "organizations", op: "insert", payload: { slug: "acme", name: "Acme" } },
      {
        table: "organization_memberships",
        op: "insert",
        payload: { user_id: "u-1", organization_id: "org-1", role: "owner" },
      },
    ]);
  });

  it("derives and disambiguates the slug when none is given", async () => {
    existingSlugs = ["acme"];
    const result = await create();
    expect(result.organization.slug).toBe("acme-2");
  });

  it("refuses an explicit slug that is taken, before writing anything", async () => {
    existingSlugs = ["acme"];
    await expect(create({ slug: "acme" })).rejects.toMatchObject({ status: 409, code: "slug_taken" });
    expect(writes).toEqual([]);
  });

  it("refuses a non-admin when ORG_CREATION=admin", async () => {
    process.env.ORG_CREATION = "admin";
    process.env.ADMIN_EMAILS = "root@example.com";
    await expect(create()).rejects.toMatchObject({ status: 403, code: "org_creation_restricted" });
    expect(writes).toEqual([]);
  });

  it("undoes the organization when the membership cannot be written", async () => {
    failMembership = true;
    await expect(create()).rejects.toMatchObject({ status: 503, code: "membership_failed" });
    expect(writes.filter((w) => w.op === "delete").map((w) => w.table)).toContain("organizations");
  });

  it("undoes the organization when the first workspace fails", async () => {
    failWorkspace = true;
    await expect(create()).rejects.toThrow("workspace insert failed");
    expect(writes.filter((w) => w.op === "delete").map((w) => w.table)).toContain("organizations");
  });
});

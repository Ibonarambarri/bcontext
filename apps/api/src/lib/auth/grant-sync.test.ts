import { describe, expect, it } from "vitest";
import { VERBS, verbsForRole, verbsForScopes, type Verb } from "./grants";

/**
 * "role → verbs", the one translation.
 *
 * It very nearly became two. `grants.ts` reads a role when no grant row exists
 * and `grant-sync.ts` writes one when a membership changes, and the first cut of
 * this test asserted that a copy in each file agreed — which is the same shape
 * as the 0062 backfill, where a second copy of this table had already drifted
 * from the first before anyone noticed. Two copies plus a test that compares
 * them is still two copies; the test only narrows the window. So `grant-sync.ts`
 * imports this one, and what is left to check is the table itself.
 */

/**
 * Restated here on purpose — the one place a second copy earns its keep. This is
 * not a duplicate implementation that can drift silently; it is the expectation,
 * and a change to a role's verbs is supposed to fail here and make someone
 * decide, rather than sail through because the only witness followed along.
 */
const EXPECTED: Record<string, Verb[]> = {
  owner: [...VERBS],
  admin: [...VERBS],
  // Shaping the taxonomy (create, describe, relate) is part of writing;
  // merging and deleting tags (`tags:delete`) stay with owner/admin.
  editor: ["read", "write", "delete", "tags:create", "tags:update"],
  agent: ["read", "write", "delete", "tags:create", "tags:update"],
  viewer: ["read"],
};

describe("role to verbs", () => {
  it.each(Object.entries(EXPECTED))("%s", (role, expected) => {
    expect([...verbsForRole(role)].sort()).toEqual([...expected].sort());
  });

  it("gives an unrecognised role the least, never the most", () => {
    // A role added to the database and forgotten here must not inherit power.
    expect([...verbsForRole("some-future-role")]).toEqual(["read"]);
  });

  it("covers every role the database allows", () => {
    // From the CHECK constraint in 0001_init.sql. A role missing from EXPECTED
    // would silently fall through to the default and grant read only.
    const dbRoles = ["owner", "admin", "editor", "viewer", "agent"];
    for (const role of dbRoles) {
      expect(Object.keys(EXPECTED), `role "${role}" is not covered`).toContain(role);
    }
  });

  it("keeps merging and deleting tags with owner and admin", () => {
    // `tags:delete` rewrites how everything under the absorbed tag is
    // classified — and other principals' reaches, when those are tag-based.
    for (const [role, verbs] of Object.entries(EXPECTED)) {
      expect(verbs.includes("tags:delete"), `role "${role}"`).toBe(role === "owner" || role === "admin");
    }
  });

  it("only owner and admin may hand out access", () => {
    // `admin` is the verb that grants. An editor holding it would make every
    // safeguard in admin.ts reachable by anyone who can write a node.
    for (const [role, verbs] of Object.entries(EXPECTED)) {
      const canGrant = verbs.includes("admin");
      expect(canGrant, `role "${role}"`).toBe(role === "owner" || role === "admin");
    }
  });
});

describe("scopes to verbs", () => {
  it("lets a plain writer token shape the taxonomy but not dissolve it", () => {
    // The agent lab's first stumble: a `nodes:write` token could file work
    // but not create the tag to file it under. Creating, editing and relating
    // tags ride on the write scope; merge/delete still need the wildcard.
    const writer = verbsForScopes(["nodes:read", "nodes:write"]);
    expect(writer).toContain("tags:create");
    expect(writer).toContain("tags:update");
    expect(writer).not.toContain("tags:delete");
  });

  it("gives the admin wildcard every tag verb exactly once", () => {
    const admin = verbsForScopes(["nodes:read", "nodes:write", "admin:*"]);
    expect(admin.filter((verb) => verb.startsWith("tags:")).sort()).toEqual(["tags:create", "tags:delete", "tags:update"]);
    expect(new Set(admin).size).toBe(admin.length);
  });

  it("gives a reader nothing of the taxonomy", () => {
    expect(verbsForScopes(["nodes:read"]).some((verb) => verb.startsWith("tags:"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { canGrant, isSelfGrant, type Grant, type Reach } from "./grants";
import { ViewQuerySchema } from "@bcontext-dev/contract/views/schema";

/**
 * The no-escalation rule, tested on its own.
 *
 * Exposing "grant access" over MCP is only defensible if widening yourself is
 * impossible rather than merely discouraged. Every other safeguard — the admin
 * verb not being handed out by default, human confirmation, the audit trail —
 * assumes this one holds. If a principal can grant itself more than it has,
 * none of the rest matters.
 */
const reachOf = (tags: string[]): Reach => ({
  type: "query",
  query: ViewQuerySchema.parse({ schema_version: 1, tags_any: tags }),
});

const granter = (verbs: string[], reach: Reach = { type: "all" }): Grant => ({
  workspaceId: "ws-1",
  principal: { kind: "user", id: "admin-1" },
  verbs: verbs as Grant["verbs"],
  reach,
});

describe("verbs cannot be widened", () => {
  it("refuses a verb the granter does not hold", () => {
    const result = canGrant(granter(["read", "admin"]), ["read", "delete"], { type: "all" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/delete/);
  });

  it("allows a subset", () => {
    expect(canGrant(granter(["read", "write", "admin"]), ["read"], { type: "all" }).ok).toBe(true);
  });

  it("allows granting exactly what you hold", () => {
    expect(canGrant(granter(["read", "write"]), ["read", "write"], { type: "all" }).ok).toBe(true);
  });
});

describe("reach cannot be widened", () => {
  it("an unrestricted granter may grant anything", () => {
    expect(canGrant(granter(["read"]), ["read"], reachOf(["finanzas"])).ok).toBe(true);
  });

  it("a narrowed granter cannot hand out unrestricted reach", () => {
    // The obvious escalation: narrowed to finanzas, grants `all`, then reads
    // through whoever it granted to.
    const result = canGrant(granter(["read"], reachOf(["finanzas"])), ["read"], { type: "all" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unrestricted/);
  });

  it("a narrowed granter cannot grant a tag it cannot see itself", () => {
    const result = canGrant(
      granter(["read"], reachOf(["finanzas"])),
      ["read"],
      reachOf(["ingenieria"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ingenieria/);
  });

  it("a narrowed granter may grant a subset of its own reach", () => {
    const result = canGrant(
      granter(["read"], reachOf(["finanzas", "legal"])),
      ["read"],
      reachOf(["finanzas"]),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a reach it cannot prove is narrower", () => {
    // Comparing two arbitrary queries precisely is undecidable, so anything not
    // provably narrower is refused. Conservative on purpose: the failure mode of
    // guessing wrong here is a silent privilege escalation.
    const result = canGrant(granter(["read"], reachOf(["finanzas"])), ["read"], {
      type: "query",
      query: ViewQuerySchema.parse({ schema_version: 1 }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("self-granting", () => {
  it("is recognised regardless of verbs held", () => {
    const admin = granter(["read", "write", "delete", "admin"]);
    expect(isSelfGrant(admin, { kind: "user", id: "admin-1" })).toBe(true);
  });

  it("does not fire for a different principal of the same kind", () => {
    expect(isSelfGrant(granter(["admin"]), { kind: "user", id: "someone-else" })).toBe(false);
  });

  it("does not confuse a user and an agent sharing an id", () => {
    // Ids come from different tables; a collision must not read as "self".
    expect(isSelfGrant(granter(["admin"]), { kind: "agent", id: "admin-1" })).toBe(false);
  });
});

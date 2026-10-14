import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Chainable Supabase stub in the shape of grants.test.ts, plus a record of
 * every write. Builders are thenable because `revokeInstallPrincipal` awaits
 * an `update().eq()` chain directly, exactly as supabase-js allows — a mock
 * without `.then` there resolves to the builder and the test proves nothing.
 */
const tableData: Record<string, unknown> = {};
const tableError: Record<string, { code: string; message: string }> = {};
const writes: Array<{ table: string; op: "upsert" | "update"; payload: Record<string, unknown> }> = [];

function makeAdmin() {
  const builder = (table: string) => {
    const result = async () => ({ data: tableData[table] ?? null, error: tableError[table] ?? null });
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in"]) b[m] = () => b;
    b.upsert = (payload: Record<string, unknown>) => {
      writes.push({ table, op: "upsert", payload });
      return b;
    };
    b.update = (payload: Record<string, unknown>) => {
      writes.push({ table, op: "update", payload });
      return b;
    };
    b.maybeSingle = result;
    b.single = result;
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      result().then(resolve, reject);
    return b;
  };
  return { from: (t: string) => builder(t) };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from "@bcontext-dev/contract/log";
import { isDenied, type Grant } from "./grants";
import {
  describeInstallAccess,
  ensureInstallPrincipal,
  resolveInstallGrant,
  revokeInstallPrincipal,
} from "./install-principal";

const WS = "ws-1";
const INSTALL = "inst-1";
const PRINCIPAL = "cp-1";
const FINANZAS = { type: "query", query: { schema_version: 1, tags_any: ["finanzas"] } };

afterEach(() => {
  for (const k of Object.keys(tableData)) delete tableData[k];
  for (const k of Object.keys(tableError)) delete tableError[k];
  writes.length = 0;
  vi.clearAllMocks();
});

const upserts = (table: string) => writes.filter((w) => w.table === table && w.op === "upsert");

describe("ensureInstallPrincipal", () => {
  it("writes a service_account principal and a read-only grant with the documented default reach", async () => {
    tableData.capability_principals = { id: PRINCIPAL };
    const access = await ensureInstallPrincipal({ workspaceId: WS, installId: INSTALL, displayName: "Slack bot" });

    expect(upserts("capability_principals")[0]?.payload).toMatchObject({
      workspace_id: WS,
      kind: "service_account",
      source_type: "connector_install",
      source_id: INSTALL,
      disabled_at: null,
    });
    expect(upserts("workspace_grants")[0]?.payload).toMatchObject({
      workspace_id: WS,
      principal_kind: "service_account",
      principal_id: PRINCIPAL,
      verbs: ["read"],
      reach: { type: "all" },
      revoked_at: null,
    });
    // The default is said out loud, and it says how to change it.
    expect(access).toMatchObject({ principal: { kind: "service_account", id: PRINCIPAL }, reach: "all" });
    expect(access?.note).toMatch(/everything/);
    expect(access?.note).toMatch(/narrow/);
  });

  it("keeps a reach an admin already narrowed and lifts a revocation on reinstall", async () => {
    tableData.capability_principals = { id: PRINCIPAL };
    tableData.workspace_grants = { reach: FINANZAS, revoked_at: "2026-01-01T00:00:00Z" };
    const access = await ensureInstallPrincipal({ workspaceId: WS, installId: INSTALL, displayName: "Slack bot" });
    expect(upserts("workspace_grants")[0]?.payload).toMatchObject({ reach: FINANZAS, revoked_at: null });
    expect(access?.reach).toBe("narrowed");
  });

  it("returns null and logs when the principal cannot be written, so the install still goes through", async () => {
    // What the pre-migration database answers: the source_type check refuses.
    tableError.capability_principals = { code: "23514", message: "violates check constraint" };
    const access = await ensureInstallPrincipal({ workspaceId: WS, installId: INSTALL, displayName: "Slack bot" });
    expect(access).toBeNull();
    expect(upserts("workspace_grants")).toEqual([]);
    expect(log.error).toHaveBeenCalledWith("install_principal.failed", expect.objectContaining({ op: "principal" }));
  });
});

describe("resolveInstallGrant", () => {
  it("is null for an install with no principal — the webhook's signal to fall back with a warning", async () => {
    expect(await resolveInstallGrant(WS, INSTALL)).toBeNull();
  });

  it("resolves the install's own grant row, never a person's", async () => {
    tableData.capability_principals = { id: PRINCIPAL };
    tableData.workspace_grants = { verbs: ["read"], reach: FINANZAS, revoked_at: null, expires_at: null };
    const resolved = await resolveInstallGrant(WS, INSTALL);
    expect(resolved?.principalId).toBe(PRINCIPAL);
    const grant = resolved!.grant as Grant;
    expect(isDenied(grant)).toBe(false);
    expect(grant.principal).toEqual({ kind: "service_account", id: PRINCIPAL });
    expect(grant.verbs).toEqual(["read"]);
    expect(grant.reach.type).toBe("query");
  });

  it("denies — does not fall back — when the grant is revoked", async () => {
    tableData.capability_principals = { id: PRINCIPAL };
    tableData.workspace_grants = { verbs: ["read"], reach: { type: "all" }, revoked_at: "2026-01-01T00:00:00Z", expires_at: null };
    const resolved = await resolveInstallGrant(WS, INSTALL);
    expect(resolved).not.toBeNull();
    expect(isDenied(resolved!.grant)).toBe(true);
  });

  it("denies on a lookup error instead of reading it as 'no principal'", async () => {
    // `null` would send the webhook to the system grant: a database hiccup
    // must not hand the bot the whole workspace.
    tableError.capability_principals = { code: "XX000", message: "boom" };
    const resolved = await resolveInstallGrant(WS, INSTALL);
    expect(resolved).toEqual({ principalId: null, grant: { denied: "not_found" } });
  });
});

describe("revokeInstallPrincipal", () => {
  it("revokes the grant and disables the principal, deleting neither", async () => {
    tableData.capability_principals = { id: PRINCIPAL };
    await revokeInstallPrincipal(WS, INSTALL);
    const updates = writes.filter((w) => w.op === "update");
    expect(updates.map((w) => w.table).sort()).toEqual(["capability_principals", "workspace_grants"]);
    expect(updates.find((w) => w.table === "workspace_grants")?.payload.revoked_at).toEqual(expect.any(String));
    expect(updates.find((w) => w.table === "capability_principals")?.payload.disabled_at).toEqual(expect.any(String));
  });

  it("is a no-op for an install that never had a principal", async () => {
    await revokeInstallPrincipal(WS, INSTALL);
    expect(writes).toEqual([]);
  });
});

describe("describeInstallAccess", () => {
  it("names the legacy state and the revoked state without pretending either is scoped", () => {
    expect(describeInstallAccess(null)).toMatchObject({ principal: null, reach: "unscoped" });
    expect(describeInstallAccess({ principalId: PRINCIPAL, grant: { denied: "not_found" } })).toMatchObject({
      principal: { id: PRINCIPAL },
      reach: "revoked",
    });
    expect(describeInstallAccess({ principalId: null, grant: { denied: "not_found" } })).toMatchObject({
      principal: null,
      reach: "unavailable",
    });
  });
});

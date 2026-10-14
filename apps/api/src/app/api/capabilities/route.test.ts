/**
 * Registering a provider with a pasted token: the token goes to Vault, the
 * row keeps the reference, and neither the response nor the audit ledger
 * ever carries the token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const VAULT = "vault:0b8f5c3e-2f6a-4b1c-9d3e-7a8b9c0d1e2f";
const TOKEN = "ghp_pasted_once_never_returned";

const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
const failInsertOn = { table: null as string | null };

// Request-scoped client: a signed-in admin, and a table stub that records
// every insert so the test can look at what reached the connection row.
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const self: Record<string, unknown> = {};
      let inserted: Record<string, unknown> | null = null;
      for (const m of ["select", "eq", "is", "update"]) self[m] = () => self;
      self.insert = (row: Record<string, unknown>) => {
        inserted = row;
        inserts.push({ table, row });
        return self;
      };
      const outcome = () => failInsertOn.table === table && inserted
        ? { data: null, error: { message: `${table} refused` } }
        : { data: { id: `${table}-1`, role: "owner", key: "hooked", status: "approved" }, error: null };
      self.single = async () => outcome();
      self.maybeSingle = async () => outcome();
      self.then = (resolve: (v: unknown) => void) => resolve(outcome());
      return self;
    },
  }),
}));
const appendAudit = vi.fn(async () => {});
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAudit: (...a: unknown[]) => appendAudit(...(a as [])),
}));
const putNamedSecret = vi.fn(async () => VAULT);
const deleteSecret = vi.fn(async () => true);
vi.mock("@/lib/connectors/secrets", () => ({
  putNamedSecret: (...a: unknown[]) => putNamedSecret(...(a as [])),
  deleteSecret: (...a: unknown[]) => deleteSecret(...(a as [])),
}));

import { POST } from "./route";

function register(connection: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/capabilities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: WS,
      key: "hooked",
      type: "workflow",
      provider: "Example",
      title: "Hook",
      status: "approved",
      contract: { protocol: "webhook", tool: { name: "run", inputSchema: { type: "object" } } },
      connection: { endpointUrl: "https://hooks.example.com/run", allowedHosts: ["hooks.example.com"], ...connection },
    }),
  }));
}

afterEach(() => {
  inserts.length = 0;
  failInsertOn.table = null;
  appendAudit.mockClear();
  putNamedSecret.mockClear();
  deleteSecret.mockClear();
});

describe("POST /api/capabilities with a static credential", () => {
  it("stores the token in Vault, keeps only the reference, and returns nothing of it", async () => {
    const res = await register({ authType: "bearer", secret: TOKEN });
    expect(res.status).toBe(201);
    expect(putNamedSecret).toHaveBeenCalledTimes(1);
    expect((putNamedSecret.mock.calls[0] as unknown as [{ plaintext: string }])[0].plaintext).toBe(TOKEN);

    const connection = inserts.find((i) => i.table === "capability_connections")!.row;
    expect(connection.secret_ref).toBe(VAULT);
    expect(JSON.stringify(inserts)).not.toContain(TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain(TOKEN);
  });

  it("refuses the old environment-variable reference and any secret without a matching auth type", async () => {
    expect((await register({ authType: "bearer", secretRef: "BCONTEXT_CAP_LEGACY" })).status).toBe(400);
    expect((await register({ authType: "none", secret: TOKEN })).status).toBe(400);
    expect(putNamedSecret).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("discards the Vault entry when the connection row cannot be written", async () => {
    failInsertOn.table = "capability_connections";
    const res = await register({ authType: "header", authHeaderName: "x-api-key", secret: TOKEN });
    expect(res.status).toBe(500);
    expect(deleteSecret).toHaveBeenCalledWith(VAULT);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("answers 503 and writes nothing when Vault is unavailable", async () => {
    putNamedSecret.mockResolvedValueOnce("inline:bm9wZQ==");
    const res = await register({ authType: "bearer", secret: TOKEN });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe("credential_store_unavailable");
    expect(inserts).toHaveLength(0);
  });
});

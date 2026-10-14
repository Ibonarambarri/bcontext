/**
 * Replacing a provider's static credential: the new token is stored in
 * Vault before the lifecycle RPC runs, the RPC receives only the reference,
 * and a refused update discards the entry it would have owned. Reads never
 * expose the reference, only whether a credential is configured.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CAP = "8c9d0e1f-2a3b-4c5d-8e6f-7a8b9c0d1e2f";
const VAULT = "vault:0b8f5c3e-2f6a-4b1c-9d3e-7a8b9c0d1e2f";
const TOKEN = "rotated_token_never_returned";

vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => {
      const self: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) self[m] = () => self;
      self.maybeSingle = async () => ({ data: { role: "admin" }, error: null });
      return self;
    },
  }),
}));
const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    rpc: (...a: unknown[]) => ({ single: async () => rpc(...a) }),
    from: (table: string) => {
      const self: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) self[m] = () => self;
      self.maybeSingle = async () => ({
        data: table === "capabilities"
          ? { id: CAP, type: "workflow", deleted_at: null, current_version_id: "v-1" }
          : table === "capability_versions"
            ? { id: "v-1", version: 2, environment: "production", contract: {}, contract_digest: "d", created_at: "" }
            : table === "capability_connections"
              ? { id: "conn-1", environment: "production", endpoint_url: "https://hooks.example.com/run", auth_type: "bearer", auth_header_name: null, secret_ref: VAULT, allowed_hosts: ["hooks.example.com"], timeout_ms: 5000, enabled: true, updated_at: "" }
              : null,
        error: null,
      });
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

import { GET, PATCH } from "./route";

function patch(connection: Record<string, unknown>) {
  return PATCH(new Request(`http://localhost/api/capabilities/${CAP}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: WS,
      expected_updated_at: "2026-09-13T10:00:00.000Z",
      type: "workflow",
      provider: "Example",
      title: "Hook",
      contract: { protocol: "webhook", tool: { name: "run", inputSchema: { type: "object" } } },
      connection: { endpointUrl: "https://hooks.example.com/run", allowedHosts: ["hooks.example.com"], ...connection },
    }),
  }), { params: Promise.resolve({ id: CAP }) });
}

afterEach(() => {
  rpc.mockReset();
  appendAudit.mockClear();
  putNamedSecret.mockClear();
  deleteSecret.mockClear();
});

describe("PATCH /api/capabilities/:id credential replacement", () => {
  it("stores the new token first and passes only its reference to the RPC", async () => {
    rpc.mockResolvedValue({ data: { capability_id: CAP, version_id: "v-1", connection_id: "conn-1", grants_revoked: 0, material_change: true }, error: null });
    const res = await patch({ authType: "bearer", credentialMode: "replace", secret: TOKEN });
    expect(res.status).toBe(200);
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("update_capability_provider");
    expect(args.p_secret_ref).toBe(VAULT);
    expect(args.p_preserve_credential).toBe(false);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(deleteSecret).not.toHaveBeenCalled();
    const body = await res.text();
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(VAULT);
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain(TOKEN);
  });

  it("does not touch Vault when the credential is preserved", async () => {
    rpc.mockResolvedValue({ data: { capability_id: CAP, version_id: "v-1", connection_id: "conn-1", grants_revoked: 0, material_change: false }, error: null });
    expect((await patch({ authType: "bearer", credentialMode: "preserve" })).status).toBe(200);
    expect(putNamedSecret).not.toHaveBeenCalled();
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_secret_ref).toBeNull();
  });

  it("discards the entry it stored when the RPC refuses the update", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "capability_provider_stale" } });
    const res = await patch({ authType: "bearer", credentialMode: "replace", secret: TOKEN });
    expect(res.status).toBe(409);
    expect(deleteSecret).toHaveBeenCalledWith(VAULT);
  });
});

describe("GET /api/capabilities/:id", () => {
  it("says a credential is configured without revealing the reference", async () => {
    const res = await GET(new Request(`http://localhost/api/capabilities/${CAP}?workspace_id=${WS}`), { params: Promise.resolve({ id: CAP }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { connection: Record<string, unknown> };
    expect(body.connection.credential_configured).toBe(true);
    expect(body.connection).not.toHaveProperty("secret_ref");
    expect(JSON.stringify(body)).not.toContain(VAULT);
  });
});

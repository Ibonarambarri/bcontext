import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({ rpc: mocks.rpc }),
}));

vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: mocks.warn },
}));

import {
  deleteSecret,
  getSecret,
  putNamedSecret,
  putSecret,
} from "./secrets";

describe("connector secrets", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.warn.mockReset();
  });

  afterEach(() => {
    delete process.env.CONNECTOR_TEST_SECRET;
    vi.unstubAllEnvs();
  });

  it("resolves environment and inline refs without touching Vault", async () => {
    process.env.CONNECTOR_TEST_SECRET = "from-env";

    await expect(getSecret("env:CONNECTOR_TEST_SECRET")).resolves.toBe(
      "from-env",
    );
    await expect(
      getSecret(`inline:${Buffer.from("from-inline").toString("base64")}`),
    ).resolves.toBe("from-inline");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reads Vault secrets through the service-role RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "decrypted-value", error: null });

    await expect(
      getSecret("vault:8d000000-0000-4000-8000-000000000001"),
    ).resolves.toBe("decrypted-value");
    expect(mocks.rpc).toHaveBeenCalledWith("read_vault_secret", {
      secret_id: "8d000000-0000-4000-8000-000000000001",
    });
  });

  it("does not expose a Vault read failure", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "unavailable" },
    });

    await expect(
      getSecret("vault:8d000000-0000-4000-8000-000000000001"),
    ).resolves.toBeNull();
  });

  it("creates or updates the connector's named Vault secret", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: "8d000000-0000-4000-8000-000000000001",
      error: null,
    });

    await expect(
      putSecret({
        workspaceId: "9a000000-0000-4000-8000-000000000002",
        connectorId: "linear",
        plaintext: "access-token",
      }),
    ).resolves.toBe("vault:8d000000-0000-4000-8000-000000000001");
    expect(mocks.rpc).toHaveBeenCalledWith("create_secret_or_update", {
      secret_value: "access-token",
      secret_name:
        "connector:linear:9a000000-0000-4000-8000-000000000002",
    });
  });

  it("supports stable names for OAuth credential bundle rotation", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: "f2000000-0000-4000-8000-000000000003",
      error: null,
    });

    await expect(
      putNamedSecret({
        name: "capability-oauth:attempt:05000000-0000-4000-8000-000000000004",
        plaintext: '{"access_token":"secret"}',
      }),
    ).resolves.toBe("vault:f2000000-0000-4000-8000-000000000003");
    expect(mocks.rpc).toHaveBeenCalledWith("create_secret_or_update", {
      secret_value: '{"access_token":"secret"}',
      secret_name:
        "capability-oauth:attempt:05000000-0000-4000-8000-000000000004",
    });
  });

  it("falls back to inline storage outside production when Vault is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "unavailable" },
    });

    const ref = await putSecret({
      workspaceId: "9a000000-0000-4000-8000-000000000002",
      connectorId: "linear",
      plaintext: "dev-token",
    });
    expect(ref).toBe(
      `inline:${Buffer.from("dev-token", "utf8").toString("base64")}`,
    );
  });

  it("fails closed in production when Vault is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.rpc.mockRejectedValueOnce(new Error("unavailable"));

    await expect(
      putSecret({
        workspaceId: "9a000000-0000-4000-8000-000000000002",
        connectorId: "linear",
        plaintext: "prod-token",
      }),
    ).rejects.toThrow("connector secret storage unavailable");
  });

  it("deletes only Vault-backed secrets through the service-role RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });

    await expect(
      deleteSecret("vault:8d000000-0000-4000-8000-000000000001"),
    ).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("delete_vault_secret", {
      secret_id: "8d000000-0000-4000-8000-000000000001",
    });

    mocks.rpc.mockClear();
    await expect(deleteSecret("env:CONNECTOR_TEST_SECRET")).resolves.toBe(
      false,
    );
    await expect(deleteSecret("inline:Zm9v")).resolves.toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports Vault deletion failures without throwing", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: false,
      error: { message: "unavailable" },
    });

    await expect(
      deleteSecret("vault:8d000000-0000-4000-8000-000000000001"),
    ).resolves.toBe(false);

    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(
      deleteSecret("vault:8d000000-0000-4000-8000-000000000001"),
    ).resolves.toBe(false);
  });
});

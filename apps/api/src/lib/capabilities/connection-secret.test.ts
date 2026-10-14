import { afterEach, describe, expect, it, vi } from "vitest";

const putNamedSecret = vi.fn();
const deleteSecret = vi.fn();
vi.mock("@/lib/connectors/secrets", () => ({
  putNamedSecret: (...a: unknown[]) => putNamedSecret(...a),
  deleteSecret: (...a: unknown[]) => deleteSecret(...a),
}));

import { ConnectionSecretError, discardConnectionSecret, storeConnectionSecret } from "./connection-secret";

const WS = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const VAULT = "vault:0b8f5c3e-2f6a-4b1c-9d3e-7a8b9c0d1e2f";

afterEach(() => {
  putNamedSecret.mockReset();
  deleteSecret.mockReset();
});

describe("storeConnectionSecret", () => {
  it("hands the token to Vault under a fresh name per write and returns the reference", async () => {
    putNamedSecret.mockResolvedValue(VAULT);
    const ref = await storeConnectionSecret({ workspaceId: WS, plaintext: "ghp_pasted_once" });
    expect(ref).toBe(VAULT);
    const [first] = putNamedSecret.mock.calls[0] as [{ name: string; plaintext: string }];
    expect(first.plaintext).toBe("ghp_pasted_once");
    expect(first.name).toMatch(new RegExp(`^capability-connection:${WS}:[0-9a-f-]{36}$`));

    await storeConnectionSecret({ workspaceId: WS, plaintext: "rotated" });
    const [second] = putNamedSecret.mock.calls[1] as [{ name: string }];
    expect(second.name).not.toBe(first.name);
  });

  it("refuses anything that is not a Vault reference, so the row check never sees it", async () => {
    putNamedSecret.mockResolvedValue("inline:Z2hw");
    await expect(storeConnectionSecret({ workspaceId: WS, plaintext: "ghp" })).rejects.toBeInstanceOf(ConnectionSecretError);
    putNamedSecret.mockRejectedValue(new Error("vault down"));
    const failure = await storeConnectionSecret({ workspaceId: WS, plaintext: "ghp" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConnectionSecretError);
    expect((failure as Error).message).not.toContain("ghp");
  });
});

describe("discardConnectionSecret", () => {
  it("deletes a stored reference and tolerates nothing to delete or a failing delete", async () => {
    deleteSecret.mockResolvedValue(true);
    await discardConnectionSecret(VAULT);
    expect(deleteSecret).toHaveBeenCalledWith(VAULT);
    await discardConnectionSecret(null);
    expect(deleteSecret).toHaveBeenCalledTimes(1);
    deleteSecret.mockRejectedValue(new Error("rpc"));
    await expect(discardConnectionSecret(VAULT)).resolves.toBeUndefined();
  });
});

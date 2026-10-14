import { afterEach, describe, it, expect, vi } from "vitest";

/** Agent identities minted while a test ran, and the ones unwound again. */
const connections: Array<Record<string, unknown>> = [];
const revokedAgents: string[] = [];

vi.mock("@/lib/agents/connections.server", () => ({
  createAgentConnection: async (_admin: unknown, input: Record<string, unknown>) => {
    connections.push(input);
    return `agent-${connections.length}`;
  },
  revokeAgentEverywhere: async (_admin: unknown, agentId: string) => {
    revokedAgents.push(agentId);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({}) }));

import { createToken, sha256Hex, parseAuthHeader, verifyToken } from "./tokens";
import { hasScope, isScope, parseScopes } from "@bcontext-dev/contract/auth/scopes";
import type { SupabaseClient } from "@supabase/supabase-js";

afterEach(() => {
  connections.length = 0;
  revokedAgents.length = 0;
});

describe("sha256Hex", () => {
  it("produces a 64-char hex digest", async () => {
    const out = await sha256Hex("hello");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the SHA-256 known answer for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic", async () => {
    const a = await sha256Hex("bcontext");
    const b = await sha256Hex("bcontext");
    expect(a).toBe(b);
  });
});

describe("parseAuthHeader", () => {
  it("extracts the plaintext token from a well-formed header", () => {
    const tok = "bctx_live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr";
    expect(parseAuthHeader(`Bearer ${tok}`)).toBe(tok);
  });

  it("returns null for missing header", () => {
    expect(parseAuthHeader(null)).toBeNull();
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader("")).toBeNull();
  });

  it("returns null for non-bearer schemes", () => {
    expect(parseAuthHeader("Basic abc")).toBeNull();
  });

  it("returns null for non-ctx_live prefixes", () => {
    expect(parseAuthHeader("Bearer ctx_test_xxx")).toBeNull();
    expect(parseAuthHeader("Bearer sk-abc123")).toBeNull();
  });

  it("rejects characters outside the base64url alphabet used in tokens", () => {
    expect(parseAuthHeader("Bearer bctx_live_abc!def")).toBeNull();
  });
});

describe("scopes", () => {
  it("isScope accepts known scopes only", () => {
    expect(isScope("nodes:read")).toBe(true);
    expect(isScope("nope")).toBe(false);
    expect(isScope(undefined)).toBe(false);
  });

  it("hasScope respects admin:* wildcard", () => {
    expect(hasScope(["admin:*"], "nodes:write")).toBe(true);
    expect(hasScope(["nodes:read"], "nodes:write")).toBe(false);
    expect(hasScope(["nodes:read", "chat:run"], "chat:run")).toBe(true);
  });

  it("hasScope does NOT let admin:* stand in for credentials:use", () => {
    // Handing an agent the plaintext of a secret is its own decision, and it
    // should be visible in the token's scope list rather than inherited from
    // "this one can do everything".
    expect(hasScope(["admin:*"], "credentials:use")).toBe(false);
    expect(hasScope(["admin:*", "credentials:use"], "credentials:use")).toBe(true);
    expect(hasScope(["credentials:use"], "nodes:write")).toBe(false);
  });

  it("parseScopes drops unknown + dedupes", () => {
    expect(parseScopes(["nodes:read", "nodes:read", "bogus", 7])).toEqual([
      "nodes:read",
    ]);
    expect(parseScopes("not-an-array")).toEqual([]);
  });
});

describe("verifyToken (discriminated result)", () => {
  /**
   * Minimal Supabase client mock. Each `from(table)` returns a tiny query
   * builder that records the chain and resolves to a configurable row,
   * matching the surface the implementation actually uses.
   */
  /** Updates that actually ran: a supabase-js builder only fires on `.then`. */
  const executedUpdates: Array<{ table: string; patch: Record<string, unknown> }> = [];

  function makeMockClient(rows: {
    api_tokens?: Record<string, unknown> | null;
    oauth_access_tokens?: Record<string, unknown> | null;
    user_api_tokens?: Record<string, unknown> | null;
  }): SupabaseClient {
    type Row = Record<string, unknown> | null;
    executedUpdates.length = 0;
    function tableBuilder(table: string, row: Row) {
      let pendingUpdate: Record<string, unknown> | null = null;
      const builder: {
        select: (cols?: string) => typeof builder;
        eq: (col: string, val: unknown) => typeof builder;
        update: (patch: Record<string, unknown>) => typeof builder;
        maybeSingle: () => Promise<{ data: Row; error: null }>;
        then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => Promise<unknown>;
      } = {
        select: () => builder,
        eq: () => builder,
        update: (patch) => {
          pendingUpdate = patch;
          return builder;
        },
        maybeSingle: async () => ({ data: row, error: null }),
        // Mirrors PostgREST's lazy builder: the request goes out on `.then`.
        then: (onOk) => {
          if (pendingUpdate) executedUpdates.push({ table, patch: pendingUpdate });
          return Promise.resolve(onOk({ data: null, error: null }));
        },
      };
      return builder;
    }
    return {
      from(table: string) {
        if (table === "api_tokens") return tableBuilder(table, rows.api_tokens ?? null);
        if (table === "oauth_access_tokens")
          return tableBuilder(table, rows.oauth_access_tokens ?? null);
        if (table === "user_api_tokens")
          return tableBuilder(table, rows.user_api_tokens ?? null);
        return tableBuilder(table, null);
      },
    } as unknown as SupabaseClient;
  }

  const validSuffix = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr"; // 44 chars matches token regex; the implementation just hashes whatever it gets
  const authHeader = `Bearer bctx_live_${validSuffix}`;

  it("returns scope: 'workspace' when the hash hits api_tokens", async () => {
    const client = makeMockClient({
      api_tokens: {
        id: "tok-ws-1",
        workspace_id: "ws-1",
        scopes: ["nodes:read"],
        revoked_at: null,
      },
    });
    const result = await verifyToken(client, authHeader);
    expect(result).not.toBeNull();
    expect(result?.scope).toBe("workspace");
    if (result?.scope === "workspace") {
      expect(result.workspaceId).toBe("ws-1");
      expect(result.tokenId).toBe("tok-ws-1");
      expect(result.scopes).toEqual(["nodes:read"]);
    }
  });

  it("returns scope: 'user' when the hash hits user_api_tokens", async () => {
    const client = makeMockClient({
      api_tokens: null,
      oauth_access_tokens: null,
      user_api_tokens: {
        id: "tok-user-1",
        user_id: "user-1",
        scopes: ["nodes:read", "nodes:write"],
        revoked_at: null,
      },
    });
    const result = await verifyToken(client, authHeader);
    expect(result).not.toBeNull();
    expect(result?.scope).toBe("user");
    if (result?.scope === "user") {
      expect(result.userId).toBe("user-1");
      expect(result.tokenId).toBe("tok-user-1");
      expect(result.scopes).toEqual(["nodes:read", "nodes:write"]);
    }
  });

  it("returns null when no table matches", async () => {
    const client = makeMockClient({});
    expect(await verifyToken(client, authHeader)).toBeNull();
  });

  it("stamps last_used_at on the token and last_seen_at on its agent", async () => {
    const client = makeMockClient({
      api_tokens: {
        id: "tok-ws-1",
        workspace_id: "ws-1",
        scopes: ["nodes:read"],
        revoked_at: null,
        agent_id: "agent-1",
      },
    });
    await verifyToken(client, authHeader);
    await new Promise((r) => setTimeout(r, 0));
    expect(executedUpdates.map((u) => u.table)).toEqual(["api_tokens", "agents"]);
    expect(executedUpdates[0]?.patch).toHaveProperty("last_used_at");
    expect(executedUpdates[1]?.patch).toHaveProperty("last_seen_at");
  });
});

describe("createToken (a credential is somebody)", () => {
  /**
   * A token is a connection, and the Agents tab and `agent_count` are counted
   * from agents — so a token that writes `agent_id: null` is a customer whose
   * Claude Code has been calling all week showing up nowhere.
   */
  function makeInsertClient(outcome: { error?: { message: string } } = {}) {
    const inserted: Array<Record<string, unknown>> = [];
    const client = {
      from: () => ({
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return {
            select: () => ({
              single: async () =>
                outcome.error
                  ? { data: null, error: outcome.error }
                  : {
                      data: {
                        id: "tok-1",
                        workspace_id: row.workspace_id,
                        name: row.name,
                        prefix: row.prefix,
                        last4: row.last4,
                        scopes: row.scopes,
                        created_at: "2026-09-06T00:00:00.000Z",
                        last_used_at: null,
                        revoked_at: null,
                      },
                      error: null,
                    },
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;
    return { client, inserted };
  }

  it("mints an agent identity for the workspace it is scoped to", async () => {
    const { client, inserted } = makeInsertClient();
    const result = await createToken(client, {
      workspaceId: "ws-1",
      name: "claude-code",
      scopes: ["nodes:read", "nodes:write"],
      createdBy: "u-1",
      provider: "claude_code",
    });

    expect(result.token).toMatch(/^bctx_live_/);
    expect(inserted[0]).toMatchObject({ workspace_id: "ws-1", agent_id: "agent-1" });
    expect(connections[0]).toMatchObject({
      ownerUserId: "u-1",
      name: "claude-code",
      provider: "claude_code",
      workspaceIds: ["ws-1"],
      scopes: ["nodes:read", "nodes:write"],
    });
  });

  it("uses the identity the caller already minted, and mints no second one", async () => {
    const { client, inserted } = makeInsertClient();
    await createToken(client, {
      workspaceId: "ws-1",
      name: "consented",
      scopes: ["nodes:read"],
      createdBy: "u-1",
      agentId: "agent-from-consent",
    });
    expect(inserted[0]).toMatchObject({ agent_id: "agent-from-consent" });
    expect(connections).toHaveLength(0);
  });

  it("leaves a token nobody minted without one — there is no owner to attach", async () => {
    const { client, inserted } = makeInsertClient();
    await createToken(client, {
      workspaceId: "ws-1",
      name: "system",
      scopes: ["nodes:read"],
      createdBy: null,
    });
    expect(inserted[0]).toMatchObject({ agent_id: null });
    expect(connections).toHaveLength(0);
  });

  it("unwinds the identity when the token is refused", async () => {
    const { client } = makeInsertClient({ error: { message: "row-level security" } });
    await expect(
      createToken(client, {
        workspaceId: "ws-1",
        name: "denied",
        scopes: ["nodes:read"],
        createdBy: "u-1",
      }),
    ).rejects.toThrow(/row-level security/);
    // Otherwise the Agents tab lists a connection that never connected.
    expect(revokedAgents).toEqual(["agent-1"]);
  });
});

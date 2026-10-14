import { describe, expect, it } from "vitest";
import {
  OAuthError,
  assertHttpsOrLoopback,
  authorizationServerMetadata,
  redeemCode,
  refreshAccessToken,
  revokeToken,
  verifyPkce,
} from "./oauth";
import { sha256Hex } from "./tokens";
import type { McpResource } from "@/lib/mcp/resource";

describe("oauth — assertHttpsOrLoopback", () => {
  it("accepts https URLs", () => {
    expect(() =>
      assertHttpsOrLoopback("https://app.example.com/cb"),
    ).not.toThrow();
  });
  it("accepts loopback http URLs", () => {
    expect(() => assertHttpsOrLoopback("http://127.0.0.1:8080/cb")).not.toThrow();
    expect(() => assertHttpsOrLoopback("http://localhost:3000/cb")).not.toThrow();
    expect(() => assertHttpsOrLoopback("http://[::1]/cb")).not.toThrow();
  });
  it("rejects plain http on a non-loopback host", () => {
    expect(() => assertHttpsOrLoopback("http://example.com/cb")).toThrow();
  });
  it("rejects garbage", () => {
    expect(() => assertHttpsOrLoopback("not a url")).toThrow();
  });
});

describe("oauth — verifyPkce (S256)", () => {
  // Test vector pulled from RFC 7636 §1.1:
  //   code_verifier   = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  //   code_challenge  = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  it("accepts the matching RFC 7636 vector", async () => {
    const ok = await verifyPkce({
      method: "S256",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered verifier", async () => {
    const ok = await verifyPkce({
      method: "S256",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl",
    });
    expect(ok).toBe(false);
  });

  it("plain method accepts equal strings", async () => {
    expect(
      await verifyPkce({ method: "plain", challenge: "abc", verifier: "abc" }),
    ).toBe(true);
    expect(
      await verifyPkce({ method: "plain", challenge: "abc", verifier: "abd" }),
    ).toBe(false);
  });
});

describe("oauth — authorizationServerMetadata", () => {
  it("returns RFC 8414 fields", () => {
    const meta = authorizationServerMetadata("https://context.example.com");
    expect(meta.issuer).toBe("https://context.example.com");
    expect(meta.authorization_endpoint).toBe("https://context.example.com/oauth/authorize");
    expect(meta.token_endpoint).toBe("https://context.example.com/api/oauth/token");
    expect(meta.registration_endpoint).toBe(
      "https://context.example.com/api/oauth/register",
    );
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });
});

describe("oauth — OAuthError", () => {
  it("serialises to a standard body", () => {
    const err = new OAuthError("invalid_grant", "code expired");
    expect(err.toBody()).toEqual({
      error: "invalid_grant",
      error_description: "code expired",
    });
  });
});

/**
 * `expires_in: 0` reads as "already expired" to every OAuth client — they
 * all compute `issuedAt + expires_in`, bcontext's own capability client
 * included. Claude Code discarded freshly minted user-scoped tokens the
 * moment it stored them. User-scoped tokens have no fixed expiry, so the
 * field must be absent (RFC 6749 §5.1 makes it optional), never 0.
 */
describe("oauth — redeemCode expires_in", () => {
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const CLIENT_ID = "client-1";
  const SECRET = "s3cret";
  const REDIRECT = "https://app.example.com/cb";

  /** Chainable stub covering the reads and writes redeemCode performs. */
  function makeAdmin(scopeKind: "workspace" | "user", secretHash: string) {
    const rows: Record<string, unknown> = {
      oauth_authorization_codes: {
        client_id: CLIENT_ID,
        user_id: "u1",
        workspace_id: scopeKind === "workspace" ? "ws-1" : null,
        scope_kind: scopeKind,
        scope: "nodes:read",
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        consumed_at: null,
        agent_id: null,
      },
      oauth_clients: {
        client_secret_hash: secretHash,
        scope: "nodes:read",
        redirect_uris: [REDIRECT],
        revoked_at: null,
      },
      workspaces: { slug: "docs", organization: { slug: "acme" } },
    };
    const builder = (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.is = () => b;
      // insert(...) is awaited directly in some paths and chained with
      // .select().maybeSingle() in others (access tokens need their id).
      b.insert = () => {
        const ins: Record<string, unknown> = {
          select: () => ins,
          maybeSingle: async () => ({ data: { id: `${table}-1` }, error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return ins;
      };
      b.update = () => b;
      b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve);
      return b;
    };
    return { from: (t: string) => builder(t) } as unknown as Parameters<
      typeof redeemCode
    >[0];
  }

  async function redeem(scopeKind: "workspace" | "user", resource?: McpResource) {
    const secretHash = await sha256Hex(SECRET);
    return redeemCode(makeAdmin(scopeKind, secretHash), {
      code: "the-code",
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      resource,
    });
  }

  it("omits expires_in for user-scoped tokens instead of sending 0", async () => {
    const token = await redeem("user");
    expect(token.scope_kind).toBe("user");
    expect(token.expires_in).toBeUndefined();
    expect(Object.keys(token)).not.toContain("expires_in");
    expect(token.access_token).toMatch(/^bctx_live_/);
  });

  it("still advertises the 30-day TTL for workspace-scoped tokens", async () => {
    const token = await redeem("workspace");
    expect(token.scope_kind).toBe("workspace");
    expect(token.expires_in).toBe(60 * 60 * 24 * 30);
  });

  // RFC 8707: the `resource` a client sends has to be the endpoint the grant
  // was made for. A workspace-scoped code belongs to `/mcp/<org>/<workspace>`
  // and nothing else; a user-scoped one reaches the root and any workspace.
  const DOCS: McpResource = { kind: "workspace", ref: { org: "acme", workspace: "docs" }, name: "acme/docs" };
  const OPS: McpResource = { kind: "workspace", ref: { org: "acme", workspace: "ops" }, name: "acme/ops" };

  it("mints a workspace-scoped token for the resource the grant is bound to", async () => {
    const token = await redeem("workspace", DOCS);
    expect(token.workspace_id).toBe("ws-1");
  });

  it("refuses a workspace-scoped code for another workspace or the root, as invalid_target", async () => {
    for (const resource of [OPS, { kind: "root" } as McpResource]) {
      await expect(redeem("workspace", resource)).rejects.toMatchObject({ code: "invalid_target" });
    }
  });

  it("lets a user-scoped code redeem for the root or any workspace endpoint", async () => {
    expect((await redeem("user", { kind: "root" })).scope_kind).toBe("user");
    expect((await redeem("user", DOCS)).scope_kind).toBe("user");
  });
});

/**
 * Refresh-token grant. The stub models oauth_refresh_tokens as a mutable
 * store so rotation, replay detection and family revocation are observable
 * rather than merely "did not throw".
 */
describe("oauth — refreshAccessToken", () => {
  const CLIENT_ID = "client-1";
  const SECRET = "s3cret";

  interface RefreshRow {
    id: string;
    token_hash: string;
    client_id: string;
    user_id: string;
    workspace_id: string;
    agent_id: string | null;
    scopes: string[];
    family_id: string;
    access_token_id: string | null;
    parent_id?: string | null;
    expires_at: string | null;
    consumed_at: string | null;
    revoked_at: string | null;
  }

  function makeStore() {
    return {
      refresh: [] as RefreshRow[],
      access: [] as Array<{ id: string; revoked_at: string | null }>,
      seq: 0,
    };
  }

  /** Chainable stub over the in-memory store above. */
  function makeAdmin(store: ReturnType<typeof makeStore>, secretHash: string) {
    const builder = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      let pending: Record<string, unknown> | null = null;
      const match = (row: Record<string, unknown>) =>
        filters.every(([k, v]) => row[k] === v);
      const rows = (): Record<string, unknown>[] => {
        if (table === "oauth_refresh_tokens") return store.refresh as never;
        if (table === "oauth_access_tokens") return store.access as never;
        if (table === "oauth_clients") {
          return [{
            client_id: CLIENT_ID,
            client_secret_hash: secretHash,
            scope: "nodes:read",
            redirect_uris: [],
            revoked_at: null,
          }];
        }
        if (table === "agents") return [{ status: "active", name: "a" }];
        if (table === "workspaces") return [{ id: "ws-1", slug: "docs", organization: { slug: "acme" } }];
        return [];
      };
      b.select = () => b;
      b.eq = (k: string, v: unknown) => {
        filters.push([k, v]);
        return b;
      };
      b.in = (k: string, vs: unknown[]) => {
        filters.push([k, vs as never]);
        return b;
      };
      b.is = () => b;
      b.insert = (payload: Record<string, unknown>) => {
        store.seq += 1;
        const id = `${table}-${store.seq}`;
        if (table === "oauth_refresh_tokens") {
          store.refresh.push({
            id,
            family_id: (payload.family_id as string) ?? `fam-${store.seq}`,
            consumed_at: null,
            revoked_at: null,
            ...payload,
          } as RefreshRow);
        } else if (table === "oauth_access_tokens") {
          store.access.push({ id, revoked_at: null });
        }
        const ins: Record<string, unknown> = {
          select: () => ins,
          maybeSingle: async () => ({ data: { id }, error: null }),
          then: (r: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(r),
        };
        return ins;
      };
      b.update = (patch: Record<string, unknown>) => {
        pending = patch;
        const upd: Record<string, unknown> = {
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return upd;
          },
          in: (k: string, vs: unknown[]) => {
            filters.push([`__in_${k}`, vs as never]);
            return upd;
          },
          is: () => upd,
          then: (r: (v: unknown) => unknown) => {
            for (const row of rows()) {
              const inFilters = filters.filter(([k]) => k.startsWith("__in_"));
              const plain = filters.filter(([k]) => !k.startsWith("__in_"));
              const okPlain = plain.every(([k, v]) => row[k] === v);
              const okIn = inFilters.every(([k, v]) =>
                (v as unknown[]).includes(row[k.replace("__in_", "")]),
              );
              if (okPlain && okIn) Object.assign(row, pending);
            }
            return Promise.resolve({ data: null, error: null }).then(r);
          },
        };
        return upd;
      };
      b.maybeSingle = async () => ({
        data: rows().find(match) ?? null,
        error: null,
      });
      b.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows().filter(match), error: null }).then(r);
      return b;
    };
    return { from: (t: string) => builder(t) } as unknown as Parameters<
      typeof refreshAccessToken
    >[0];
  }

  /** Seed one live refresh token and return its plaintext. */
  async function seed(store: ReturnType<typeof makeStore>, over: Partial<RefreshRow> = {}) {
    const plain = "bctx_refresh_seedtoken";
    store.refresh.push({
      id: "rt-0",
      token_hash: await sha256Hex("seedtoken"),
      client_id: CLIENT_ID,
      user_id: "u1",
      workspace_id: "ws-1",
      agent_id: null,
      scopes: ["nodes:read", "nodes:write"],
      family_id: "fam-1",
      access_token_id: "at-0",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      consumed_at: null,
      revoked_at: null,
      ...over,
    });
    store.access.push({ id: "at-0", revoked_at: null });
    return plain;
  }

  async function refresh(
    store: ReturnType<typeof makeStore>,
    token: string,
    scope?: string,
    resource?: McpResource,
  ) {
    const secretHash = await sha256Hex(SECRET);
    return refreshAccessToken(makeAdmin(store, secretHash), {
      refreshToken: token,
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      scope,
      resource,
    });
  }

  it("honours a resource that names the grant's workspace and refuses any other", async () => {
    const store = makeStore();
    const plain = await seed(store);
    const docs: McpResource = { kind: "workspace", ref: { org: "acme", workspace: "docs" }, name: "acme/docs" };
    const out = await refresh(store, plain, undefined, docs);
    expect(out.workspace_id).toBe("ws-1");

    const other = makeStore();
    const live = await seed(other);
    await expect(
      refresh(other, live, undefined, { kind: "workspace", ref: { org: "acme", workspace: "ops" }, name: "acme/ops" }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    // Refused before rotation: the token is still live.
    expect(other.refresh[0]!.consumed_at).toBeNull();
  });

  it("issues a new access token and rotates the refresh token", async () => {
    const store = makeStore();
    const plain = await seed(store);
    const out = await refresh(store, plain);

    expect(out.access_token).toMatch(/^bctx_live_/);
    expect(out.refresh_token).toMatch(/^bctx_refresh_/);
    expect(out.refresh_token).not.toBe(plain);
    expect(out.expires_in).toBe(60 * 60 * 24 * 30);
    expect(out.scope).toBe("nodes:read nodes:write");
    // The presented token is single-use from here on.
    expect(store.refresh[0]?.consumed_at).toBeTruthy();
    // The replacement stays in the same family, chained to its parent.
    const minted = store.refresh.at(-1);
    expect(minted?.family_id).toBe("fam-1");
    expect(minted?.parent_id).toBe("rt-0");
  });

  it("revokes the whole family when a consumed token is replayed", async () => {
    const store = makeStore();
    const plain = await seed(store);
    await refresh(store, plain);

    await expect(refresh(store, plain)).rejects.toThrow(/already used/);
    // Every refresh token in the family, and the access tokens minted from
    // it, are now dead — not just the replayed one.
    expect(store.refresh.every((r) => r.revoked_at)).toBe(true);
    expect(store.access.every((a) => a.revoked_at)).toBe(true);
  });

  it("rejects an expired refresh token without touching the family", async () => {
    const store = makeStore();
    const plain = await seed(store, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(refresh(store, plain)).rejects.toThrow(/expired/);
    expect(store.refresh[0]?.revoked_at).toBeNull();
  });

  it("rejects a revoked refresh token", async () => {
    const store = makeStore();
    const plain = await seed(store, { revoked_at: new Date().toISOString() });
    await expect(refresh(store, plain)).rejects.toThrow(/revoked/);
  });

  it("rejects a token that isn't a refresh token at all", async () => {
    const store = makeStore();
    await expect(refresh(store, "bctx_live_notarefresh")).rejects.toThrow(
      /not recognised/,
    );
  });

  it("lets scope narrow but never widen", async () => {
    const store = makeStore();
    const plain = await seed(store);
    const narrowed = await refresh(store, plain, "nodes:read");
    expect(narrowed.scope).toBe("nodes:read");

    const store2 = makeStore();
    const plain2 = await seed(store2, { scopes: ["nodes:read"] });
    await expect(refresh(store2, plain2, "nodes:read nodes:write")).rejects.toThrow(
      /exceeds the grant/,
    );
  });

  it("refuses when the client secret is wrong", async () => {
    const store = makeStore();
    const plain = await seed(store);
    const wrongHash = await sha256Hex("not-the-secret");
    await expect(
      refreshAccessToken(makeAdmin(store, wrongHash), {
        refreshToken: plain,
        clientId: CLIENT_ID,
        clientSecret: SECRET,
      }),
    ).rejects.toThrow(/client secret mismatch/);
    // A caller that cannot authenticate must not be able to burn the token.
    expect(store.refresh[0]?.consumed_at).toBeNull();
  });
});

/**
 * Revocation has to find the token where it actually lives.
 *
 * The consent flow issues USER-scoped access tokens and writes them to
 * user_api_tokens; revokeToken looked only in oauth_access_tokens. Because RFC
 * 7009 §2.2 mandates 200 for an unknown token, the miss was indistinguishable
 * from success — the OAuth end-to-end check on the local stack is what caught
 * it: "revoke" returned 200 and /mcp kept answering. So this stub keeps both
 * tables and asserts on the row, not on the status.
 */
describe("oauth — revokeToken", () => {
  const CLIENT_ID = "client-1";
  const OTHER_CLIENT = "client-2";
  const SECRET = "s3cret";

  interface Row { id: string; hash?: string; token_hash?: string; client_id: string | null; revoked_at: string | null }

  function makeStore() {
    return { access: [] as Row[], user: [] as Row[] };
  }

  function makeAdmin(store: ReturnType<typeof makeStore>, secretHash: string) {
    const builder = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const rows = (): Row[] =>
        table === "oauth_access_tokens" ? store.access
        : table === "user_api_tokens" ? store.user
        : table === "oauth_clients"
          ? [{ id: "c", client_id: CLIENT_ID, client_secret_hash: secretHash, scope: "", redirect_uris: [], revoked_at: null } as unknown as Row]
          : [];
      const match = (r: Row) => filters.every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (k: string, v: unknown) => { filters.push([k, v]); return b; };
      b.is = (k: string, v: unknown) => { filters.push([k, v]); return b; };
      b.maybeSingle = async () => ({ data: rows().find(match) ?? null, error: null });
      b.update = (patch: Record<string, unknown>) => {
        const upd: Record<string, unknown> = {
          eq: (k: string, v: unknown) => { filters.push([k, v]); return upd; },
          is: (k: string, v: unknown) => { filters.push([k, v]); return upd; },
          then: (r: (v: unknown) => unknown) => {
            for (const row of rows()) if (match(row)) Object.assign(row, patch);
            return Promise.resolve({ data: null, error: null }).then(r);
          },
        };
        return upd;
      };
      return b;
    };
    return { from: (t: string) => builder(t) } as unknown as Parameters<typeof revokeToken>[0];
  }

  async function revoke(store: ReturnType<typeof makeStore>, token: string, clientId = CLIENT_ID) {
    await revokeToken(makeAdmin(store, await sha256Hex(SECRET)), { token, clientId, clientSecret: SECRET });
  }

  it("revokes a user-scoped access token, the kind the consent flow issues", async () => {
    const store = makeStore();
    store.user.push({ id: "ut-1", hash: await sha256Hex("usertoken"), client_id: CLIENT_ID, revoked_at: null });
    await revoke(store, "bctx_live_usertoken");
    expect(store.user[0]?.revoked_at).not.toBeNull();
  });

  it("still revokes a workspace-scoped access token", async () => {
    const store = makeStore();
    store.access.push({ id: "at-1", token_hash: await sha256Hex("wstoken"), client_id: CLIENT_ID, revoked_at: null });
    await revoke(store, "bctx_live_wstoken");
    expect(store.access[0]?.revoked_at).not.toBeNull();
  });

  it("does not let another client revoke a user-scoped token", async () => {
    // The whole reason user_api_tokens grew a client_id: without it the
    // ownership rule the other tables enforce could not be applied here.
    const store = makeStore();
    store.user.push({ id: "ut-1", hash: await sha256Hex("usertoken"), client_id: OTHER_CLIENT, revoked_at: null });
    await revoke(store, "bctx_live_usertoken");
    expect(store.user[0]?.revoked_at).toBeNull();
  });

  it("leaves a Settings-created token (no client) alone", async () => {
    const store = makeStore();
    store.user.push({ id: "ut-1", hash: await sha256Hex("manual"), client_id: null, revoked_at: null });
    await revoke(store, "bctx_live_manual");
    expect(store.user[0]?.revoked_at).toBeNull();
  });
});

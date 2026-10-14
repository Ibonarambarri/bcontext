/**
 * OAuth 2.1 helpers — pure functions used by the
 * authorization / token / register endpoints. Side effects (DB I/O,
 * crypto-grade random) are intentionally factored out so tests can run
 * against the pure layer.
 *
 * The flow Bcontext implements:
 *   1. Dynamic client registration (RFC 7591) at
 *      POST /api/oauth/register.
 *   2. PKCE-required authorization code flow (RFC 7636). `S256` is the
 *      only challenge method accepted; `plain` is supported per the OAuth
 *      2.1 spec as a fallback for embedded clients but the route refuses
 *      it unless `?allow_plain=1` is sent (off by default).
 *   3. Access tokens reuse the existing `bctx_live_…` token shape and
 *      flow through the same `verifyToken` path. Workspace-scoped tokens
 *      carry a 30-day TTL and ship with a rotating `bctx_refresh_…` token
 *      so clients renew without another browser round-trip; user-scoped
 *      tokens never expire and get no refresh token.
 *   4. Resource indicators (RFC 8707). An MCP client names the endpoint it
 *      wants a token for as `resource`; a grant made through
 *      `/mcp/<org>/<workspace>` is workspace-scoped, and the token endpoint
 *      refuses (`invalid_target`) to mint for a resource the grant was not
 *      made for.
 */
import { customAlphabet } from "nanoid";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "./tokens";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import { parseScopes } from "@bcontext-dev/contract/auth/scopes";
import type { McpResource } from "@/lib/mcp/resource";
import { workspaceRefName } from "@bcontext-dev/contract/workspace-ref";

const CLIENT_ID_PREFIX = "bctx_client_";
const CLIENT_SECRET_PREFIX = "bctx_csk_";
const AUTH_CODE_PREFIX = "bctx_oacode_";
const TOKEN_PREFIX = "bctx_live_";
// Distinct prefix so a refresh token can never be mistaken for a bearer:
// verifyToken only ever resolves `bctx_live_`, so presenting a refresh
// token as an Authorization header fails closed.
const REFRESH_TOKEN_PREFIX = "bctx_refresh_";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const id = customAlphabet(ALPHABET, 24);
const long = customAlphabet(ALPHABET, 43);

export interface RegisterClientInput {
  client_name: string;
  redirect_uris: string[];
  scope?: string;
  client_uri?: string;
  logo_uri?: string;
  tos_uri?: string;
  policy_uri?: string;
  registered_by?: string | null;
}

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  scope: string;
}

export async function registerClient(
  admin: SupabaseClient,
  input: RegisterClientInput,
): Promise<RegisteredClient> {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris required");
  }
  for (const u of input.redirect_uris) {
    assertHttpsOrLoopback(u);
  }
  const clientId = `${CLIENT_ID_PREFIX}${id()}`;
  const secretPlain = `${CLIENT_SECRET_PREFIX}${long()}`;
  const secretHash = await sha256Hex(secretPlain);
  const requestedScope = input.scope?.trim()
    ? parseScopes(input.scope.split(/\s+/).filter(Boolean))
    : parseScopes(["nodes:read", "nodes:write", "chat:run"]);
  if (requestedScope.length === 0) {
    throw new Error("at least one valid scope is required");
  }
  const scope = requestedScope.join(" ");

  const { error } = await admin.from("oauth_clients").insert({
    client_id: clientId,
    client_secret_hash: secretHash,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    scope,
    client_uri: input.client_uri ?? null,
    logo_uri: input.logo_uri ?? null,
    tos_uri: input.tos_uri ?? null,
    policy_uri: input.policy_uri ?? null,
    registered_by: input.registered_by ?? null,
  });
  if (error) throw new Error(`registerClient: ${error.message}`);

  return {
    client_id: clientId,
    client_secret: secretPlain,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    scope,
  };
}

/**
 * Per OAuth 2.1: redirect_uri MUST be https *or* loopback
 * (127.0.0.1 / ::1 / localhost) for native clients.
 */
export function assertHttpsOrLoopback(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`invalid redirect_uri: ${uri}`);
  }
  if (url.protocol === "https:") return;
  // URL parser preserves brackets on IPv6 hostnames ("[::1]"); strip
  // them before comparing.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol === "http:" &&
    (host === "127.0.0.1" || host === "::1" || host === "localhost")
  ) {
    return;
  }
  throw new Error(
    `redirect_uri must be https or a loopback http URL: ${uri}`,
  );
}

/**
 * S256 PKCE check: SHA-256(code_verifier) base64url-encoded equals the
 * stored code_challenge. `plain` accepts the equality directly.
 */
export async function verifyPkce(opts: {
  method: "S256" | "plain";
  challenge: string;
  verifier: string;
}): Promise<boolean> {
  if (opts.method === "plain") {
    return timingSafeEqual(opts.challenge, opts.verifier);
  }
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(opts.verifier));
  const b64 = base64UrlEncode(new Uint8Array(buf));
  return timingSafeEqual(opts.challenge, b64);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Issue a one-shot authorization code. Hashed-at-rest. TTL 60s.
 *
 * `scopeKind` controls whether the redeemed token is workspace-scoped or
 * multi-workspace agent-scoped. For `"user"` the
 * `workspaceId` must be null; for `"workspace"` it must be a real id.
 */
export async function issueAuthorizationCode(
  admin: SupabaseClient,
  input: {
    clientId: string;
    userId: string;
    workspaceId: string | null;
    scopeKind?: "workspace" | "user";
    scope: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: "S256" | "plain";
    agentId?: string | null;
  },
): Promise<string> {
  const scopeKind = input.scopeKind ?? "workspace";
  if (scopeKind === "workspace" && !input.workspaceId) {
    throw new Error("workspace-scoped code requires workspaceId");
  }
  if (scopeKind === "user" && input.workspaceId) {
    throw new Error("user-scoped code must not carry a workspaceId");
  }
  const code = `${AUTH_CODE_PREFIX}${long()}`;
  const hash = await sha256Hex(code);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const { error } = await admin.from("oauth_authorization_codes").insert({
    code_hash: hash,
    client_id: input.clientId,
    user_id: input.userId,
    workspace_id: input.workspaceId,
    scope_kind: scopeKind,
    scope: input.scope,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    expires_at: expiresAt,
    agent_id: input.agentId ?? null,
  });
  if (error) throw new Error(`issueAuthorizationCode: ${error.message}`);
  return code;
}

export interface RedeemCodeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
  /**
   * The `resource` the client sent (RFC 8707), already read against this
   * server's own URLs. Absent when the client sent none; checked against
   * the code's binding before anything is minted.
   */
  resource?: McpResource;
}

export interface RedeemedToken {
  access_token: string;
  token_type: "Bearer";
  /**
   * Seconds until expiry. OMITTED for user-scoped tokens, which have no
   * fixed expiry (the user revokes them from Settings).
   *
   * It must be absent rather than 0: per RFC 6749 §5.1 `expires_in` is
   * optional, and clients compute `issuedAt + expires_in` — so 0 reads as
   * "already expired". Claude Code discarded freshly minted tokens on the
   * spot because of this ("got new credentials, but the server rejected
   * them on reconnect"), even though the token worked fine.
   */
  expires_in?: number;
  /**
   * Present only for workspace-scoped grants, whose access tokens expire.
   * User-scoped tokens never expire, so there is nothing to refresh and
   * handing out a refresh token would only invite pointless round-trips.
   */
  refresh_token?: string;
  scope: string;
  /** Null when workspace access is resolved from the durable agent policy. */
  workspace_id: string | null;
  scope_kind: "workspace" | "user";
}

const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 180; // 180 days

/**
 * Redeem an authorization_code for an access_token. Verifies:
 *   - code exists, not consumed, not expired
 *   - client_id matches the code's client
 *   - client_secret matches the stored hash
 *   - redirect_uri matches the code's redirect_uri (RFC 6749 §4.1.3)
 *   - PKCE verifier matches the stored challenge
 *
 * On success: marks code consumed, issues a `bctx_live_` access token,
 * stores its hash + metadata. Returns the standard OAuth /token body.
 */
export async function redeemCode(
  admin: SupabaseClient,
  input: RedeemCodeInput,
): Promise<RedeemedToken> {
  const codeHash = await sha256Hex(input.code);
  const { data: row, error } = await admin
    .from("oauth_authorization_codes")
    .select(
      "client_id, user_id, workspace_id, scope_kind, scope, redirect_uri, code_challenge, code_challenge_method, expires_at, consumed_at, agent_id",
    )
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (error || !row) throw new OAuthError("invalid_grant", "code not found");
  if (row.consumed_at) throw new OAuthError("invalid_grant", "code consumed");
  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    throw new OAuthError("invalid_grant", "code expired");
  }
  if (row.client_id !== input.clientId) {
    throw new OAuthError("invalid_grant", "client mismatch");
  }
  if (row.redirect_uri !== input.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri mismatch");
  }

  await assertClient(admin, input.clientId, input.clientSecret);

  // PKCE.
  const pkceOk = await verifyPkce({
    method: row.code_challenge_method as "S256" | "plain",
    challenge: row.code_challenge as string,
    verifier: input.codeVerifier,
  });
  if (!pkceOk) throw new OAuthError("invalid_grant", "pkce verifier mismatch");

  const scopeKind = (row.scope_kind as string | null) === "user"
    ? "user"
    : "workspace";
  await assertResourceBinding(admin, {
    resource: input.resource,
    scopeKind,
    workspaceId: (row.workspace_id as string | null) ?? null,
  });

  // Mint access token. The shape (`bctx_live_<43>`) is the same for both
  // scope kinds — only the backing table differs, and the unified
  // `verifyToken` knows how to resolve both.
  //
  // IMPORTANT: hash the suffix only, not the prefixed token. verifyToken
  // strips the `bctx_live_` prefix before hashing — matching the legacy
  // PAT convention — so we must store the suffix-only hash for OAuth
  // tokens too, otherwise lookups will silently miss.
  const tokenSuffix = long();
  const tokenPlain = `${TOKEN_PREFIX}${tokenSuffix}`;
  const tokenHash = await sha256Hex(tokenSuffix);
  const scope = row.scope as string;
  const scopes = parseScopesString(scope);
  const agentId = (row.agent_id as string | null) ?? null;
  let agentName = `OAuth · ${input.clientId}`;
  if (agentId) {
    const { data: agent } = await admin
      .from("agents")
      .select("name,status")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent || agent.status !== "active") {
      throw new OAuthError("invalid_grant", "agent connection is no longer active");
    }
    agentName = agent.name as string;
  }

  let refreshToken: string | undefined;
  if (scopeKind === "workspace") {
    const accessTokenId = await insertWorkspaceAccessToken(admin, {
      tokenHash,
      last4: tokenPlain.slice(-4),
      clientId: input.clientId,
      userId: row.user_id as string,
      workspaceId: row.workspace_id as string,
      agentId,
      scopes,
    });
    refreshToken = await issueRefreshToken(admin, {
      clientId: input.clientId,
      userId: row.user_id as string,
      workspaceId: row.workspace_id as string,
      agentId,
      scopes,
      accessTokenId,
      // First link in the chain: it seeds its own family.
      familyId: null,
      parentId: null,
    });
  } else {
    // User-scoped: write into user_api_tokens so verifyToken's user-scope
    // branch picks it up. No expiry — the user revokes from Settings.
    const { error: insertError } = await admin.from("user_api_tokens").insert({
      user_id: row.user_id as string,
      agent_id: agentId,
      name: agentName,
      prefix: tokenPlain.slice(0, 12),
      last4: tokenPlain.slice(-4),
      hash: tokenHash,
      scopes,
      // So revokeToken can find it. Without this the token was unrevocable
      // through the OAuth surface, and the 200 the spec mandates hid that.
      client_id: input.clientId,
    });
    if (insertError) throw new OAuthError("server_error", insertError.message);
  }

  if (agentId) {
    await admin
      .from("agents")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", agentId);
  }

  await admin
    .from("oauth_authorization_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code_hash", codeHash);

  return {
    access_token: tokenPlain,
    token_type: "Bearer",
    ...(scopeKind === "workspace" ? { expires_in: ACCESS_TOKEN_TTL_SEC } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    scope,
    workspace_id: scopeKind === "workspace" ? (row.workspace_id as string) : null,
    scope_kind: scopeKind,
  };
}

function parseScopesString(s: string): Scope[] {
  return parseScopes(s.split(/\s+/).filter(Boolean));
}

/**
 * The `resource` a client sends has to be the endpoint its grant was made
 * for (RFC 8707 §2.2). A workspace-scoped grant belongs to exactly one
 * `/mcp/<org>/<workspace>`; a user-scoped grant reaches the root endpoint
 * and, per request, any workspace the person is a member of, so either
 * spelling is fine there. No `resource` at all is fine for both: clients
 * that predate resource indicators keep working. Shared by both grants so
 * they fail identically, with `invalid_target`.
 */
async function assertResourceBinding(
  admin: SupabaseClient,
  input: {
    resource: McpResource | undefined;
    scopeKind: "workspace" | "user";
    workspaceId: string | null;
  },
): Promise<void> {
  const { resource } = input;
  if (!resource || input.scopeKind === "user") return;
  if (resource.kind !== "workspace" || !input.workspaceId) {
    throw new OAuthError("invalid_target", "this grant is bound to one workspace's MCP endpoint");
  }
  const { data } = await admin
    .from("workspaces")
    .select("slug, organization:organizations!inner(slug)")
    .eq("id", input.workspaceId)
    .maybeSingle();
  const org = (data?.organization as { slug?: string } | null | undefined)?.slug;
  const bound = data && org ? workspaceRefName(org, data.slug as string) : null;
  if (bound !== resource.name) {
    throw new OAuthError("invalid_target", "resource does not match the workspace this grant was made for");
  }
}

/**
 * Confirm the client exists, is not revoked, and presented the right
 * secret. Shared by every grant so they fail identically.
 */
async function assertClient(
  admin: SupabaseClient,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const { data: client, error } = await admin
    .from("oauth_clients")
    .select("client_secret_hash, scope, redirect_uris, revoked_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !client) {
    throw new OAuthError("invalid_client", "client not found");
  }
  if (client.revoked_at) {
    throw new OAuthError("invalid_client", "client revoked");
  }
  const givenHash = await sha256Hex(clientSecret);
  if (!timingSafeEqual(givenHash, client.client_secret_hash as string)) {
    throw new OAuthError("invalid_client", "client secret mismatch");
  }
}

/**
 * Insert a workspace-scoped access token row and return its id, so the
 * refresh token minted alongside can point back at it (family revocation
 * kills the access tokens too, not just the refresh chain).
 */
async function insertWorkspaceAccessToken(
  admin: SupabaseClient,
  input: {
    tokenHash: string;
    last4: string;
    clientId: string;
    userId: string;
    workspaceId: string;
    agentId: string | null;
    scopes: Scope[];
  },
): Promise<string | null> {
  const expiresAt = new Date(
    Date.now() + ACCESS_TOKEN_TTL_SEC * 1000,
  ).toISOString();
  const { data, error } = await admin
    .from("oauth_access_tokens")
    .insert({
      token_hash: input.tokenHash,
      client_id: input.clientId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      scopes: input.scopes,
      prefix: TOKEN_PREFIX,
      last4: input.last4,
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();
  if (error) throw new OAuthError("server_error", error.message);
  return (data?.id as string | undefined) ?? null;
}

/** Mint one link of a refresh-token chain. Returns the plaintext token. */
async function issueRefreshToken(
  admin: SupabaseClient,
  input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    agentId: string | null;
    scopes: Scope[];
    accessTokenId: string | null;
    /** Null seeds a new family (first exchange of an authorization_code). */
    familyId: string | null;
    parentId: string | null;
  },
): Promise<string> {
  const suffix = long();
  const plain = `${REFRESH_TOKEN_PREFIX}${suffix}`;
  // Hash the suffix only, mirroring the access-token convention.
  const hash = await sha256Hex(suffix);
  const { error } = await admin
    .from("oauth_refresh_tokens")
    .insert({
      token_hash: hash,
      client_id: input.clientId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      scopes: input.scopes,
      parent_id: input.parentId,
      access_token_id: input.accessTokenId,
      expires_at: new Date(
        Date.now() + REFRESH_TOKEN_TTL_SEC * 1000,
      ).toISOString(),
      // Omitted on the first link: the column default seeds a fresh family.
      ...(input.familyId ? { family_id: input.familyId } : {}),
    });
  if (error) throw new OAuthError("server_error", error.message);
  return plain;
}

/**
 * Revoke an entire rotation family — every refresh token in the chain and
 * every access token minted from it.
 *
 * Called on replay: presenting an already-consumed refresh token means
 * either the client is buggy or the token leaked, and OAuth 2.1 §4.13.2
 * says to assume the worst and invalidate the lot.
 */
async function revokeRefreshFamily(
  admin: SupabaseClient,
  familyId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data: rows } = await admin
    .from("oauth_refresh_tokens")
    .select("access_token_id")
    .eq("family_id", familyId);
  const accessIds = ((rows ?? []) as Array<{ access_token_id: string | null }>)
    .map((r) => r.access_token_id)
    .filter((id): id is string => Boolean(id));
  if (accessIds.length > 0) {
    await admin
      .from("oauth_access_tokens")
      .update({ revoked_at: now })
      .in("id", accessIds)
      .is("revoked_at", null);
  }
  await admin
    .from("oauth_refresh_tokens")
    .update({ revoked_at: now })
    .eq("family_id", familyId)
    .is("revoked_at", null);
}

export interface RevokeTokenInput {
  token: string;
  clientId: string;
  clientSecret: string;
}

/**
 * RFC 7009 revocation. Resolves the token by prefix — `bctx_refresh_` hits
 * the rotation chain (and takes the whole family with it), `bctx_live_`
 * hits the access token. Unknown or already-revoked tokens are a no-op, so
 * the caller cannot use this endpoint to enumerate valid tokens.
 *
 * Only the client that owns the token may revoke it; a bad secret raises
 * `invalid_client` before anything is touched.
 */
export async function revokeToken(
  admin: SupabaseClient,
  input: RevokeTokenInput,
): Promise<void> {
  await assertClient(admin, input.clientId, input.clientSecret);

  if (input.token.startsWith(REFRESH_TOKEN_PREFIX)) {
    const hash = await sha256Hex(
      input.token.slice(REFRESH_TOKEN_PREFIX.length),
    );
    const { data: row } = await admin
      .from("oauth_refresh_tokens")
      .select("family_id, client_id")
      .eq("token_hash", hash)
      .maybeSingle();
    if (!row || row.client_id !== input.clientId) return;
    await revokeRefreshFamily(admin, row.family_id as string);
    return;
  }

  if (input.token.startsWith(TOKEN_PREFIX)) {
    const hash = await sha256Hex(input.token.slice(TOKEN_PREFIX.length));
    const now = new Date().toISOString();

    // Workspace-scoped access tokens.
    const { data: row } = await admin
      .from("oauth_access_tokens")
      .select("id, client_id")
      .eq("token_hash", hash)
      .maybeSingle();
    if (row) {
      if (row.client_id !== input.clientId) return;
      await admin
        .from("oauth_access_tokens")
        .update({ revoked_at: now })
        .eq("id", row.id as string)
        .is("revoked_at", null);
      return;
    }

    // User-scoped access tokens — the ones the consent flow actually issues.
    // They live in user_api_tokens; this branch did not exist, so revoking one
    // was a 200 that changed nothing. Same ownership rule: only the client
    // the token was issued to may revoke it, which is why the column exists.
    const { data: userRow } = await admin
      .from("user_api_tokens")
      .select("id, client_id")
      .eq("hash", hash)
      .maybeSingle();
    if (!userRow || userRow.client_id !== input.clientId) return;
    await admin
      .from("user_api_tokens")
      .update({ revoked_at: now })
      .eq("id", userRow.id as string)
      .is("revoked_at", null);
  }
}

export interface RefreshTokenInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Optional narrowing per RFC 6749 §6. Must be a subset of the grant. */
  scope?: string;
  /** The `resource` the client sent (RFC 8707); see `RedeemCodeInput`. */
  resource?: McpResource;
}

/**
 * Exchange a refresh token for a fresh access token, rotating the refresh
 * token in the process (OAuth 2.1 §4.13.2 — public and confidential clients
 * alike get single-use refresh tokens).
 *
 * Rejects, as `invalid_grant`: unknown, revoked, expired, replayed, or
 * client-mismatched tokens. A replay additionally revokes the family.
 */
export async function refreshAccessToken(
  admin: SupabaseClient,
  input: RefreshTokenInput,
): Promise<RedeemedToken> {
  if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
    throw new OAuthError("invalid_grant", "refresh token not recognised");
  }
  const suffix = input.refreshToken.slice(REFRESH_TOKEN_PREFIX.length);
  const hash = await sha256Hex(suffix);

  const { data: row, error } = await admin
    .from("oauth_refresh_tokens")
    .select(
      "id, client_id, user_id, workspace_id, agent_id, scopes, family_id, expires_at, consumed_at, revoked_at",
    )
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !row) {
    throw new OAuthError("invalid_grant", "refresh token not found");
  }

  // Verify the client BEFORE acting on the token, so a wrong caller can
  // neither refresh nor trip the family revocation on someone else's chain.
  await assertClient(admin, input.clientId, input.clientSecret);
  if (row.client_id !== input.clientId) {
    throw new OAuthError("invalid_grant", "client mismatch");
  }

  if (row.consumed_at) {
    await revokeRefreshFamily(admin, row.family_id as string);
    throw new OAuthError(
      "invalid_grant",
      "refresh token already used — the whole grant has been revoked, reauthorise",
    );
  }
  if (row.revoked_at) {
    throw new OAuthError("invalid_grant", "refresh token revoked");
  }
  if (
    row.expires_at &&
    new Date(row.expires_at as string).getTime() < Date.now()
  ) {
    throw new OAuthError("invalid_grant", "refresh token expired");
  }

  const agentId = (row.agent_id as string | null) ?? null;
  if (agentId) {
    const { data: agent } = await admin
      .from("agents")
      .select("status")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent || agent.status !== "active") {
      throw new OAuthError("invalid_grant", "agent connection is no longer active");
    }
  }

  // A refresh token only ever belongs to a workspace-scoped grant.
  await assertResourceBinding(admin, {
    resource: input.resource,
    scopeKind: "workspace",
    workspaceId: row.workspace_id as string,
  });

  // Scope may narrow but never widen (RFC 6749 §6).
  const granted = (row.scopes ?? []) as Scope[];
  let scopes = granted;
  if (input.scope?.trim()) {
    const requested = parseScopesString(input.scope);
    if (requested.some((s) => !granted.includes(s))) {
      throw new OAuthError("invalid_scope", "requested scope exceeds the grant");
    }
    scopes = requested;
  }

  const tokenSuffix = long();
  const tokenPlain = `${TOKEN_PREFIX}${tokenSuffix}`;
  const accessTokenId = await insertWorkspaceAccessToken(admin, {
    tokenHash: await sha256Hex(tokenSuffix),
    last4: tokenPlain.slice(-4),
    clientId: input.clientId,
    userId: row.user_id as string,
    workspaceId: row.workspace_id as string,
    agentId,
    scopes,
  });
  const nextRefresh = await issueRefreshToken(admin, {
    clientId: input.clientId,
    userId: row.user_id as string,
    workspaceId: row.workspace_id as string,
    agentId,
    scopes,
    accessTokenId,
    familyId: row.family_id as string,
    parentId: row.id as string,
  });

  await admin
    .from("oauth_refresh_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id as string);

  if (agentId) {
    await admin
      .from("agents")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", agentId);
  }

  return {
    access_token: tokenPlain,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: nextRefresh,
    scope: scopes.join(" "),
    workspace_id: row.workspace_id as string,
    scope_kind: "workspace",
  };
}

export class OAuthError extends Error {
  code: string;
  constructor(code: string, description?: string) {
    super(description ?? code);
    this.code = code;
  }
  toBody(): { error: string; error_description?: string } {
    return this.message
      ? { error: this.code, error_description: this.message }
      : { error: this.code };
  }
}

/**
 * Discovery metadata per RFC 8414. Routes call this; tests can compare
 * to expected.
 */
export function authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    registration_endpoint: `${baseUrl}/api/oauth/register`,
    revocation_endpoint: `${baseUrl}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: ["nodes:read", "nodes:write", "chat:run", "agents:read", "agents:write"],
    // RFC 9728 — discoverable list of protected resources tied to this
    // authorization server. MCP clients look here to confirm the /mcp
    // endpoint is the resource they need a token for.
    resource_documentation: `${baseUrl}/.well-known/oauth-protected-resource`,
  };
}

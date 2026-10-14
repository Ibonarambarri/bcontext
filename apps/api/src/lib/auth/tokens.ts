/**
 * Workspace-scoped bearer tokens for the agent API + MCP server.
 *
 * Format: `bctx_live_<43-char base64url suffix>` (~256 bits of entropy).
 * The plaintext suffix is shown to the user exactly once on creation and
 * stored hashed (sha256-hex). All lookups go through the hash.
 *
 * Trust model: the token IS the proof of authorization. Verification is
 * performed via the service-role client (bypasses RLS) because the caller
 * has no user session at that point — the token's existence and the
 * workspace_id it carries are the entire grant.
 *
 * Creation, listing, and revocation go through the user-context client so
 * that RLS enforces the `is_workspace_admin` check from the migration.
 */
import { customAlphabet } from "nanoid";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type Scope, parseScopes } from "@bcontext-dev/contract/auth/scopes";
import { roleForScopes, type AgentProvider } from "@bcontext-dev/contract/agents/connections";
import { createAgentConnection, revokeAgentEverywhere } from "@/lib/agents/connections.server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const TOKEN_PREFIX = "bctx_live_";
const SUFFIX_LENGTH = 43;
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const generateSuffix = customAlphabet(ALPHABET, SUFFIX_LENGTH);

export interface ApiTokenRecord {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface UserApiTokenRecord {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface NewTokenInput {
  workspaceId: string;
  name: string;
  scopes: Scope[];
  createdBy: string | null;
  /**
   * The agent identity this token acts as. Omit it and one is minted here —
   * see `createToken`. `null` says the caller means a token with no identity
   * at all, which only the paths that mint credentials for nobody may want.
   */
  agentId?: string | null;
  /** Which client the token is for, when the minting path knows. */
  provider?: AgentProvider;
  /** Free-text name of the client when `provider` is `other`. */
  providerLabel?: string | null;
}

export interface NewUserTokenInput {
  userId: string;
  name: string;
  scopes: Scope[];
  agentId?: string | null;
}

export interface CreateTokenResult {
  /** Plaintext token. Show once, never again. */
  token: string;
  record: ApiTokenRecord;
}

export interface CreateUserTokenResult {
  /** Plaintext token. Show once, never again. */
  token: string;
  record: UserApiTokenRecord;
}

/**
 * Result of verifying a bearer token. Discriminated by `scope` so callers
 * can branch on workspace-scoped vs user-scoped tokens.
 *
 *   - `scope: "workspace"` — token is bound to one workspace (the legacy
 *     `api_tokens` table or an OAuth-issued access token). The route
 *     should use `workspaceId` directly.
 *   - `scope: "user"` — token can address multiple explicitly approved
 *     workspaces. Legacy tokens without an agent id still use memberships.
 */
export type VerifyTokenResult =
  | {
      scope: "workspace";
      workspaceId: string;
      scopes: Scope[];
      tokenId: string;
      /** User who minted the token; the AI-usage subject for this agent. */
      createdBy: string | null;
      agentId: string | null;
    }
  | {
      scope: "user";
      userId: string;
      scopes: Scope[];
      tokenId: string;
      agentId: string | null;
    };

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function parseAuthHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(bctx_live_[A-Za-z0-9]+)$/.exec(header.trim());
  return m ? m[1]! : null;
}

/**
 * Create a new token. The supplied client must be authenticated as a user
 * with owner/admin role in the workspace — RLS will reject otherwise.
 *
 * The returned `token` is the only time the plaintext is available.
 *
 * ## Every credential is somebody
 *
 * A token is a connection like any other, so it gets the same identity the
 * OAuth consent screen writes: an `agents` row, an `agent_workspace_access`
 * row, a capability principal and the grant that mirrors them. Without it a
 * workspace whose Claude Code has been calling the API all week shows an empty
 * Agents tab and an `agent_count` of zero, because both are counted from
 * agents and not from tokens.
 *
 * Pass `agentId` when the identity already exists (the OAuth path mints it
 * before the token) and one is created here otherwise. There is nothing to
 * attach an agent to when nobody minted it, so a token with no `createdBy`
 * keeps the identity-less shape — as do the tokens issued before any of this,
 * which `resolveGrant` still honours on their own scopes.
 */
export async function createToken(
  client: SupabaseClient,
  input: NewTokenInput,
): Promise<CreateTokenResult> {
  const suffix = generateSuffix();
  const token = `${TOKEN_PREFIX}${suffix}`;
  const hash = await sha256Hex(suffix);
  const prefix = token.slice(0, 12);
  const last4 = token.slice(-4);

  // The identity and the grant it carries are written with the service-role
  // client: `client` may be the caller's own session, which RLS keeps out of
  // the agent tables on purpose.
  const owner = input.agentId === undefined ? input.createdBy : null;
  const admin = owner ? getSupabaseAdmin() : null;
  const agentId =
    admin && owner
      ? await createAgentConnection(admin, {
          ownerUserId: owner,
          name: input.name,
          provider: input.provider ?? "other",
          providerLabel: input.providerLabel ?? "Manual token",
          workspaceIds: [input.workspaceId],
          role: roleForScopes(input.scopes),
          scopes: input.scopes,
        })
      : input.agentId ?? null;

  const { data, error } = await client
    .from("api_tokens")
    .insert({
      workspace_id: input.workspaceId,
      name: input.name,
      prefix,
      last4,
      hash,
      scopes: input.scopes,
      created_by: input.createdBy,
      agent_id: agentId,
    })
    .select("id, workspace_id, name, prefix, last4, scopes, created_at, last_used_at, revoked_at")
    .single();

  if (error || !data) {
    // An identity minted here and left behind by a failed insert is an agent
    // nobody can reach and nobody asked for, listed in the customer's Agents
    // tab as if something were connected.
    if (admin && agentId) {
      await revokeAgentEverywhere(admin, agentId);
    }
    throw new Error(`Failed to create token: ${error?.message ?? "unknown"}`);
  }

  return { token, record: toRecord(data) };
}

/**
 * Resolve a bearer token (with `Bearer ` prefix) to its scope + grant.
 * Returns null when the token is missing, malformed, unknown, or revoked.
 *
 * Lookup order:
 *   1. `api_tokens` — workspace-scoped tokens.
 *   2. `oauth_access_tokens` — OAuth-issued access tokens (also workspace-scoped).
 *   3. `user_api_tokens` — multi-workspace tokens. Agent-aware rows resolve
 *      explicit access; legacy rows retain membership-based behavior.
 *
 * The provided `admin` client should be the service-role client — token
 * lookup intentionally bypasses RLS.
 */
export async function verifyToken(
  admin: SupabaseClient,
  authHeader: string | null | undefined,
): Promise<VerifyTokenResult | null> {
  const suffix = parseAuthHeader(authHeader);
  if (!suffix) return null;
  // The plaintext format is `bctx_live_<suffix>`; we hash the suffix only.
  const justSuffix = suffix.startsWith(TOKEN_PREFIX)
    ? suffix.slice(TOKEN_PREFIX.length)
    : suffix;
  const hash = await sha256Hex(justSuffix);

  const { data, error } = await admin
    .from("api_tokens")
    .select("id, workspace_id, scopes, revoked_at, created_by, agent_id")
    .eq("hash", hash)
    .maybeSingle();
  if (!error && data && !data.revoked_at) {
    // Fire-and-forget last_used_at bump. Failure here is non-fatal.
    fireAndForget(
      admin
        .from("api_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", data.id),
    );
    touchAgent(admin, data.agent_id as string | null);
    return {
      scope: "workspace",
      workspaceId: data.workspace_id as string,
      scopes: parseScopes(data.scopes),
      tokenId: data.id as string,
      createdBy: (data.created_by as string | null) ?? null,
      agentId: (data.agent_id as string | null) ?? null,
    };
  }

  // Fallback 1: OAuth-issued access tokens share the `bctx_live_…` shape.
  // The unified verifier lets MCP/REST routes accept either type without
  // changes upstream.
  const { data: oauthRow } = await admin
    .from("oauth_access_tokens")
    .select("id, workspace_id, scopes, revoked_at, expires_at, user_id, agent_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (oauthRow && !oauthRow.revoked_at) {
    const expired =
      oauthRow.expires_at &&
      new Date(oauthRow.expires_at as string).getTime() < Date.now();
    if (!expired) {
      fireAndForget(
        admin
          .from("oauth_access_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", oauthRow.id),
      );
      touchAgent(admin, oauthRow.agent_id as string | null);
      return {
        scope: "workspace",
        workspaceId: oauthRow.workspace_id as string,
        scopes: parseScopes(oauthRow.scopes),
        tokenId: oauthRow.id as string,
        createdBy: (oauthRow.user_id as string | null) ?? null,
        agentId: (oauthRow.agent_id as string | null) ?? null,
      };
    }
  }

  // Fallback 2: multi-workspace tokens. The route picks one per request via
  // X-Bcontext-Workspace header / ?workspace=<slug>, then checks explicit
  // agent access (or legacy user membership when no agent id exists).
  const { data: userRow } = await admin
    .from("user_api_tokens")
    .select("id, user_id, scopes, revoked_at, agent_id")
    .eq("hash", hash)
    .maybeSingle();
  if (userRow && !userRow.revoked_at) {
    fireAndForget(
      admin
        .from("user_api_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", userRow.id),
    );
    touchAgent(admin, userRow.agent_id as string | null);
    return {
      scope: "user",
      userId: userRow.user_id as string,
      scopes: parseScopes(userRow.scopes),
      tokenId: userRow.id as string,
      agentId: (userRow.agent_id as string | null) ?? null,
    };
  }

  return null;
}

/**
 * Run a supabase-js builder without awaiting it. The builder is lazy: it only
 * sends the request when something calls `.then`, so a bare `void builder`
 * never executes — that is why every `last_used_at` / `last_seen_at` stamp
 * stayed null in production. Errors are swallowed on purpose (non-fatal).
 */
function fireAndForget(builder: PromiseLike<unknown> | { then?: unknown }): void {
  if (typeof (builder as { then?: unknown }).then !== "function") return;
  void (builder as PromiseLike<unknown>).then(
    () => undefined,
    () => undefined,
  );
}

function touchAgent(admin: SupabaseClient, agentId: string | null): void {
  if (!agentId) return;
  fireAndForget(
    admin
      .from("agents")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", agentId)
      .eq("status", "active"),
  );
}

/**
 * List non-revoked tokens for the workspace. The user-context client must
 * be admin in the workspace; RLS enforces this.
 */
export async function listTokens(
  client: SupabaseClient,
  workspaceId: string,
): Promise<ApiTokenRecord[]> {
  const { data, error } = await client
    .from("api_tokens")
    .select("id, workspace_id, name, prefix, last4, scopes, created_at, last_used_at, revoked_at")
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list tokens: ${error.message}`);
  return (data ?? []).map(toRecord);
}

/**
 * Soft-revoke a token. Subsequent `verifyToken` lookups for the same
 * plaintext return null. The row is retained for audit.
 */
export async function revokeToken(
  client: SupabaseClient,
  tokenId: string,
): Promise<void> {
  const { error } = await client
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId);
  if (error) throw new Error(`Failed to revoke token: ${error.message}`);
}

function toRecord(row: Record<string, unknown>): ApiTokenRecord {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    last4: row.last4 as string,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at as string,
    last_used_at: (row.last_used_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
  };
}

// ---- User-scoped tokens --------------------------------------------------

/**
 * Create a user-scoped bearer token. The supplied client must be
 * authenticated as the same user that owns the token — RLS on
 * `user_api_tokens` only allows `user_id = auth.uid()`.
 *
 * The returned `token` is the only time the plaintext is available.
 */
export async function createUserToken(
  client: SupabaseClient,
  input: NewUserTokenInput,
): Promise<CreateUserTokenResult> {
  const suffix = generateSuffix();
  const token = `${TOKEN_PREFIX}${suffix}`;
  const hash = await sha256Hex(suffix);
  const prefix = token.slice(0, 12);
  const last4 = token.slice(-4);

  const { data, error } = await client
    .from("user_api_tokens")
    .insert({
      user_id: input.userId,
      name: input.name,
      prefix,
      last4,
      hash,
      scopes: input.scopes,
      agent_id: input.agentId ?? null,
    })
    .select("id, user_id, name, prefix, last4, scopes, created_at, last_used_at, revoked_at")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create user token: ${error?.message ?? "unknown"}`);
  }

  return { token, record: toUserRecord(data) };
}

/**
 * List the caller's non-revoked user-scoped tokens. RLS restricts results
 * to the authenticated user automatically.
 */
export async function listUserTokens(
  client: SupabaseClient,
  userId: string,
): Promise<UserApiTokenRecord[]> {
  const { data, error } = await client
    .from("user_api_tokens")
    .select("id, user_id, name, prefix, last4, scopes, created_at, last_used_at, revoked_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list user tokens: ${error.message}`);
  return (data ?? []).map(toUserRecord);
}

/**
 * Soft-revoke a user-scoped token. The `userId` is matched in the update
 * to short-circuit any attempt to revoke a token that isn't yours; RLS
 * also enforces this server-side.
 */
export async function revokeUserToken(
  client: SupabaseClient,
  tokenId: string,
  userId: string,
): Promise<void> {
  const { error } = await client
    .from("user_api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to revoke user token: ${error.message}`);
}

function toUserRecord(row: Record<string, unknown>): UserApiTokenRecord {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    last4: row.last4 as string,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at as string,
    last_used_at: (row.last_used_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
  };
}

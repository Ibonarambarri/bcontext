/**
 * Authentication gate for every API route.
 *
 * Resolution order:
 *   1. `Authorization: Bearer bctx_live_...`  → bearer-token (agent) auth.
 *      The token's workspace_id and scopes are returned.
 *   2. Supabase session cookie → user auth. The user id is returned;
 *      callers must enforce workspace membership themselves.
 *   3. Dev escape hatch: when `NODE_ENV !== "production"` and no auth is
 *      present, the request is treated as anonymous "demo" access. This
 *      keeps the local UI usable against the in-memory demo workspace.
 *
 * Throw `AuthError` to short-circuit a route with a JSON 401/403 response.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  parseWorkspaceRef,
  workspaceRefName,
} from "@bcontext-dev/contract/workspace-ref";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { verifyToken } from "./tokens";
import { type Scope, hasScope } from "@bcontext-dev/contract/auth/scopes";
import { assertSameOrigin } from "./origin-guard";
import { rateLimit, scopeClass } from "@/lib/rate-limit";
import { log } from "@bcontext-dev/contract/log";

export type Actor =
  | {
      kind: "agent";
      workspaceId: string;
      scopes: Scope[];
      tokenId: string;
      /** User who minted the token; AI-usage subject for this agent (null = unattributed). */
      createdBy: string | null;
      agentId?: string | null;
    }
  | {
      kind: "agent_user";
      userId: string;
      scopes: Scope[];
      tokenId: string;
      agentId?: string | null;
    }
  | { kind: "user"; userId: string }
  | { kind: "demo" };

/**
 * The user whose account budget an action is metered against. For agent
 * (workspace) tokens this is the token's creator; for user/OAuth tokens it's
 * the user. Returns null for demo / unattributed tokens (callers fail open).
 */
export function actingUserId(actor: Actor): string | null {
  switch (actor.kind) {
    case "user":
      return actor.userId;
    case "agent_user":
      return actor.userId;
    case "agent":
      return actor.createdBy;
    default:
      return null;
  }
}

class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: 401 | 403, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
  toResponse(): Response {
    return Response.json(
      { error: this.code, message: this.message },
      {
        status: this.status,
        headers:
          this.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="bcontext"' }
            : undefined,
      },
    );
  }
}

const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Resolve the actor behind the request. Throws AuthError(401) when no
 * credentials are present and the dev escape hatch does not apply.
 */
export async function requireAuth(req: Request): Promise<Actor> {
  const authHeader = req.headers.get("authorization");

  // 1. Bearer token
  if (authHeader) {
    const admin = getSupabaseAdmin();
    const result = await verifyToken(admin, authHeader);
    if (!result) throw new AuthError(401, "invalid_token");
    if (result.scope === "workspace") {
      return {
        kind: "agent",
        workspaceId: result.workspaceId,
        scopes: result.scopes,
        tokenId: result.tokenId,
        createdBy: result.createdBy,
        agentId: result.agentId,
      };
    }
    return {
      kind: "agent_user",
      userId: result.userId,
      scopes: result.scopes,
      tokenId: result.tokenId,
      agentId: result.agentId,
    };
  }

  // 2. User session
  try {
    const supabase = getSupabaseForRequest(req);
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      return { kind: "user", userId: data.user.id };
    }
  } catch {
    // Supabase not configured in this environment → fall through to demo path.
  }

  // 3. Dev escape hatch
  if (!isProduction()) {
    return { kind: "demo" };
  }

  throw new AuthError(401, "unauthorized", "authentication required");
}

/**
 * Enforce a required scope on the actor. Users and demo callers are
 * implicitly authorized — the scope system applies only to agent tokens.
 * Throws AuthError(403) for an agent that lacks the scope.
 */
export function requireScope(actor: Actor, scope: Scope): void {
  // Bearer-token actors (agent + agent_user) carry scopes. Cookie-auth
  // users and demo callers are implicitly authorized.
  if (actor.kind !== "agent" && actor.kind !== "agent_user") return;
  if (!hasScope(actor.scopes, scope)) {
    throw new AuthError(403, "forbidden", `missing scope: ${scope}`);
  }
}

/**
 * Convenience for routes: resolve the actor and (optionally) enforce a
 * scope. Returns the actor on success, or a Response with the auth
 * error pre-built that the route can return directly.
 *
 *   const gated = await gate(req, "agents:read");
 *   if (gated instanceof Response) return gated;
 *   const actor = gated;
 *
 * `allowAnonymous` lets a route accept unauthenticated callers (treated
 * as `{ kind: "demo" }`) without losing origin-guard or rate-limiting.
 * Used by public OAuth endpoints (RFC 7591 dynamic client registration)
 * and the MCP entry point — where the no-auth case must reach the route
 * so it can return a spec-compliant discovery response. Invalid tokens
 * still hard-fail; only missing credentials are downgraded.
 */
export async function gate(
  req: Request,
  scope?: Scope,
  opts?: { allowAnonymous?: boolean },
): Promise<Actor | Response> {
  // Same-origin guard runs before auth: it's a cheap O(1) header check and
  // protects against cookie-bearing cross-site requests reaching auth code.
  const originErr = assertSameOrigin(req);
  if (originErr) return originErr;
  try {
    let actor: Actor;
    try {
      actor = await requireAuth(req);
    } catch (err) {
      if (
        opts?.allowAnonymous &&
        err instanceof AuthError &&
        err.code === "unauthorized"
      ) {
        actor = { kind: "demo" };
      } else {
        throw err;
      }
    }
    if (scope) requireScope(actor, scope);

    // Rate limiting. Key by (workspace | actor) so distinct tenants don't
    // share budgets. The dev demo path is rate-limited by IP so concurrent
    // sessions don't collide.
    const key = rateLimitKey(actor, req);
    const klass = scopeClass(scope);
    const rl = rateLimit(key, klass);
    if (!rl.ok) {
      log.warn("rate_limit.denied", {
        workspace_id:
          actor.kind === "agent" ? actor.workspaceId : undefined,
        actor_type: actor.kind,
        route: new URL(req.url).pathname,
        scope: scope ?? null,
        retry_after_sec: rl.retryAfterSec,
      });
      return Response.json(
        { error: "rate_limited", retry_after_sec: rl.retryAfterSec },
        {
          status: 429,
          headers: {
            "Retry-After": String(rl.retryAfterSec),
            "X-RateLimit-Limit": String(rl.capacity),
            "X-RateLimit-Remaining": String(rl.remaining),
          },
        },
      );
    }
    return actor;
  } catch (err) {
    if (err instanceof AuthError) {
      log.warn("auth.failed", {
        route: new URL(req.url).pathname,
        scope: scope ?? null,
        status: err.status,
        code: err.code,
      });
      return err.toResponse();
    }
    throw err;
  }
}

function rateLimitKey(actor: Actor, req: Request): string {
  if (actor.kind === "agent") {
    return `ws:${actor.workspaceId}:tok:${actor.tokenId}`;
  }
  if (actor.kind === "agent_user") {
    return `user:${actor.userId}:tok:${actor.tokenId}`;
  }
  if (actor.kind === "user") return `user:${actor.userId}`;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "demo";
  return `demo:${ip}`;
}

/**
 * Tenant boundary for every route that resolves a Storage from a
 * caller-supplied workspace slug. The Supabase storage layer runs on the
 * service-role client (bypasses RLS), so this check is the ONLY thing
 * standing between an authenticated caller and another tenant's data.
 *
 *   - `agent` (workspace-scoped token): the token's workspace must be the
 *     resolved workspace.
 *   - `user` / `agent_user`: a `memberships` row must exist — the same
 *     table that decides workspace visibility in the UI
 *     (`listWorkspacesForUser`).
 *   - `demo`: only ever valid against the in-memory demo backend; a demo
 *     actor never touches a real (Supabase) workspace.
 *
 * The in-memory demo backend is exempt for all actors: it is volatile,
 * single-tenant, and only reachable when Supabase is not configured (or
 * for the local demo workspace).
 *
 * Returns null when access is granted, or a Response (403) the route
 * must return directly.
 */
export async function requireWorkspaceMember(
  actor: Actor,
  storage: { backend: "demo" | "supabase"; workspace: { id: string } },
): Promise<Response | null> {
  if (storage.backend !== "supabase") return null;

  const forbidden = (message: string) =>
    Response.json({ error: "forbidden", message }, { status: 403 });

  if (actor.kind === "agent") {
    if (actor.workspaceId !== storage.workspace.id) {
      return forbidden("token does not grant access to this workspace");
    }
    if (!actor.agentId) return null;
    const admin = getSupabaseAdmin();
    const { data: access } = await admin
      .from("agent_workspace_access")
      .select("agent_id")
      .eq("workspace_id", storage.workspace.id)
      .eq("agent_id", actor.agentId)
      .is("revoked_at", null)
      .maybeSingle();
    return access ? null : forbidden("agent is not connected to this workspace");
  }

  if (actor.kind === "agent_user" && actor.agentId) {
    const admin = getSupabaseAdmin();
    const { data: access } = await admin
      .from("agent_workspace_access")
      .select("agent_id")
      .eq("workspace_id", storage.workspace.id)
      .eq("agent_id", actor.agentId)
      .is("revoked_at", null)
      .maybeSingle();
    return access ? null : forbidden("agent is not connected to this workspace");
  }

  if (actor.kind === "user" || actor.kind === "agent_user") {
    const admin = getSupabaseAdmin();
    const { data: mem } = await admin
      .from("memberships")
      .select("user_id")
      .eq("workspace_id", storage.workspace.id)
      .eq("user_id", actor.userId)
      .maybeSingle();
    return mem ? null : forbidden("you are not a member of this workspace");
  }

  // demo actor against a real workspace — only possible via the dev
  // escape hatch; never grant it tenant data.
  return forbidden("authentication required for this workspace");
}

/**
 * Destructive taxonomy gate. Workspace tags are readable by every member and
 * any writer may create, edit and relate them (the `tags:create` /
 * `tags:update` verbs ride on `write`); merging or deleting a definition is
 * limited to owner/admin users or bearer tokens carrying the explicit admin
 * wildcard, on top of `tags:delete`. Also what `GET /api/tags` reports as
 * `can_manage`. Node-tag assignment is a normal node write and never comes
 * through here.
 */
export async function requireWorkspaceAdmin(
  actor: Actor,
  storage: { backend: "demo" | "supabase"; workspace: { id: string } },
): Promise<Response | null> {
  if (storage.backend !== "supabase") return null;
  const forbidden = () =>
    Response.json(
      { error: "forbidden", message: "workspace owner or admin role required" },
      { status: 403 },
    );

  if (actor.kind === "agent") {
    return actor.workspaceId === storage.workspace.id && hasScope(actor.scopes, "admin:*")
      ? null
      : forbidden();
  }
  if (actor.kind === "agent_user" && !hasScope(actor.scopes, "admin:*")) {
    return forbidden();
  }
  if (actor.kind === "user" || actor.kind === "agent_user") {
    const userId = actor.userId;
    const admin = getSupabaseAdmin();
    const { data: membership } = await admin
      .from("memberships")
      .select("role")
      .eq("workspace_id", storage.workspace.id)
      .eq("user_id", userId)
      .maybeSingle();
    return membership && ["owner", "admin"].includes(membership.role as string)
      ? null
      : forbidden();
  }
  return forbidden();
}

/**
 * Pick the workspace for a user-scoped caller that sent no selector.
 *
 * Unambiguous callers (exactly one accessible workspace) resolve silently —
 * this is the common case for OAuth/MCP connections, where the consent
 * screen already recorded which workspaces the agent may touch. Ambiguous
 * callers still get 400, but the message now names the candidate slugs so
 * the client can pick one instead of guessing.
 */
async function resolveImplicitWorkspace(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  agentId: string | null,
): Promise<{ workspaceId: string; slug: string } | Response> {
  const query = agentId
    ? admin
        .from("agent_workspace_access")
        .select("workspaces:workspace_id (id, slug, organization:organizations(slug))")
        .eq("agent_id", agentId)
        .is("revoked_at", null)
    : admin
        .from("memberships")
        .select("workspaces:workspace_id (id, slug, organization:organizations(slug))")
        .eq("user_id", userId);
  const { data, error } = await query;
  if (error) {
    return Response.json(
      { error: "internal", message: error.message },
      { status: 500 },
    );
  }

  // Candidates are named the way the caller has to name them back:
  // `<org>/<workspace>`, because the slug alone no longer picks one out.
  const rows = ((data ?? []) as Array<{
    workspaces:
      | { id: string; slug: string; organization?: { slug: string } | null }
      | null;
  }>).flatMap((row) =>
    row.workspaces
      ? [
          {
            id: row.workspaces.id,
            slug: workspaceRefName(
              row.workspaces.organization?.slug ?? "",
              row.workspaces.slug,
            ),
          },
        ]
      : [],
  );
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const only = rows.length === 1 ? rows[0] : undefined;
  if (only) return { workspaceId: only.id, slug: only.slug };
  if (rows.length === 0) {
    return Response.json(
      {
        error: "forbidden",
        message: agentId
          ? "this agent connection has no workspace access left. Reconnect from the app to grant it a workspace."
          : "you are not a member of any workspace",
      },
      { status: 403 },
    );
  }
  return Response.json(
    {
      error: "workspace_required",
      message:
        `this token can reach ${rows.length} workspaces (${rows
          .map((w) => w.slug)
          .join(", ")}). Pass X-Bcontext-Workspace: <organization>/<workspace> (or ?workspace=) to choose one.`,
      workspaces: rows.map((w) => w.slug),
    },
    { status: 400 },
  );
}

/**
 * Resolve the active workspace for an agent request.
 *
 *   - `agent` (workspace-scoped token): returns the token's workspaceId
 *     and slug. No header required. When the request names a workspace
 *     (`options.workspaceRef`, from a `/mcp/<org>/<workspace>` path) it has
 *     to be the token's own; any other pair is a 404, never a 403 — a
 *     token holder must not learn that a workspace it cannot touch exists.
 *   - `agent_user` (user-scoped token): reads `options.workspaceRef`, else
 *     `X-Bcontext-Workspace` (or `?workspace=<slug>`), resolves the
 *     workspace via the admin client, and verifies that the user has a
 *     membership row. Returns 403 when the user is not a member, 404 when
 *     the workspace itself doesn't exist.
 *
 *     When no selector is present we fall back to the caller's single
 *     accessible workspace. MCP clients (Claude Code, Claude Desktop,
 *     Cursor) authenticate over OAuth and have no way to attach a custom
 *     header, so demanding one made every OAuth connection fail its
 *     `initialize` with 400 `workspace_required`. Since the consent screen
 *     already snapshots the chosen workspaces into `agent_workspace_access`,
 *     an unambiguous connection resolves itself. Only a genuinely ambiguous
 *     caller (2+ workspaces) still gets 400 — now with the slugs listed.
 *
 * Returns either a `{ workspaceId, slug }` pair on success, or a
 * `Response` the route should return directly.
 */
export async function resolveAgentWorkspaceOr401(
  req: Request,
  actor: Actor,
  options: { workspaceRef?: string } = {},
): Promise<{ workspaceId: string; slug: string } | Response> {
  const named = options.workspaceRef?.trim() || "";
  if (actor.kind === "agent") {
    const admin = getSupabaseAdmin();
    // The organization slug is only needed to compare against a named
    // workspace; the plain lookup stays a single-column read otherwise.
    const { data } = await admin
      .from("workspaces")
      .select(named ? "slug, organization:organizations!inner(slug)" : "slug")
      .eq("id", actor.workspaceId)
      .maybeSingle();
    if (named) {
      const ref = parseWorkspaceRef(named);
      const org = (data?.organization as { slug?: string } | null | undefined)?.slug;
      const own = ref && data && org === ref.org && data.slug === ref.workspace;
      if (!own) {
        return Response.json(
          { error: "workspace_not_found", message: `workspace "${named}" not found` },
          { status: 404 },
        );
      }
    }
    if (!data) {
      return Response.json(
        {
          error: "workspace_not_found",
          message:
            "token references a workspace that no longer exists. Generate a new token.",
        },
        { status: 404 },
      );
    }
    if (actor.agentId) {
      const { data: access } = await admin
        .from("agent_workspace_access")
        .select("agent_id")
        .eq("workspace_id", actor.workspaceId)
        .eq("agent_id", actor.agentId)
        .is("revoked_at", null)
        .maybeSingle();
      if (!access) {
        return Response.json(
          { error: "forbidden", message: "agent is not connected to this workspace" },
          { status: 403 },
        );
      }
    }
    return { workspaceId: actor.workspaceId, slug: data.slug as string };
  }
  if (actor.kind !== "agent_user") {
    return Response.json(
      { error: "bearer_required", message: "agent token required" },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="bcontext"' },
      },
    );
  }

  const url = new URL(req.url);
  const asked =
    named ||
    req.headers.get("x-bcontext-workspace")?.trim() ||
    url.searchParams.get("workspace")?.trim() ||
    "";
  const admin = getSupabaseAdmin();

  if (!asked) {
    return resolveImplicitWorkspace(admin, actor.userId, actor.agentId ?? null);
  }

  // A workspace is named `<organization>/<workspace>`. A bare slug is
  // refused rather than resolved to whichever organization happens to
  // match first: writing into the wrong company's workspace is not a
  // failure anyone would notice in time.
  const ref = parseWorkspaceRef(asked);
  if (!ref) {
    return Response.json(
      {
        error: "workspace_required",
        message: `name the workspace as "<organization>/<workspace>" — "${asked}" does not say which organization it belongs to.`,
      },
      { status: 400 },
    );
  }

  const { data: ws } = await admin
    .from("workspaces")
    .select("id, slug, organization:organizations!inner(slug)")
    .eq("slug", ref.workspace)
    .eq("organization.slug", ref.org)
    .maybeSingle();
  if (!ws) {
    return Response.json(
      {
        error: "workspace_not_found",
        message: `workspace "${asked}" not found`,
      },
      { status: 404 },
    );
  }

  const accessQuery = actor.agentId
    ? admin
        .from("agent_workspace_access")
        .select("agent_id")
        .eq("workspace_id", ws.id as string)
        .eq("agent_id", actor.agentId)
        .is("revoked_at", null)
    : admin
        .from("memberships")
        .select("user_id")
        .eq("workspace_id", ws.id as string)
        .eq("user_id", actor.userId);
  const { data: access } = await accessQuery.maybeSingle();
  if (!access) {
    return Response.json(
      {
        error: "forbidden",
        message: actor.agentId
          ? "agent is not connected to this workspace"
          : "you are not a member of this workspace",
      },
      { status: 403 },
    );
  }

  return { workspaceId: ws.id as string, slug: ws.slug as string };
}

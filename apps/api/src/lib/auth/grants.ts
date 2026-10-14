/**
 * Effective permission for a (principal, workspace) pair.
 *
 * The unit of permission is the pair, not the principal and not the workspace:
 * the same person can hold write access in one workspace and read-only, narrowed
 * to a slice of the graph, in another. Organisation membership grants no read
 * access at all — it covers administration and who may be invited — so
 * there is no precedence question between an org role and a workspace reach.
 *
 * ## Why "reach" and not "scope"
 *
 * `scope` is already taken twice here: OAuth scopes (`nodes:read`) and the RAG
 * query lens. The second is built to *widen* — `auto` always keeps a global lane
 * and `can_expand_to_workspace` is a first-class field. Giving the word a third
 * meaning, and an opposite one, in the place where a mistake is a data leak is
 * asking for it.
 *
 * ## No layer underneath
 *
 * No server path in this app evaluates RLS: `getStorage()` is itself
 * service-role. Whatever this module returns is the only thing between a caller
 * and another tenant's data, so it is written to fail closed at every branch:
 *
 *   - Reach composes **additively** (`IN`, never `NOT IN`). An inclusion list
 *     fails closed when an unforeseen case shows up; an exclusion list fails
 *     open.
 *   - A query error is **not** "no grant". Folding database failures into the
 *     legacy fallback would hand a narrowed principal the whole workspace on a
 *     hiccup, silently.
 *   - A grant row that exists but is revoked or expired **denies**. It must
 *     never fall through to the legacy tables, or revoking would revoke nothing
 *     for as long as those tables are still around.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { hasScope } from "@bcontext-dev/contract/auth/scopes";
import { ViewQuerySchema, type ViewQuery } from "@bcontext-dev/contract/views/schema";
import { log } from "@bcontext-dev/contract/log";
import type { Actor } from "./require";

export const VERBS = [
  "read",
  "write",
  "delete",
  // Writing a goal that steers the company: the North Star and every
  // company-scope goal (`isStrategicGoal`). Separate from `write` because
  // those few nodes are what everything else is measured against — an agent
  // that may open its own project objective has no business editing the
  // number the company is aiming at. Project goals stay under `write`.
  "goals:write",
  // The taxonomy is the writer's to shape: an agent that files a task under
  // a tag that does not exist yet should be able to create it, describe it
  // and hang it under a parent in the same breath — that is where the tags
  // come from. `tags:create` and `tags:update` therefore ride on `write`.
  // Merging and deleting stay apart (`tags:delete`): they rewrite how every
  // node under the absorbed tag is classified, and when reaches are
  // expressed in tags they rewrite other principals' reaches.
  "tags:create",
  "tags:update",
  "tags:delete",
  // Granting and revoking access to THIS workspace. Deliberately per-pair like
  // every other verb rather than an organisation-wide flag: holding admin in
  // one workspace should not let you hand out access to another.
  "admin",
] as const;
export type Verb = (typeof VERBS)[number];

/** The slice of the graph a principal can see in one workspace. */
export type Reach =
  | { type: "all" }
  | { type: "query"; query: ViewQuery };

/**
 * Who a grant row is about. `service_account` is a `capability_principals`
 * row that is neither a person nor a token-bearing agent — today, a Slack
 * install acting for a whole channel — and its `id` is that row's id.
 */
export type PrincipalKind = "user" | "agent" | "service_account";

export interface Grant {
  workspaceId: string;
  principal: { kind: PrincipalKind | "system"; id: string | null };
  verbs: readonly Verb[];
  reach: Reach;
}

export type Denied =
  /** No grant at all: the workspace must behave as if it does not exist. */
  | { denied: "not_found" }
  /** Has a grant, lacks the verb. Safe to say so — they already know it exists. */
  | { denied: "forbidden"; verb: Verb };

export function isDenied(value: Grant | Denied): value is Denied {
  return "denied" in value;
}

export function hasVerb(grant: Grant, verb: Verb): boolean {
  return grant.verbs.includes(verb);
}

/**
 * Whether `granter` may hand out `verbs` over `reach`.
 *
 * The rule that makes it safe to expose granting over MCP at all: **nobody
 * grants more than they hold**. Without it every other safeguard is decoration,
 * because an agent with `admin` could simply widen itself and then do anything.
 *
 * Two halves, and the second is the one that is easy to forget:
 *
 *  - Verbs must be a subset. Straightforward.
 *  - Reach must not widen. A granter narrowed to `finanzas` cannot hand out
 *    `all`, nor a different tag it cannot see itself. Comparing reaches
 *    precisely is undecidable in general, so this is deliberately conservative:
 *    an unrestricted granter may grant anything, a narrowed one may only grant
 *    a reach whose tag set is a subset of its own. Anything it cannot prove is
 *    narrower, it refuses.
 */
export function canGrant(
  granter: Grant,
  verbs: readonly Verb[],
  reach: Reach,
): { ok: true } | { ok: false; reason: string } {
  const missing = verbs.filter((v) => !granter.verbs.includes(v));
  if (missing.length > 0) {
    return { ok: false, reason: `cannot grant verbs you do not hold: ${missing.join(", ")}` };
  }

  if (granter.reach.type === "all") return { ok: true };

  if (reach.type === "all") {
    return { ok: false, reason: "cannot grant unrestricted reach from a narrowed one" };
  }

  const mine = new Set([...granter.reach.query.tags_any, ...granter.reach.query.tags_all]);
  const theirs = [...reach.query.tags_any, ...reach.query.tags_all];
  if (theirs.length === 0) {
    return { ok: false, reason: "cannot grant a reach with no tag filter from a narrowed one" };
  }
  const outside = theirs.filter((tag) => !mine.has(tag));
  if (outside.length > 0) {
    return {
      ok: false,
      reason: `cannot grant reach outside your own: ${outside.join(", ")}`,
    };
  }
  return { ok: true };
}

/** A principal may never grant to itself, whatever its verbs say. */
export function isSelfGrant(
  granter: Grant,
  target: { kind: PrincipalKind; id: string },
): boolean {
  return granter.principal.kind === target.kind && granter.principal.id === target.id;
}

/**
 * A well-formed ViewQuery that matches nothing, used when a stored reach cannot
 * be trusted. It has to be a *valid* query — anything downstream may run it
 * through `ViewQuerySchema.parse`, and a malformed sentinel would throw a 500
 * instead of quietly denying. The tag id is the nil UUID, which no real tag can
 * hold.
 */
const DENY_EVERYTHING: ViewQuery = ViewQuerySchema.parse({
  schema_version: 1,
  tags_any: ["00000000-0000-0000-0000-000000000000"],
});

export const DENY_REACH: Reach = { type: "query", query: DENY_EVERYTHING };

/**
 * Full access for paths that act as the system rather than on behalf of anyone:
 * the queue worker, webhook ingestion, connector sync. Deliberately explicit —
 * a `systemGrant()` call is visible in a diff and can be audited, which an
 * optional parameter defaulting to unrestricted would not be.
 */
export function systemGrant(workspaceId: string, why: string): Grant {
  void why; // documents the call site; kept in the signature so it must be given
  return {
    workspaceId,
    principal: { kind: "system", id: null },
    verbs: VERBS,
    reach: { type: "all" },
  };
}

const OWNER_VERBS: readonly Verb[] = VERBS;
// `editor` is the DEFAULT membership role and invite acceptance copies it, so
// this set is what most members get. Any member could delete nodes before this
// change; dropping `delete` here would 403 every non-owner on deletion, which
// is a product decision, not a side effect of adding reach.
// `goals:write` is deliberately NOT here. An editor could edit a company goal
// before this verb existed — but no company goals existed either, so nothing
// is taken away; the strategic layer arrives already narrowed to owners and
// admins, which is the only direction this can safely be introduced in.
const EDITOR_VERBS: readonly Verb[] = ["read", "write", "delete", "tags:create", "tags:update"];
const VIEWER_VERBS: readonly Verb[] = ["read"];

export function verbsForRole(role: string): readonly Verb[] {
  switch (role) {
    case "owner":
    case "admin":
      return OWNER_VERBS;
    case "editor":
    case "agent":
      return EDITOR_VERBS;
    case "viewer":
      return VIEWER_VERBS;
    default:
      // An unrecognised role gets the least, never the most.
      return VIEWER_VERBS;
  }
}

/**
 * Translate OAuth scopes to verbs, honouring the `admin:*` wildcard exactly as
 * `hasScope` does everywhere else. Getting this wrong locks out every token
 * that carries only the wildcard, because it would
 * pass `gate()` and then resolve to no verbs at all.
 */
export function verbsForScopes(scopes: readonly string[]): readonly Verb[] {
  const verbs: Verb[] = [];
  // `chat:run`, `agents:read` and `skills:execute` are mintable on their own and
  // documented as such. They all read workspace content to do their job, so a
  // token carrying only one of them has to resolve to `read` — otherwise it
  // passes `gate` and then 403s on /api/nexo, /api/agents/context and
  // /api/skills/:id/run, all of which it could call before this change.
  const READ_IMPLYING = ["nodes:read", "chat:run", "agents:read", "skills:execute"];
  if (READ_IMPLYING.some((scope) => scopes.includes(scope)) || scopes.includes("admin:*")) {
    verbs.push("read");
  }
  if (hasScope(scopes, "nodes:write") || scopes.includes("agents:write")) {
    // Creating, describing and relating tags is part of writing (see the
    // verb list); only merge/delete need the wildcard below.
    verbs.push("write", "delete", "tags:create", "tags:update");
    // Writing implies reading. Every write route reads first — PATCH and DELETE
    // both `getNode` before touching anything, upload resolves the node it
    // attaches to, and agent write ops fetch the row they patch. A token minted
    // with only `nodes:write` (the scope picker allows any subset) would
    // otherwise pass `gate` and then 403 inside the scoped storage's read check.
    if (!verbs.includes("read")) verbs.unshift("read");
  }
  if (scopes.includes("admin:*")) {
    if (!verbs.includes("tags:create")) verbs.push("tags:create", "tags:update");
    verbs.push("tags:delete");
    // `goals:write` rides on the wildcard for the same reason the tag verbs
    // do: it says "this credential may call anything its principal can", and
    // the principal still has to hold the verb in its own grant row for the
    // intersection above to keep it. A narrower token (`nodes:write`) is
    // bounded away from the strategic layer even when its principal holds it.
    verbs.push("goals:write");
    // `admin` is deliberately NOT derived from `admin:*` here. A token wildcard
    // says "this credential may call anything its principal can"; it does not
    // say the principal may hand out access. Granting has to be given to a
    // principal explicitly, in its own grant row, or the safeguard against an
    // agent widening itself is one token mint away from being void.
  }
  return verbs;
}

/**
 * Parse a stored reach, denying anything that cannot be validated. The database
 * only guarantees the value is an object with a `type`, so `{"type":"query"}`
 * with no query is perfectly insertable; trusting it would produce an undefined
 * filter, which is the fail-open this module exists to prevent.
 */
function parseReach(raw: unknown, context: { workspaceId: string }): Reach {
  if (!raw || typeof raw !== "object") return DENY_REACH;
  const value = raw as { type?: unknown; query?: unknown };

  if (value.type === "all") return { type: "all" };

  if (value.type === "query") {
    const parsed = ViewQuerySchema.safeParse(value.query);
    if (parsed.success) {
      // Only tag predicates are resolvable as a reach today. A stored reach
      // that leans on kinds, statuses, dates, source, actor or traversal would
      // have those predicates silently dropped — `{tags_any:["finanzas"],
      // kinds:["task"]}` would reach every finanzas node of every kind,
      // including the docs the grantor meant to exclude. Deny instead of
      // widening, and say so in the log.
      const q = parsed.data;
      const unsupported = [
        q.kinds.length > 0 && "kinds",
        q.statuses.length > 0 && "statuses",
        q.dates.length > 0 && "dates",
        q.source.length > 0 && "source",
        q.actor.length > 0 && "actor",
        q.root_node_ids.length > 0 && "root_node_ids",
        q.traversal !== null && "traversal",
      ].filter((x): x is string => Boolean(x));

      if (unsupported.length > 0) {
        log.warn("grants.reach.unsupported_predicates", {
          workspace_id: context.workspaceId,
          predicates: unsupported.join(","),
        });
        return DENY_REACH;
      }
      return { type: "query", query: q };
    }
    log.warn("grants.reach.invalid", {
      workspace_id: context.workspaceId,
      reason: "query failed validation",
    });
    return DENY_REACH;
  }

  log.warn("grants.reach.unknown_type", {
    workspace_id: context.workspaceId,
    type: String(value.type),
  });
  return DENY_REACH;
}

/**
 * Resolve what `actor` may do in `workspaceId`.
 *
 * Reads `workspace_grants` when a row exists and falls back to the legacy
 * `memberships` / `agent_workspace_access` tables when none does, always with
 * reach `all`. The fallback is what lets principals without a grant row keep
 * working: grants are mirrored on write (`grant-sync.ts`), never backfilled.
 */
export async function resolveGrant(
  actor: Actor,
  workspaceId: string,
): Promise<Grant | Denied> {
  if (actor.kind === "demo") return { denied: "not_found" };

  // An agent token is minted for one workspace. Asking about another is not a
  // permission failure, it is a different tenant entirely.
  if (actor.kind === "agent" && actor.workspaceId !== workspaceId) {
    return { denied: "not_found" };
  }

  const principal = principalFor(actor);

  // A workspace token with no agent attached (`agent_tokens.agent_id` is
  // nullable, and every token minted before agent connections has none) has no
  // principal to look up. Today's boundary lets these through on the token's
  // own scopes; keep that until they are migrated, or every pre-connection
  // token loses all access at once.
  if (!principal) {
    if (actor.kind === "agent") {
      return {
        workspaceId,
        principal: { kind: "agent", id: null },
        verbs: verbsForScopes(actor.scopes),
        reach: { type: "all" },
      };
    }
    return { denied: "not_found" };
  }

  const admin = getSupabaseAdmin();

  // Deliberately unfiltered on revoked_at/expires_at: the row's existence and
  // its validity are different questions. Filtering here would make a revoked
  // grant look like no grant, and fall through to the legacy tables — so
  // revoking would revoke nothing for the whole coexistence window.
  const { data: row, error } = await admin
    .from("workspace_grants")
    .select("verbs, reach, revoked_at, expires_at")
    .eq("workspace_id", workspaceId)
    .eq("principal_kind", principal.kind)
    .eq("principal_id", principal.id)
    .maybeSingle();

  if (error) {
    // `undefined_table` (42P01) is the expected shape before the migration is
    // applied, and only then is the legacy fallback correct. Anything else is a
    // real failure and must not hand out access it cannot verify.
    if (error.code === "42P01") return legacyGrant(actor, workspaceId, principal);
    log.error("grants.lookup_failed", {
      workspace_id: workspaceId,
      principal_kind: principal.kind,
      code: error.code,
      message: error.message,
    });
    return { denied: "not_found" };
  }

  if (row) {
    const revoked = row.revoked_at !== null;
    const expired =
      row.expires_at !== null && new Date(row.expires_at as string) <= new Date();
    if (revoked || expired) return { denied: "not_found" };

    // The grant row is authoritative. It stopped being intersected with the
    // legacy tables once `grant-sync.ts` began mirroring every membership and
    // connection write into it, so the two can no longer disagree.
    //
    // That intersection was load-bearing while nothing wrote grants: a stale row
    // would have outlived the access it came from, and revoking would have
    // revoked nothing. But it also meant a grant could never *widen* — which
    // broke invitations, whose whole purpose is to grant access to someone who
    // has no membership yet, and quietly capped anyone whose role was narrower
    // than their granted verbs.
    //
    // One bound survives on purpose: a credential cannot exceed the scopes it
    // was issued with. A bearer token minted `nodes:read` must not gain writes
    // because the principal it acts for holds them.
    const stored = (row.verbs as Verb[]) ?? [];
    const tokenBound =
      actor.kind === "agent" || actor.kind === "agent_user"
        ? verbsForScopes(actor.scopes)
        : null;

    return {
      workspaceId,
      principal,
      verbs: tokenBound ? stored.filter((v) => tokenBound.includes(v)) : stored,
      reach: parseReach(row.reach, { workspaceId }),
    };
  }

  return legacyGrant(actor, workspaceId, principal);
}

function principalFor(
  actor: Actor,
): { kind: "user" | "agent"; id: string } | null {
  switch (actor.kind) {
    case "agent":
      return actor.agentId ? { kind: "agent", id: actor.agentId } : null;
    case "agent_user":
      return actor.agentId
        ? { kind: "agent", id: actor.agentId }
        : { kind: "user", id: actor.userId };
    case "user":
      return { kind: "user", id: actor.userId };
    default:
      return null;
  }
}

/**
 * Pre-migration path: derive the grant from the tables that hold access today.
 * Always reach `all`, so behaviour is unchanged until grants are written.
 */
async function legacyGrant(
  actor: Actor,
  workspaceId: string,
  principal: { kind: "user" | "agent"; id: string },
): Promise<Grant | Denied> {
  // A plain session has no scopes at all — `null`, not an empty list. An
  // agent_user token with zero scopes is a different thing and must still
  // intersect to nothing.
  return legacyGrantForPrincipal(
    workspaceId,
    principal,
    "scopes" in actor ? actor.scopes : null,
  );
}

/**
 * The same lookup with the credential separated out.
 *
 * `tokenScopes` is the bound the *caller's* credential puts on the answer, and
 * it only exists when the principal is the one making the request. Pass `null`
 * when asking about somebody who is not present — invitation acceptance asks
 * what the inviter still holds, and the inviter has no token in that request.
 * Bounding by an absent credential would resolve every such question to "no
 * access at all", which is not the same answer.
 */
async function legacyGrantForPrincipal(
  workspaceId: string,
  principal: { kind: PrincipalKind; id: string },
  tokenScopes: readonly string[] | null,
): Promise<Grant | Denied> {
  // A service account has no legacy table to fall back to: its grant row is
  // the only place its access was ever written, so "no row" is "no access".
  if (principal.kind === "service_account") return { denied: "not_found" };

  const admin = getSupabaseAdmin();

  if (principal.kind === "agent") {
    const { data } = await admin
      .from("agent_workspace_access")
      .select("role, scopes")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", principal.id)
      .is("revoked_at", null)
      .maybeSingle();
    if (!data) return { denied: "not_found" };
    // The token's own scopes bound what the connection allows, so intersect:
    // a connection approved for writes does not widen a read-only token.
    const fromAccess = verbsForScopes((data.scopes as string[]) ?? []);
    const verbs =
      tokenScopes === null
        ? fromAccess
        : verbsForScopes(tokenScopes).filter((v) => fromAccess.includes(v));
    return { workspaceId, principal, verbs, reach: { type: "all" } };
  }

  const { data } = await admin
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", principal.id)
    .maybeSingle();

  // No membership in the workspace itself is not the end of the question:
  // whoever owns or administers the organization administers everything
  // inside it. That is what an organization is for — otherwise its admin has
  // to add themselves, one by one, to projects they are already responsible
  // for, and a workspace someone else created inside their company is
  // invisible to them. Editor and viewer at org level grant nothing here:
  // those people are let into workspaces one at a time, on purpose.
  const role = data ? String(data.role) : await orgAdminRole(workspaceId, principal.id);
  if (!role) return { denied: "not_found" };

  const roleVerbs = verbsForRole(role);
  // An OAuth/user token still cannot exceed the scopes it was issued with. A
  // plain session carries no scopes and is not bounded by them, which is why
  // "no token" (null) and "a token with no scopes" ([]) have to stay different.
  const verbs =
    tokenScopes !== null
      ? roleVerbs.filter((v) => verbsForScopes(tokenScopes).includes(v))
      : roleVerbs;

  return { workspaceId, principal, verbs, reach: { type: "all" } };
}

/**
 * `owner` / `admin` when the user administers the organization that holds
 * this workspace, null otherwise. One extra query, and only on the path
 * where the workspace membership was absent.
 */
async function orgAdminRole(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const admin = getSupabaseAdmin();
  const { data: ws } = await admin
    .from("workspaces")
    .select("organization_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws?.organization_id) return null;
  const { data: membership } = await admin
    .from("organization_memberships")
    .select("role")
    .eq("organization_id", ws.organization_id as string)
    .eq("user_id", userId)
    .maybeSingle();
  const role = membership?.role as string | undefined;
  return role === "owner" || role === "admin" ? role : null;
}

/**
 * What a principal holds in a workspace, asked about somebody who is not the
 * caller.
 *
 * Invitation acceptance needs this: it has to know what the *inviter* can hand
 * out right now, days after they wrote the invitation, and the inviter is not
 * the one making the request. Deliberately unbounded by any credential — the
 * question is what the principal holds, not what some token of theirs allows.
 */
export async function resolveGrantForPrincipal(
  principal: { kind: PrincipalKind; id: string },
  workspaceId: string,
): Promise<Grant | Denied> {
  const admin = getSupabaseAdmin();

  // Unfiltered on revoked_at/expires_at for the same reason as `resolveGrant`:
  // a revoked grant must deny, not look like no grant and fall through to the
  // legacy tables.
  const { data: row, error } = await admin
    .from("workspace_grants")
    .select("verbs, reach, revoked_at, expires_at")
    .eq("workspace_id", workspaceId)
    .eq("principal_kind", principal.kind)
    .eq("principal_id", principal.id)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01") {
      return legacyGrantForPrincipal(workspaceId, principal, null);
    }
    log.error("grants.principal_lookup_failed", {
      workspace_id: workspaceId,
      principal_kind: principal.kind,
      code: error.code,
      message: error.message,
    });
    return { denied: "not_found" };
  }

  if (row) {
    const revoked = row.revoked_at !== null;
    const expired =
      row.expires_at !== null && new Date(row.expires_at as string) <= new Date();
    if (revoked || expired) return { denied: "not_found" };

    // Authoritative, exactly as in `resolveGrant`. Intersecting with the
    // membership role here broke the invitation chain it exists to serve: an
    // admin grant beside an `editor` membership resolved to editor, so someone
    // invited as an admin could not invite anyone else — and the refusal named
    // a role nobody had mentioned.
    return {
      workspaceId,
      principal,
      verbs: (row.verbs as Verb[]) ?? [],
      reach: parseReach(row.reach, { workspaceId }),
    };
  }

  return legacyGrantForPrincipal(workspaceId, principal, null);
}

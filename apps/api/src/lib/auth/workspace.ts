/**
 * One entry point for "authenticate, authorise, and give me a storage I cannot
 * misuse".
 *
 * Thirty-one routes repeat the same three steps today: `gate`, `getStorage`,
 * `requireWorkspaceMember`. That sequence proves the caller belongs to the
 * workspace and stops there — it cannot say "and only the finanzas slice", and
 * a route that forgets the third step leaks the whole tenant. Two did.
 *
 * `openWorkspace` does the three steps and returns a storage already narrowed
 * to the caller's grant, so a route physically cannot read past it. The
 * difference that matters is not the saved lines; it is that the unsafe thing
 * stops being reachable by omission.
 */
import { gate, type Actor } from "./require";
import { resolveGrant, isDenied, hasVerb, type Grant, type Verb } from "./grants";
import { scopedStorage } from "@/lib/storage/scoped";
import { getStorage, getStorageById, type Storage } from "@/lib/storage";
import { systemGrant } from "./grants";
import { hasScope, type Scope } from "@bcontext-dev/contract/auth/scopes";

export interface WorkspaceContext {
  /** Narrowed to the grant. Reads and writes past the reach are not possible. */
  storage: Storage;
  grant: Grant;
  actor: Actor;
}

/**
 * The OAuth scope a verb requires. Unchanged from what routes ask for today —
 * verbs are the new, finer axis and do not loosen the old one. A token still
 * has to carry `nodes:write` to write, and now also needs the verb.
 */
const SCOPE_FOR_VERB: Record<Verb, Scope> = {
  read: "nodes:read",
  write: "nodes:write",
  delete: "nodes:write",
  // Writing a goal is writing a node, so the token requirement is unchanged;
  // what the strategic layer adds is the VERB, checked in `scopedStorage`
  // against the node actually being written. Demanding `admin:*` here instead
  // would make the scope the gate and the verb decoration.
  "goals:write": "nodes:write",
  // Shaping the taxonomy is writing (see `VERBS`); dissolving it is not.
  "tags:create": "nodes:write",
  "tags:update": "nodes:write",
  "tags:delete": "admin:*",
  admin: "admin:*",
};

/**
 * Resolve a request into a scoped storage, or the response to return instead.
 *
 * A caller with no grant gets **404, not 403**: a 403 confirms the workspace
 * exists, which is the whole point of "if you were only given one workspace,
 * that is the only one that exists for you". A caller with a grant but without
 * the verb gets 403 — they already know the workspace is there.
 */
export async function openWorkspace(
  req: Request,
  workspaceSlug: string | null | undefined,
  verb: Verb,
  options: OpenOptions = {},
): Promise<WorkspaceContext | Response> {
  if (!workspaceSlug) {
    return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  }
  return open(req, verb, options, () => getStorage(workspaceSlug));
}

/**
 * Same, for the six routes that address the workspace by UUID because the id
 * arrives in the request body (connector config, ingest candidates). Resolving
 * a slug they do not have would mean inventing one; giving them an exemption
 * would mean an exemption that is not true.
 */
export async function openWorkspaceById(
  req: Request,
  workspaceId: string | null | undefined,
  verb: Verb,
  options: OpenOptions = {},
): Promise<WorkspaceContext | Response> {
  if (!workspaceId) {
    return Response.json({ error: "workspace_id required" }, { status: 400 });
  }
  return open(req, verb, options, () => getStorageById(workspaceId));
}

export interface OpenOptions {
  /**
   * The OAuth scope to demand. Defaults to the verb's scope; pass `null` for
   * the handful of routes that call `gate(req)` with no scope today.
   *
   * That escape hatch exists so this change does not quietly tighten the token
   * requirements of routes it was only meant to add reach to. Demanding a scope
   * where none was demanded is a real, observable change for existing agent
   * tokens, and it deserves its own decision rather than riding along in a
   * refactor.
   */
  scope?: Scope | null;
}

/**
 * For routes whose workspace only becomes known after reading the body.
 *
 * Authentication is cheap and needs no workspace; parsing a multipart upload is
 * not. Doing both in one call forces such a route to choose between parsing
 * before it knows who is calling — letting an anonymous caller make the server
 * read megabytes — and gating twice, which charges two rate-limit tokens per
 * request. Splitting the two lets it authenticate first, parse second, and
 * authorise the workspace last, on one gate.
 */
export async function openWorkspaceForActor(
  actor: Actor,
  workspaceSlug: string | null | undefined,
  verb: Verb,
): Promise<WorkspaceContext | Response> {
  if (!workspaceSlug) {
    return Response.json({ error: "?workspace=<slug> required" }, { status: 400 });
  }
  return authorise(actor, verb, () => getStorage(workspaceSlug));
}

async function open(
  req: Request,
  verb: Verb,
  options: OpenOptions,
  resolve: () => Promise<Storage | null>,
): Promise<WorkspaceContext | Response> {
  const scope = options.scope === null ? undefined : options.scope ?? SCOPE_FOR_VERB[verb];
  const gated = await gate(req, scope);
  if (gated instanceof Response) return gated;
  return authorise(gated, verb, resolve);
}

/**
 * Does this principal get to see a credential's plaintext?
 *
 * A person behind a session cookie does: the vault is theirs, and the web UI
 * is where they read it. A bearer token does not, unless it was handed
 * `credentials:use` by name — because everything a token's holder reads is
 * written into a transcript, replayed to a model provider and often
 * summarised into a log, none of which anybody rotates.
 */
function masksCredentials(actor: Actor): boolean {
  if (actor.kind !== "agent" && actor.kind !== "agent_user") return false;
  return !hasScope(actor.scopes, "credentials:use");
}

async function authorise(
  gated: Actor,
  verb: Verb,
  resolve: () => Promise<Storage | null>,
): Promise<WorkspaceContext | Response> {
  const inner = await resolve();
  if (!inner) return notFound();

  // The demo backend is an in-memory store with no tenant data, and the old
  // boundary skipped membership entirely for it (`requireWorkspaceMember`
  // returns null when the backend is not Supabase). Carrying that carve-out
  // over keeps the documented "runs without Supabase" path working; dropping it
  // would 404 every request in dev, because `gate` hands back a `demo` actor
  // outside production and `resolveGrant` denies that actor by design.
  if (inner.backend !== "supabase") {
    return { storage: inner, grant: systemGrant(inner.workspace.id, "demo backend"), actor: gated };
  }

  const grant = await resolveGrant(gated, inner.workspace.id);
  if (isDenied(grant)) {
    return grant.denied === "forbidden"
      ? Response.json({ error: "forbidden", verb: grant.verb }, { status: 403 })
      : notFound();
  }

  if (!hasVerb(grant, verb)) {
    return Response.json({ error: "forbidden", verb }, { status: 403 });
  }

  return {
    storage: scopedStorage(inner, grant, { maskCredentials: masksCredentials(gated) }),
    grant,
    actor: gated,
  };
}

/**
 * Deliberately identical in shape to a missing workspace. Anything that
 * distinguishes "you may not" from "there is nothing here" hands out the
 * existence of another tenant's workspace.
 */
function notFound(): Response {
  return Response.json({ error: "workspace not found" }, { status: 404 });
}

/**
 * Inviting someone who is not a principal yet.
 *
 * `grantAccess` needs a principal id: a user row, an agent row, something that
 * already exists. Half of the real cases are the other half — "give the new
 * analyst read access to finanzas" when the new analyst has no account. This
 * module is that sibling, and it carries the same rules, because an invitation
 * that could promise more than a grant could give would simply be the way
 * everyone escalates.
 *
 * ## An invitation is a promise, not access
 *
 * Nothing here writes `workspace_grants`. The permission lives *in the
 * invitation* and the grant is born on acceptance. A pending invitation that
 * already granted access would be access handed to nobody: it does not show up
 * on the "who can reach this workspace" list with a face behind it, so nobody
 * reviews it and nobody revokes it. The grant appears the moment there is a
 * person to attach it to, and not before.
 *
 * ## The reply says nothing about who is already here
 *
 * `inviteToWorkspace` returns the same receipt whether the address was invited
 * or already belongs to a member. Otherwise anyone holding `admin` — including
 * an agent — could walk a list of addresses through it and read off which ones
 * work at the company. That is a membership oracle, and it is worth more to an
 * attacker than most of what is inside the workspace. Both outcomes are built
 * by the same `receipt()` call so a later edit cannot make them drift apart.
 *
 * ## Sending the email is the only thing here that cannot be undone
 *
 * Granting, revoking, deleting, expiring — every other action in this system is
 * reversible inside the database. An email is not: it leaves, it carries the
 * organisation's name and the sender's reputation, and no amount of admin
 * undoes it in the recipient's inbox. That asymmetry is why an agent does not
 * get to send one on its own judgement.
 *
 * So an invitation created by an agent principal is written in `held`: the row
 * exists, the permission is recorded, the audit entry is there, and nothing has
 * left the building. A person with `admin` releases it (`releaseInvitation`),
 * which is a two-second act with full context — who, what verbs, what reach —
 * rather than a blanket "agents may email people" decision made once. Agents
 * are additionally rate limited per organisation, because the failure mode of a
 * prompt-injected agent is not one bad invitation, it is two hundred of them
 * sent from our domain in a minute.
 *
 * A person's own invitation is written `pending` and may be sent immediately:
 * the irreversible act already has a human behind it.
 */
import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { log } from "@bcontext-dev/contract/log";
import { ViewQuerySchema } from "@bcontext-dev/contract/views/schema";
import {
  VERBS,
  canGrant,
  isDenied,
  isSelfGrant,
  resolveGrantForPrincipal,
  type Grant,
  type Reach,
  type Verb,
} from "./grants";

export class InvitationError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "invalid" | "rate_limited",
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

/** 14 days is what the existing invite email promises; keep the two in step. */
const DEFAULT_TTL_DAYS = 14;
/**
 * A year-long invitation is a credential lying around, not an invitation. The
 * cap is deliberately well below "forever" so that forgetting to revoke one is
 * survivable.
 */
const MAX_TTL_DAYS = 90;

/**
 * How many invitations one organisation may have an agent create per hour.
 * Small on purpose: legitimate agent-driven onboarding is a handful of people,
 * and a compromised agent is a mailing list.
 */
export const AGENT_INVITE_RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export interface InvitationInput {
  email: string;
  /** Optional, so the invitation email can address a person by name. */
  name?: string | null;
  /** What they will hold once they accept. Never granted before then. */
  verbs: Verb[];
  reach: Reach;
  /** Defaults to 14 days, capped at 90. */
  expiresInDays?: number;
}

/**
 * Deliberately uniform. It carries no invite id, no token, and nothing that
 * differs between "invited" and "already a member" — see the header.
 */
export interface InvitationReceipt {
  status: "accepted_for_delivery";
  message: string;
  expires_at: string;
  delivery: "held_for_release" | "ready_to_send";
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function requireAdmin(grant: Grant): void {
  if (!grant.verbs.includes("admin")) {
    throw new InvitationError(
      "forbidden",
      'this principal lacks the "admin" permission in this workspace',
    );
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(raw: string): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new InvitationError("invalid", "that is not a usable email address");
  }
  return email;
}

function checkVerbs(verbs: readonly Verb[]): void {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    throw new InvitationError("invalid", "an invitation must promise at least one verb");
  }
  const unknown = verbs.filter((v) => !(VERBS as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new InvitationError("invalid", `unknown verbs: ${unknown.join(", ")}`);
  }
}

/**
 * Refuse now what `parseReach` would silently deny later.
 *
 * A stored reach leaning on kinds, statuses or traversal resolves to
 * DENY_REACH when it is read back, so the invitee would accept an invitation
 * and land on an empty workspace with nobody able to say why. Failing at write
 * time puts the error in front of the person who can fix it.
 */
function checkReach(reach: Reach): void {
  if (reach?.type === "all") return;
  if (reach?.type !== "query") {
    throw new InvitationError("invalid", "reach must be {type:'all'} or {type:'query'}");
  }
  const parsed = ViewQuerySchema.safeParse(reach.query);
  if (!parsed.success) {
    throw new InvitationError("invalid", "reach query is not a valid ViewQuery");
  }
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
    throw new InvitationError(
      "invalid",
      `a reach can only filter by tags today; drop: ${unsupported.join(", ")}`,
    );
  }
}

/**
 * The organisation role written alongside the verbs.
 *
 * It is derived, never asked for. The grant is authoritative now, so the role no
 * longer clamps it — but the two still travel together, and a `viewer` role
 * beside a grant promising `write` is a contradiction sitting in the database
 * waiting for someone to read the wrong one. Deriving it means the question
 * "which is right?" cannot come up.
 */
export type InviteRole = "admin" | "editor" | "viewer";
export function roleForVerbs(verbs: readonly Verb[]): InviteRole {
  if (verbs.includes("admin")) return "admin";
  if (verbs.includes("write") || verbs.includes("delete")) return "editor";
  return "viewer";
}

function receipt(expiresAt: string, held: boolean): InvitationReceipt {
  return {
    status: "accepted_for_delivery",
    // One sentence for every outcome. If this ever needs to differ by case,
    // the case belongs in the audit log, not in the reply.
    message:
      "If this address does not already have access, an invitation will be delivered to it.",
    expires_at: expiresAt,
    delivery: held ? "held_for_release" : "ready_to_send",
  };
}

interface WorkspaceRef {
  id: string;
  organization_id: string;
}

async function loadWorkspace(workspaceId: string): Promise<WorkspaceRef> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("workspaces")
    .select("id, organization_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new InvitationError("invalid", `workspace lookup: ${error.message}`);
  if (!data) throw new InvitationError("not_found", "workspace not found");
  return {
    id: data.id as string,
    organization_id: data.organization_id as string,
  };
}

/**
 * Email → user id, service-role only. The function is named for the waitlist
 * flow it was written for (0019/0020) but it is a plain lookup, and reusing it
 * avoids paginating `auth.admin.listUsers` on every invitation.
 */
async function userIdForEmail(email: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc("waitlist_invite_user_state", {
    p_email: email,
  });
  if (error) {
    // Not fatal: failing to prove somebody is already a member only means we
    // write an invitation they do not need. Failing closed here would turn a
    // database hiccup into "nobody can be invited".
    log.warn("invitation.user_lookup_failed", { error: error.message });
    return null;
  }
  const rows = Array.isArray(data) ? data : [];
  const first = rows[0] as { user_id?: string } | undefined;
  return first?.user_id ?? null;
}

/** Does this user already reach this workspace, by grant or legacy membership? */
async function alreadyHasAccess(userId: string, workspaceId: string): Promise<boolean> {
  const current = await resolveGrantForPrincipal({ kind: "user", id: userId }, workspaceId);
  return !isDenied(current);
}

async function agentInvitesInWindow(organizationId: string): Promise<number> {
  const admin = getSupabaseAdmin();
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error } = await admin
    .from("workspace_invites")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("invited_by_kind", "agent")
    .gte("created_at", since);
  if (error) {
    // A limit that cannot be counted has to bite, not wave things through:
    // this is the only brake on the one irreversible action in the system.
    throw new InvitationError(
      "rate_limited",
      "cannot verify the invitation rate limit right now; try again shortly",
    );
  }
  return count ?? 0;
}

/**
 * Invite an address to a workspace with the permission it will hold on accept.
 */
export async function inviteToWorkspace(
  granter: Grant,
  input: InvitationInput,
): Promise<InvitationReceipt> {
  requireAdmin(granter);

  const email = normaliseEmail(input.email);
  checkVerbs(input.verbs);
  checkReach(input.reach);

  // The same rule as `grantAccess`, and it has to be this one rather than a
  // looser cousin: if an invitation could promise more than the inviter could
  // grant, inviting would simply be how everyone escalates.
  const allowed = canGrant(granter, input.verbs, input.reach);
  if (!allowed.ok) throw new InvitationError("forbidden", allowed.reason);

  const days = Math.min(
    Math.max(1, Math.floor(input.expiresInDays ?? DEFAULT_TTL_DAYS)),
    MAX_TTL_DAYS,
  );
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const workspace = await loadWorkspace(granter.workspaceId);

  const fromAgent = granter.principal.kind === "agent";
  if (fromAgent) {
    const used = await agentInvitesInWindow(workspace.organization_id);
    if (used >= AGENT_INVITE_RATE_LIMIT) {
      throw new InvitationError(
        "rate_limited",
        `agents may create at most ${AGENT_INVITE_RATE_LIMIT} invitations per hour in this organisation`,
      );
    }
  }

  const existingUserId = await userIdForEmail(email);

  if (existingUserId && isSelfGrant(granter, { kind: "user", id: existingUserId })) {
    // The same door `grantAccess` closes. Telling the caller its own address is
    // its own leaks nothing it did not already know.
    throw new InvitationError("forbidden", "a principal cannot invite itself");
  }

  if (existingUserId && (await alreadyHasAccess(existingUserId, workspace.id))) {
    // Same receipt, same shape, same words — see the header. The distinction
    // is recorded where only an auditor can read it.
    await audit(granter, "invite_noop", {
      email_domain: email.split("@")[1] ?? null,
      reason: "already_has_access",
    });
    return receipt(expiresAt, fromAgent);
  }

  const admin = getSupabaseAdmin();
  const token = newToken();
  const row = {
    organization_id: workspace.organization_id,
    workspace_id: workspace.id,
    email,
    invitee_name: input.name?.trim() || null,
    role: roleForVerbs(input.verbs),
    verbs: input.verbs,
    reach: input.reach,
    reach_version: 1,
    token,
    // `invited_by` stays the human on the hook. For an agent that is the person
    // who connected it — "an agent did it" is not an answer anyone can act on.
    invited_by: granter.principal.kind === "user" ? granter.principal.id : null,
    invited_by_kind: fromAgent ? "agent" : "user",
    invited_by_agent_id: fromAgent ? granter.principal.id : null,
    expires_at: expiresAt,
    delivery_state: fromAgent ? "held" : "pending",
  };

  // One pending invitation per (organisation, address): refreshing beats
  // stacking duplicates, exactly as `createInvite` already does.
  const { data: existing } = await admin
    .from("workspace_invites")
    .select("id")
    .eq("organization_id", workspace.organization_id)
    .eq("email", email)
    .is("accepted_at", null)
    .maybeSingle();

  const { error } = existing?.id
    ? await admin.from("workspace_invites").update(row).eq("id", existing.id)
    : await admin.from("workspace_invites").insert(row);

  if (error) throw new InvitationError("invalid", `inviteToWorkspace: ${error.message}`);

  await audit(granter, "invite", {
    email,
    verbs: input.verbs,
    reach: input.reach,
    expires_at: expiresAt,
    delivery_state: row.delivery_state,
  });

  return receipt(expiresAt, fromAgent);
}

export interface PendingDelivery {
  id: string;
  email: string;
  invitee_name: string | null;
  role: string;
  token: string;
  verbs: Verb[] | null;
  expires_at: string;
  delivery_state: string;
  invited_by_kind: string;
}

/**
 * Invitations an agent created and held, waiting for a person.
 *
 * Separate call, and deliberately so: this is the surface that names addresses,
 * and keeping it out of `inviteToWorkspace`'s reply is what lets that reply
 * stay uniform. It shows only what an agent held — a human's own invitations
 * never needed releasing.
 */
export async function listHeldInvitations(grant: Grant): Promise<PendingDelivery[]> {
  requireAdmin(grant);
  if (grant.principal.kind === "agent") {
    throw new InvitationError(
      "forbidden",
      "only a person can review invitations held for release",
    );
  }
  const workspace = await loadWorkspace(grant.workspaceId);
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("workspace_invites")
    .select(
      "id, email, invitee_name, role, token, verbs, expires_at, delivery_state, invited_by_kind",
    )
    .eq("organization_id", workspace.organization_id)
    .eq("delivery_state", "held")
    .is("accepted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new InvitationError("invalid", `listHeldInvitations: ${error.message}`);
  return (data ?? []) as PendingDelivery[];
}

/**
 * A person authorises the one irreversible act.
 *
 * Returns the token so the caller can send the mail; the release itself is what
 * is being audited, not the send, because the release is the decision.
 */
export async function releaseInvitation(
  releaser: Grant,
  inviteId: string,
): Promise<PendingDelivery> {
  requireAdmin(releaser);
  if (releaser.principal.kind !== "user") {
    throw new InvitationError(
      "forbidden",
      "an agent cannot release its own invitation; that is the whole point of holding it",
    );
  }
  const workspace = await loadWorkspace(releaser.workspaceId);
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("workspace_invites")
    .update({ delivery_state: "pending" })
    .eq("id", inviteId)
    .eq("organization_id", workspace.organization_id)
    .eq("delivery_state", "held")
    .is("accepted_at", null)
    .select(
      "id, email, invitee_name, role, token, verbs, expires_at, delivery_state, invited_by_kind",
    );
  if (error) throw new InvitationError("invalid", `releaseInvitation: ${error.message}`);
  if (!data || data.length === 0) {
    throw new InvitationError("not_found", "no held invitation with that id");
  }

  await audit(releaser, "invite_release", { invite_id: inviteId });
  return data[0] as PendingDelivery;
}

/* -------------------------------------------------------------------------- */
/*  Acceptance                                                                */
/* -------------------------------------------------------------------------- */

interface StoredInvitation {
  id: string;
  organization_id: string;
  organization_slug: string;
  workspace_id: string | null;
  email: string;
  role: string;
  verbs: Verb[] | null;
  reach: unknown;
  invited_by: string | null;
  invited_by_kind: string;
  invited_by_agent_id: string | null;
  expires_at: string;
}

async function loadInvitation(token: string): Promise<StoredInvitation | null> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("workspace_invites")
    .select(
      "id, organization_id, workspace_id, email, role, verbs, reach, invited_by, invited_by_kind, invited_by_agent_id, expires_at, accepted_at, organization:organizations(slug)",
    )
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  if (data.accepted_at) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
  const org = (data as { organization?: { slug: string } }).organization;
  return {
    id: data.id as string,
    organization_id: data.organization_id as string,
    organization_slug: org?.slug ?? "",
    workspace_id: (data.workspace_id as string | null) ?? null,
    email: data.email as string,
    role: data.role as string,
    verbs: (data.verbs as Verb[] | null) ?? null,
    reach: data.reach ?? null,
    invited_by: (data.invited_by as string | null) ?? null,
    invited_by_kind: (data.invited_by_kind as string) ?? "user",
    invited_by_agent_id: (data.invited_by_agent_id as string | null) ?? null,
    expires_at: data.expires_at as string,
  };
}

export type AcceptResult = { orgSlug: string } | { error: string };

/**
 * Accept an invitation that carries a permission.
 *
 * ## Why acceptance revalidates, and why it refuses rather than trims
 *
 * Days pass between writing an invitation and clicking it. In that time the
 * inviter can have been narrowed, had their `admin` verb taken away, or been
 * revoked outright — and an invitation is stored authority, so honouring it
 * blindly means a revoked admin still hands out access from beyond the grave.
 * So the promise is re-checked against what the inviter holds *now*, with the
 * same `canGrant` that was applied when it was written.
 *
 * When the promise no longer fits, this **fails**; it does not quietly shrink
 * the grant to what is still allowed. Three reasons:
 *
 *  1. A trimmed grant is one nobody chose. The inviter asked for more, the
 *     invitee was told they would get more, and the person who could explain
 *     the difference is not in the room. It reads as a bug to everyone who
 *     later looks at the access list, and the "bug" is silent.
 *  2. There is no honest thing to trim *to*. `canGrant` is deliberately
 *     conservative because comparing reaches is undecidable in general; the
 *     only intersection we could actually compute is over tag sets, and with
 *     `tags_all` semantics that intersection is not a subset of what either
 *     party meant. Computing it would be inventing a permission.
 *  3. Failing is loud, closed, and cheap to recover from: whoever still holds
 *     `admin` writes a fresh invitation in seconds, with their eyes open about
 *     what they are actually able to give. The invitation row is left pending
 *     rather than consumed, so restoring the inviter's access makes the same
 *     link work again.
 */
export async function acceptInvitation(
  token: string,
  user: { id: string; email: string | null },
): Promise<AcceptResult> {
  const invite = await loadInvitation(token);
  if (!invite) return { error: "Invitation is invalid or expired." };

  if (user.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return {
      error: `This invitation was sent to ${invite.email}. Sign in with that email to accept.`,
    };
  }

  // A role-only invitation (everything written before this module, and
  // everything the members screen still writes) keeps the old path exactly.
  if (!invite.verbs || invite.verbs.length === 0 || !invite.workspace_id) {
    const { acceptInvite } = await import("@/lib/workspaces/orgs");
    return acceptInvite(token, user);
  }

  const admin = getSupabaseAdmin();
  const workspaceId = invite.workspace_id;

  const inviter =
    invite.invited_by_kind === "agent" && invite.invited_by_agent_id
      ? ({ kind: "agent", id: invite.invited_by_agent_id } as const)
      : invite.invited_by
        ? ({ kind: "user", id: invite.invited_by } as const)
        : null;
  if (!inviter) {
    // The inviter's account is gone (`on delete set null`). Nobody is
    // accountable for this permission any more, so it is not honoured.
    return { error: "Whoever sent this invitation no longer has an account. Ask for a new one." };
  }

  if (inviter.kind === "user" && inviter.id === user.id) {
    // The self-grant door, closed on the way in as well as the way out.
    return { error: "An invitation cannot grant access to the person who sent it." };
  }

  const current = await resolveGrantForPrincipal(inviter, workspaceId);
  if (isDenied(current)) {
    return {
      error: "Whoever sent this invitation no longer has access to this workspace. Ask for a new one.",
    };
  }
  if (!current.verbs.includes("admin")) {
    return {
      error: "Whoever sent this invitation can no longer hand out access here. Ask for a new one.",
    };
  }

  const reach = parseStoredReach(invite.reach);
  if (!reach) {
    return { error: "This invitation's permissions can no longer be read. Ask for a new one." };
  }

  const allowed = canGrant(current, invite.verbs, reach);
  if (!allowed.ok) {
    return {
      error: `This invitation promises more than the person who sent it can still give (${allowed.reason}). Ask for a new one.`,
    };
  }

  // Organisation membership: needed to see the organisation at all, and it
  // carries no node access on its own.
  await admin
    .from("organization_memberships")
    .upsert(
      { user_id: user.id, organization_id: invite.organization_id, role: invite.role },
      { onConflict: "user_id,organization_id" },
    );

  // Project membership for the invited workspace ONLY. `acceptInvite` adds one
  // for every project in the organisation, which is right for a role invite and
  // wrong here: an invitation that names a workspace grants that workspace, not
  // whatever else the organisation happens to hold.
  await admin
    .from("memberships")
    .upsert(
      { user_id: user.id, workspace_id: workspaceId, role: invite.role },
      { onConflict: "user_id,workspace_id" },
    );

  const { error: grantError } = await admin.from("workspace_grants").upsert(
    {
      workspace_id: workspaceId,
      principal_kind: "user",
      principal_id: user.id,
      verbs: invite.verbs,
      reach,
      expires_at: null,
      granted_by: invite.invited_by,
      revoked_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,principal_kind,principal_id" },
  );
  if (grantError) {
    return { error: `Could not apply the invitation's permissions: ${grantError.message}` };
  }

  await admin
    .from("workspace_invites")
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", invite.id);

  try {
    await appendAudit({
      workspaceId,
      action: "access.invite_accepted",
      actorType: "user",
      actorId: user.id,
      input: {
        invite_id: invite.id,
        verbs: invite.verbs,
        reach,
        invited_by_kind: invite.invited_by_kind,
        invited_by: inviter.id,
      },
    });
  } catch (err) {
    log.error("invitation.audit_failed", {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { orgSlug: invite.organization_slug };
}

/**
 * Read back a stored reach, refusing anything that does not validate. Same
 * stance as `parseReach` in grants.ts — an unreadable reach denies, it never
 * widens — but here it can surface as an error instead of a silent empty
 * workspace, because there is a person waiting on the answer.
 */
function parseStoredReach(raw: unknown): Reach | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { type?: unknown; query?: unknown };
  if (value.type === "all") return { type: "all" };
  if (value.type !== "query") return null;
  const parsed = ViewQuerySchema.safeParse(value.query);
  if (!parsed.success) return null;
  return { type: "query", query: parsed.data };
}

/**
 * Every invitation, release and no-op goes to the audit log with the actor, the
 * same way granting does. The no-op is in there on purpose: "somebody walked a
 * list of addresses past the invite tool" is exactly the pattern the uniform
 * reply hides from the caller and must not hide from a reviewer.
 */
async function audit(
  granter: Grant,
  action: "invite" | "invite_noop" | "invite_release",
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAudit({
      workspaceId: granter.workspaceId,
      action: `access.${action}`,
      actorType: granter.principal.kind === "agent" ? "agent" : "user",
      actorId: granter.principal.id,
      input: details,
    });
  } catch (err) {
    log.error("invitation.audit_failed", {
      workspace_id: granter.workspaceId,
      action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

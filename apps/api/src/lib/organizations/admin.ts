/**
 * An organization as the people inside it administer it.
 *
 * `@/lib/admin/orgs` is the same subject seen from the other side: the platform
 * admin of the instance, gated on an email allowlist, looking at every
 * organization at once. This module is an organization's own owner or admin looking at theirs, and the gate is
 * the whole difference — everything below runs on the service-role client, so
 * `gateOrgAdmin` is the only thing standing between a caller and another
 * tenant's roster. The one seam between the two sides is `gateOrgAdmin`'s
 * `platformAdmin` option: the instance-admin allowlist opens the reading routes so
 * `/admin` can answer whether an organization is alive, and stops there.
 *
 * ## Nobody is created here
 *
 * There is one way into an organization and it is an invitation link. An
 * administrator could have been allowed to create a colleague's account with a
 * password of their choosing, but the person has to replace that password on
 * first sign-in anyway, so the path ends where the invitation already ends
 * having spent an extra step and put somebody else's password in the middle.
 *
 * ## Not existing is the answer to "may I?"
 *
 * A caller who does not administer the organization gets a 404, never a 403.
 * A 403 confirms the company is a customer, which is exactly the fact an
 * outsider is fishing for — the same reasoning `openWorkspace` applies to
 * workspaces, applied one level up.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { joinName } from "@bcontext-dev/contract/me";
import { namesFromUser } from "@/lib/auth/profile";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { inviteUrl } from "@/lib/app-url";
import { gate } from "@/lib/auth/require";
import { isAdminEmail } from "@/lib/admin/access";
import { syncGrantFromMembership } from "@/lib/auth/grant-sync";
import { log } from "@bcontext-dev/contract/log";
import {
  createInvite,
  revokeInvite,
  revokeWorkspaceAccess,
  removeMember,
  updateMemberRole,
  updateOrg as updateOrgRecord,
} from "@/lib/workspaces/orgs";
import { AdminOrgError, sendInviteEmail } from "@/lib/admin/orgs";
import type {
  OrgAdminDetail,
  OrgAdminInvite,
  OrgAdminMember,
  OrgAdminWorkspace,
  OrgMemberWorkspace,
} from "@bcontext-dev/contract/organizations";
import type { InviteRole, WorkspaceRole } from "@bcontext-dev/contract/workspaces";
import type { InviteEmailStatus } from "@bcontext-dev/contract/admin-orgs";

export class OrgAdminError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OrgAdminError";
  }
}

/** The two roles that administer a company. Editors and viewers are members. */
const ADMIN_ROLES = new Set<string>(["owner", "admin"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVITE_COLUMNS =
  "id, organization_id, email, role, token, expires_at, accepted_at, created_at, workspace_ids, delivery_state, delivery_at, delivery_error";

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: InviteRole;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  workspace_ids: string[] | null;
  delivery_state: string | null;
  delivery_at: string | null;
  delivery_error: string | null;
}

export interface OrgAdminContext {
  org: OrgRow;
  actor: { userId: string };
  role: "owner" | "admin";
  /**
   * True when the platform-admin allowlist, and not a membership row, is what
   * let this caller in. Anything that writes must refuse on it — see
   * `GateOrgAdminOptions.platformAdmin`.
   */
  via_platform_admin: boolean;
}

export interface GateOrgAdminOptions {
  /**
   * Let the platform-admin allowlist (`@/lib/admin/access`) through when the
   * caller administers nothing here.
   *
   * Only on routes that read. The operator's first question about a customer
   * is "is this alive?", and answering it from `/admin` needs the same figures
   * the customer's own administrators see. Handing out or revoking a
   * colleague's access is a different act, and it stays with the people whose
   * company it is: an override that arrives silently through the route their
   * admins use would change a roster with no one inside the company having
   * asked for it.
   */
  platformAdmin?: "read";
}

/* -------------------------------------------------------------------------- */
/*  The gate                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The person behind a session-cookied request, if they administer `org`.
 *
 * Goes through `gate` first so this surface keeps the same-origin guard and the
 * rate limit every other route has. Only a cookie session qualifies: a bearer
 * token, however scoped, belongs to an agent, and handing out or revoking a
 * colleague's access is not something an agent does on its own judgement.
 *
 * Every refusal that is not "you are not signed in" answers 404 with the same
 * body a missing organization gets — see the header.
 *
 * `options.platformAdmin` opens one more door, on reading routes only: the
 * instance-admin allowlist. It is the only way `/admin` can answer whether an
 * organization is alive, and it is logged wherever it is what granted access.
 */
export async function gateOrgAdmin(
  req: Request,
  orgSlugOrId: string | null | undefined,
  options: GateOrgAdminOptions = {},
): Promise<OrgAdminContext | Response> {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!orgSlugOrId) return notFound();

  const admin = getSupabaseAdmin();
  // A slug and an id address the same thing, and the UI holds whichever it was
  // given: the URL carries the slug, a freshly created org is only an id yet.
  const column = UUID.test(orgSlugOrId) ? "id" : "slug";
  const { data: org } = await admin
    .from("organizations")
    .select("id, slug, name, created_at")
    .eq(column, orgSlugOrId)
    .maybeSingle();
  if (!org) return notFound();

  const { data: membership } = await admin
    .from("organization_memberships")
    .select("role")
    .eq("organization_id", (org as OrgRow).id)
    .eq("user_id", gated.userId)
    .maybeSingle();
  const role = membership?.role as string | undefined;
  if (!role || !ADMIN_ROLES.has(role)) {
    if (options.platformAdmin !== "read") return notFound();
    // `gate` resolved the id; the allowlist is by email, which only the auth
    // server can vouch for — the same lookup `gateAdmin` makes.
    const { data } = await getSupabaseForRequest(req).auth.getUser();
    const email = data.user?.email ?? null;
    if (!isAdminEmail(email)) return notFound();
    // An operator reading a customer's data is worth a line: nothing inside
    // the company consented to this request, so the only record of it is here.
    log.info("org.admin.platform_override", {
      organization_id: (org as OrgRow).id,
      organization_slug: (org as OrgRow).slug,
      actor_id: gated.userId,
      actor_email: email,
    });
    return {
      org: org as OrgRow,
      actor: { userId: gated.userId },
      role: "admin",
      via_platform_admin: true,
    };
  }

  return {
    org: org as OrgRow,
    actor: { userId: gated.userId },
    role: role as "owner" | "admin",
    via_platform_admin: false,
  };
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything the administration modal opens with: who belongs to the company
 * and what each of them reaches, which workspaces exist and how big they are,
 * and which invitations are still outstanding with the link to hand over.
 */
export async function getOrgAdminDetail(
  orgId: string,
  callerId: string,
): Promise<OrgAdminDetail> {
  const admin = getSupabaseAdmin();
  const { data: org } = await admin
    .from("organizations")
    .select("id, slug, name, created_at")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) throw new OrgAdminError(404, "not_found");

  const [{ data: orgMembers }, { data: workspaces }, { data: invites }] = await Promise.all([
    admin
      .from("organization_memberships")
      .select("user_id, role, created_at")
      .eq("organization_id", orgId),
    admin
      .from("workspaces")
      .select("id, slug, name, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true }),
    admin
      .from("workspace_invites")
      .select(INVITE_COLUMNS)
      .eq("organization_id", orgId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  const wsRows = (workspaces ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    created_at: string;
  }>;
  const wsIds = wsRows.map((w) => w.id);

  const [{ data: memberships }, { data: grants }, { data: nodes }] =
    wsIds.length === 0
      ? [{ data: [] }, { data: [] }, { data: [] }]
      : await Promise.all([
          admin
            .from("memberships")
            .select("user_id, workspace_id, role")
            .in("workspace_id", wsIds),
          admin
            .from("workspace_grants")
            .select("workspace_id, principal_id, revoked_at, expires_at")
            .eq("principal_kind", "user")
            .in("workspace_id", wsIds),
          admin.from("nodes").select("workspace_id").in("workspace_id", wsIds),
        ]);

  const memberRows = (orgMembers ?? []) as Array<{
    user_id: string;
    role: InviteRole;
    created_at: string | null;
  }>;
  const users = await usersById(memberRows.map((m) => m.user_id));

  const membershipRole = new Map<string, WorkspaceRole>();
  for (const m of (memberships ?? []) as Array<{
    user_id: string;
    workspace_id: string;
    role: WorkspaceRole;
  }>) {
    membershipRole.set(`${m.workspace_id}:${m.user_id}`, m.role);
  }

  // A grant that exists but is revoked or expired denies, and must not fall
  // through to the membership row that is still sitting there — the same rule
  // `resolveGrant` enforces at request time. Showing access this list says is
  // there and the request path denies is worse than showing none.
  const denied = new Set<string>();
  for (const g of (grants ?? []) as Array<{
    workspace_id: string;
    principal_id: string;
    revoked_at: string | null;
    expires_at: string | null;
  }>) {
    const expired = g.expires_at !== null && new Date(g.expires_at) <= new Date();
    if (g.revoked_at !== null || expired) {
      denied.add(`${g.workspace_id}:${g.principal_id}`);
    }
  }

  const nodeCount = new Map<string, number>();
  for (const n of (nodes ?? []) as Array<{ workspace_id: string }>) {
    nodeCount.set(n.workspace_id, (nodeCount.get(n.workspace_id) ?? 0) + 1);
  }

  const reach = (userId: string, orgRole: InviteRole): OrgMemberWorkspace[] => {
    const out: OrgMemberWorkspace[] = [];
    for (const w of wsRows) {
      if (denied.has(`${w.id}:${userId}`)) continue;
      const own = membershipRole.get(`${w.id}:${userId}`);
      if (own) {
        out.push({ id: w.id, slug: w.slug, name: w.name, role: own, via_org_role: false });
        continue;
      }
      // Administering the company is a role in every workspace it holds,
      // including the ones created after this person joined. Saying so is the
      // point of `via_org_role`: the UI must not offer to take away access
      // that no per-workspace row grants in the first place.
      if (ADMIN_ROLES.has(orgRole)) {
        out.push({ id: w.id, slug: w.slug, name: w.name, role: orgRole, via_org_role: true });
      }
    }
    return out;
  };

  const members: OrgAdminMember[] = memberRows.map((m) => {
    const user = users.get(m.user_id);
    return {
      user_id: m.user_id,
      email: user?.email ?? null,
      name: user?.name ?? null,
      role: m.role,
      joined_at: m.created_at,
      last_sign_in_at: user?.last_sign_in_at ?? null,
      confirmed: user?.confirmed ?? false,
      is_you: m.user_id === callerId,
      workspaces: reach(m.user_id, m.role),
    };
  });

  const memberCount = (workspaceId: string): number => {
    // Everyone who can open it: the people with a membership row, plus the
    // administrators the org role lets in without one. Counting only the rows
    // would report `0` for a workspace its owner uses every day.
    const people = new Set<string>();
    for (const m of memberRows) {
      const key = `${workspaceId}:${m.user_id}`;
      if (denied.has(key)) continue;
      if (membershipRole.has(key) || ADMIN_ROLES.has(m.role)) people.add(m.user_id);
    }
    return people.size;
  };

  const workspaceList: OrgAdminWorkspace[] = wsRows.map((w) => ({
    id: w.id,
    slug: w.slug,
    name: w.name,
    created_at: w.created_at,
    node_count: nodeCount.get(w.id) ?? 0,
    member_count: memberCount(w.id),
  }));

  const orgRow = org as OrgRow;
  return {
    id: orgRow.id,
    slug: orgRow.slug,
    name: orgRow.name,
    created_at: orgRow.created_at,
    role: (memberRows.find((m) => m.user_id === callerId)?.role ?? "admin") as InviteRole,
    members,
    workspaces: workspaceList,
    invites: ((invites ?? []) as InviteRow[]).map(toOrgInvite),
  };
}

function toOrgInvite(row: InviteRow): OrgAdminInvite {
  const state = row.delivery_state;
  const emailStatus: InviteEmailStatus | null =
    state === "sent" ? "sent" : state === "failed" ? "error" : null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    url: inviteUrl(row.token),
    expires_at: row.expires_at,
    created_at: row.created_at,
    workspace_ids: row.workspace_ids ?? [],
    email_status: emailStatus,
    email_sent_at: row.delivery_at,
    email_error: row.delivery_error,
  };
}

interface AuthUser {
  email: string | null;
  /** Both halves of the profile name, joined; null when never given. */
  name: string | null;
  last_sign_in_at: string | null;
  confirmed: boolean;
}

/**
 * Emails and sign-in state for a set of user ids. The auth server pages its
 * user list and has no "give me these ids" call, so this walks it and stops as
 * soon as everyone asked for has been found — or at 1 000 people, which is far
 * past the size where one company's roster fits in a modal.
 */
async function usersById(userIds: string[]): Promise<Map<string, AuthUser>> {
  const wanted = new Set(userIds);
  const out = new Map<string, AuthUser>();
  if (wanted.size === 0) return out;
  const admin = getSupabaseAdmin();
  for (let page = 1; page <= 5; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const batch = data?.users ?? [];
    for (const u of batch) {
      if (!wanted.has(u.id)) continue;
      out.set(u.id, {
        email: u.email ?? null,
        name: joinName(namesFromUser(u)),
        last_sign_in_at: u.last_sign_in_at ?? null,
        // Somebody who was invited and never set a password has no
        // confirmation, which is what tells "waiting" apart from "using it".
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
      });
    }
    if (batch.length < 200 || out.size === wanted.size) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

/** Rename the company. The slug is an address and never moves — see `@/lib/slugs`. */
export async function updateOrg(orgId: string, patch: { name?: string }): Promise<void> {
  const name = patch.name?.trim();
  if (!name) throw new OrgAdminError(400, "invalid_name", "The organization needs a name.");
  await updateOrgRecord({ organizationId: orgId, name });
}

/**
 * Invite somebody in, and answer with the link. Nothing is emailed: sending is
 * the one irreversible act in this module and has its own route, asked for by
 * name (`sendOrgInviteEmail`).
 */
export async function createOrgInvite(
  orgId: string,
  input: { email: string; role?: InviteRole; workspaces?: string[] },
  invitedBy: string,
): Promise<OrgAdminInvite> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new OrgAdminError(400, "invalid_email", "Enter a valid email address.");
  }
  const role = input.role ?? "editor";
  const admin = getSupabaseAdmin();

  // Owners and admins reach every workspace the organization holds, so naming
  // workspaces for them would write rows that say nothing and then have to be
  // kept in step with every workspace created afterwards.
  const workspaceIds = ADMIN_ROLES.has(role)
    ? []
    : await workspacesInOrg(orgId, input.workspaces ?? []);

  const created = await createInvite({
    organizationId: orgId,
    email,
    role,
    invitedBy,
    workspaceIds,
  });

  log.info("org.invite.created", {
    organization_id: orgId,
    role,
    workspace_count: workspaceIds.length,
    email_domain: email.split("@")[1] ?? null,
  });

  const { data: row } = await admin
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .eq("id", created.id)
    .single();
  return toOrgInvite(row as InviteRow);
}

/** A pending invitation, withdrawn. The link dies with the row. */
export async function revokeOrgInvite(orgId: string, inviteId: string): Promise<void> {
  await revokeInvite(orgId, inviteId);
}

/**
 * Send the branded email for an invitation this organization issued.
 *
 * The scoping is the whole reason this exists rather than the instance admin's
 * `sendInviteEmail` being called directly: that one takes an invite id and asks
 * no questions, and an id from another company's organization would otherwise
 * be an email sent in that company's name.
 */
export async function sendOrgInviteEmail(
  orgId: string,
  inviteId: string,
): Promise<OrgAdminInvite> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("workspace_invites")
    .select("id, organization_id")
    .eq("id", inviteId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!data) throw new OrgAdminError(404, "not_found");

  try {
    await sendInviteEmail(inviteId);
  } catch (err) {
    if (err instanceof AdminOrgError) {
      throw new OrgAdminError(err.status, err.code, err.message);
    }
    throw err;
  }

  const { data: row } = await admin
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .eq("id", inviteId)
    .single();
  return toOrgInvite(row as InviteRow);
}

/**
 * Change what somebody already inside the company is and reaches.
 *
 * `workspaces` is the complete list of workspace ids this person should reach,
 * not an addition to it: the screen it backs shows every workspace with a
 * checkbox, so what comes back is a statement about all of them. Reconciling
 * against what is there is the only reading that lets a box be unticked.
 */
export async function updateOrgMember(
  orgId: string,
  userId: string,
  patch: { role?: InviteRole; workspaces?: string[] },
  callerId: string,
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: rows } = await admin
    .from("organization_memberships")
    .select("user_id, role")
    .eq("organization_id", orgId);
  const members = (rows ?? []) as Array<{ user_id: string; role: InviteRole }>;
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw new OrgAdminError(404, "not_found");

  const role = patch.role ?? target.role;

  if (patch.role && patch.role !== target.role) {
    assertNotLastOwner(members, target, "demote");
    if (userId === callerId && target.role === "owner") {
      // An owner who demotes themselves loses the ability to undo it in the
      // same click. If that is genuinely what they want, another owner does it.
      throw new OrgAdminError(
        409,
        "self_demotion",
        "You cannot change your own owner role — ask another owner to do it.",
      );
    }
    await updateMemberRole(orgId, userId, patch.role);
  }

  if (patch.workspaces === undefined) return;

  // An owner or admin is left alone here on purpose. Their reach comes from
  // the org role, and the per-workspace rows that would be written or deleted
  // to "reconcile" it are noise at best — at worst the deletion revokes a
  // grant, and a revoked grant denies before the org role is ever consulted,
  // locking an administrator out of a workspace they own.
  if (ADMIN_ROLES.has(role)) return;

  const wanted = new Set(await workspacesInOrg(orgId, patch.workspaces));
  const { data: current } = await admin
    .from("memberships")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .in("workspace_id", await workspaceIdsInOrg(orgId));
  const held = new Map(
    ((current ?? []) as Array<{ workspace_id: string; role: WorkspaceRole }>).map((m) => [
      m.workspace_id,
      m.role,
    ]),
  );

  const added = [...wanted].filter((id) => !held.has(id));
  const removed = [...held.keys()].filter((id) => !wanted.has(id));
  const kept = [...wanted].filter((id) => held.has(id) && held.get(id) !== role);

  if (added.length > 0) {
    await admin.from("memberships").upsert(
      added.map((workspaceId) => ({ user_id: userId, workspace_id: workspaceId, role })),
      { onConflict: "user_id,workspace_id" },
    );
    // Grants are authoritative, so the membership alone is not access, and
    // `reinstate` because this *is* the act of admitting them: a tombstone from
    // an earlier removal outliving it would leave somebody on the members list
    // of a workspace that denies them, with no error anywhere to explain it.
    await Promise.all(
      added.map((workspaceId) =>
        syncGrantFromMembership(workspaceId, userId, role, { reinstate: true }),
      ),
    );
  }

  if (kept.length > 0) {
    await admin
      .from("memberships")
      .update({ role })
      .eq("user_id", userId)
      .in("workspace_id", kept);
    // No `reinstate`: re-picking a role for somebody whose grant was revoked
    // deliberately must not quietly bring them back.
    await Promise.all(
      kept.map((workspaceId) => syncGrantFromMembership(workspaceId, userId, role)),
    );
  }

  if (removed.length > 0) {
    await revokeWorkspaceAccess(removed, userId);
  }
}

/** Remove somebody from the company, and from every workspace it holds. */
export async function removeOrgMember(
  orgId: string,
  userId: string,
  callerId: string,
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: rows } = await admin
    .from("organization_memberships")
    .select("user_id, role")
    .eq("organization_id", orgId);
  const members = (rows ?? []) as Array<{ user_id: string; role: InviteRole }>;
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw new OrgAdminError(404, "not_found");

  assertNotLastOwner(members, target, "remove");
  if (userId === callerId && target.role === "owner") {
    throw new OrgAdminError(
      409,
      "self_removal",
      "You cannot remove yourself as an owner — ask another owner to do it.",
    );
  }

  await removeMember(orgId, userId);
  log.info("org.member.removed", { organization_id: orgId, user_id: userId });
}

/**
 * An organization with no owner is one nobody can administer, and no route
 * here can put an owner back — the invitation that would is issued by an
 * administrator who no longer exists.
 */
function assertNotLastOwner(
  members: Array<{ user_id: string; role: InviteRole }>,
  target: { user_id: string; role: InviteRole },
  action: "demote" | "remove",
): void {
  if (target.role !== "owner") return;
  if (members.filter((m) => m.role === "owner").length > 1) return;
  throw new OrgAdminError(
    409,
    "last_owner",
    action === "demote"
      ? "This is the organization's only owner — make somebody else an owner first."
      : "This is the organization's only owner — hand the organization over first.",
  );
}

/** The ids in `wanted` that are workspaces of this organization, in order. */
async function workspacesInOrg(orgId: string, wanted: string[]): Promise<string[]> {
  if (wanted.length === 0) return [];
  const mine = new Set(await workspaceIdsInOrg(orgId));
  const outside = wanted.filter((id) => !mine.has(id));
  if (outside.length > 0) {
    // Naming a workspace from another company is not a typo to be swallowed:
    // silently dropping it would report success for access nobody was given.
    throw new OrgAdminError(
      400,
      "invalid_workspaces",
      "Some of those workspaces do not belong to this organization.",
    );
  }
  return wanted;
}

async function workspaceIdsInOrg(orgId: string): Promise<string[]> {
  const admin = getSupabaseAdmin();
  const { data } = await admin.from("workspaces").select("id").eq("organization_id", orgId);
  return ((data ?? []) as Array<{ id: string }>).map((w) => w.id);
}

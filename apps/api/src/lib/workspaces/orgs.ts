/**
 * Organization-level membership and invitations: roles, invites, removal.
 *
 * An organization holds several workspaces. Membership is recorded twice on
 * purpose: `organization_memberships` is the org-level role, and each
 * workspace still carries a `memberships` row because node RLS gates on it.
 * Access itself is decided by grants (`@/lib/auth/grants`), which these
 * helpers keep in sync — the membership row alone is not access. Everything
 * goes through the service-role client; callers are already authorised.
 */
import { syncGrantFromMembership } from "@/lib/auth/grant-sync";
import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { slugify } from "@bcontext-dev/contract/utils";
import { supabaseConfigured } from "@/lib/env";

export type OrgRole = "owner" | "admin" | "editor" | "viewer";

export interface OrgInvite {
  id: string;
  email: string;
  role: OrgRole;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  /** Workspaces the invitee joins on acceptance; null means org-only. */
  workspace_ids?: string[] | null;
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

export async function getOrgRoleForUser(
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> {
  if (!supabaseConfigured()) return null;
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("organization_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (data?.role) return data.role as OrgRole;

  // No org-level row: fall back to any workspace-level membership in the org.
  const { data: legacy } = await admin
    .from("memberships")
    .select("role, workspace:workspaces!inner(organization_id)")
    .eq("user_id", userId)
    .eq("workspace.organization_id", organizationId)
    .limit(1)
    .maybeSingle();
  return (legacy?.role as OrgRole | undefined) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Members                                                                   */
/* -------------------------------------------------------------------------- */

export async function updateMemberRole(
  organizationId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("organization_memberships")
    .update({ role })
    .eq("organization_id", organizationId)
    .eq("user_id", userId);
}

export async function removeMember(
  organizationId: string,
  userId: string,
): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("organization_memberships")
    .delete()
    .eq("organization_id", organizationId)
    .eq("user_id", userId);

  // Also strip the per-workspace memberships for this org so the user
  // truly loses access. (Workspace memberships still gate node RLS.)
  const { data: projects } = await admin
    .from("workspaces")
    .select("id")
    .eq("organization_id", organizationId);
  const ids = (projects ?? []).map((p: { id: string }) => p.id);
  // Removing someone from the organisation revokes their grant in every one
  // of its workspaces. Missing one would leave access alive in a workspace
  // nobody thinks they still belong to.
  await revokeWorkspaceAccess(ids, userId);
}

/**
 * Take a person's access to a set of workspaces away: the membership row and
 * the grant, together.
 *
 * The pair is the point. Grants are authoritative, so deleting the membership
 * alone leaves the access alive; revoking the grant alone leaves a row saying
 * they belong somewhere they cannot open. Anything that narrows somebody's
 * reach — leaving the organisation, or a checkbox unticked on the members
 * screen — goes through here so the two can never drift apart.
 */
export async function revokeWorkspaceAccess(
  workspaceIds: string[],
  userId: string,
): Promise<void> {
  if (workspaceIds.length === 0) return;
  const admin = getSupabaseAdmin();
  await admin
    .from("memberships")
    .delete()
    .eq("user_id", userId)
    .in("workspace_id", workspaceIds);
  await Promise.all(
    workspaceIds.map((id) => syncGrantFromMembership(id, userId, null)),
  );
}

/* -------------------------------------------------------------------------- */
/*  Invitations                                                               */
/* -------------------------------------------------------------------------- */

export async function listInvites(
  organizationId: string,
): Promise<OrgInvite[]> {
  if (!supabaseConfigured()) return [];
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("workspace_invites")
    .select("id, email, role, token, expires_at, accepted_at, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  return (data ?? []) as OrgInvite[];
}

export async function createInvite(input: {
  organizationId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  /**
   * Which workspaces the person joins on acceptance. Empty is right for an
   * owner or admin — their role reaches every workspace in the organization,
   * so per-workspace rows would only be noise to keep in sync.
   */
  workspaceIds?: string[];
}): Promise<OrgInvite> {
  const admin = getSupabaseAdmin();
  const email = input.email.trim().toLowerCase();
  const token = newToken();

  // If a pending invite for the same email already exists, refresh it
  // rather than stacking duplicates.
  const { data: existing } = await admin
    .from("workspace_invites")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("email", email)
    .is("accepted_at", null)
    .maybeSingle();

  if (existing?.id) {
    const { data: updated } = await admin
      .from("workspace_invites")
      .update({
        role: input.role,
        token,
        invited_by: input.invitedBy,
        workspace_ids: input.workspaceIds ?? null,
        expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      })
      .eq("id", existing.id)
      .select("id, email, role, token, expires_at, accepted_at, created_at")
      .single();
    return updated as OrgInvite;
  }

  const { data, error } = await admin
    .from("workspace_invites")
    .insert({
      organization_id: input.organizationId,
      email,
      role: input.role,
      token,
      invited_by: input.invitedBy,
      workspace_ids: input.workspaceIds ?? null,
    })
    .select("id, email, role, token, expires_at, accepted_at, created_at")
    .single();
  if (error || !data) {
    throw new Error(`createInvite: ${error?.message ?? "no row"}`);
  }
  return data as OrgInvite;
}

export async function revokeInvite(
  organizationId: string,
  inviteId: string,
): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("workspace_invites")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", inviteId);
}

/**
 * Look up an invite by its public token. Returns null for missing,
 * expired, or already-accepted invites so the caller doesn't need to
 * branch on each case.
 */
export async function findInviteByToken(token: string): Promise<
  | (OrgInvite & {
      workspace_ids: string[] | null;
      organization_id: string;
      organization_slug: string;
      organization_name: string;
    })
  | null
> {
  if (!supabaseConfigured()) return null;
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("workspace_invites")
    .select(
      "id, email, role, token, expires_at, accepted_at, created_at, workspace_ids, organization_id, organization:organizations(slug, name)",
    )
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  if (data.accepted_at) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
  const org = (data as { organization?: { slug: string; name: string } })
    .organization;
  return {
    id: data.id as string,
    email: data.email as string,
    role: data.role as OrgRole,
    token: data.token as string,
    expires_at: data.expires_at as string,
    accepted_at: null,
    created_at: data.created_at as string,
    workspace_ids: (data.workspace_ids as string[] | null) ?? null,
    organization_id: data.organization_id as string,
    organization_slug: org?.slug ?? "",
    organization_name: org?.name ?? "",
  };
}

/**
 * Accept an invite for the signed-in user. Adds the user to the
 * org-level membership AND to every existing workspace membership inside
 * that org (node RLS still gates on `memberships`).
 */
export async function acceptInvite(token: string, user: {
  id: string;
  email: string | null;
}): Promise<{ orgSlug: string } | { error: string }> {
  const invite = await findInviteByToken(token);
  if (!invite) return { error: "Invitation is invalid or expired." };

  if (user.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return {
      error: `This invitation was sent to ${invite.email}. Sign in with that email to accept.`,
    };
  }

  const admin = getSupabaseAdmin();

  // Org-level membership.
  await admin
    .from("organization_memberships")
    .upsert(
      {
        user_id: user.id,
        organization_id: invite.organization_id,
        role: invite.role,
      },
      { onConflict: "user_id,organization_id" },
    );

  // Project-level membership for the workspaces the invitation named — not
  // for every workspace in the organization. Inviting somebody to a company
  // is not the same as handing them every project inside it, and the whole
  // point of asking "which workspaces?" at invite time is that this list can
  // be shorter than "all of them".
  //
  // An owner or admin gets no rows here at all: their role in the
  // organization already reaches every workspace it holds, including the ones
  // created after they joined, which a snapshot of rows never would.
  const wanted = invite.workspace_ids ?? [];
  const isOrgAdmin = invite.role === "owner" || invite.role === "admin";
  const { data: projects } = isOrgAdmin || wanted.length === 0
    ? { data: [] as Array<{ id: string }> }
    : await admin
        .from("workspaces")
        .select("id")
        .eq("organization_id", invite.organization_id)
        .in("id", wanted);

  if (projects && projects.length > 0) {
    const rows = projects.map((p: { id: string }) => ({
      user_id: user.id,
      workspace_id: p.id,
      role: invite.role,
    }));
    await admin
      .from("memberships")
      .upsert(rows, { onConflict: "user_id,workspace_id" });

    // Grants are authoritative, so the membership alone is no longer access.
    // `reinstate` because this is a readmission: someone who was removed before
    // — leaving a revoked grant behind — has just been invited back, and a
    // tombstone outliving that invitation locks them out of a workspace they
    // appear on the members list of, with no error anywhere to explain it.
    await Promise.all(
      projects.map((p: { id: string }) =>
        syncGrantFromMembership(p.id, user.id, invite.role, { reinstate: true }),
      ),
    );
  }

  await admin
    .from("workspace_invites")
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", invite.id);

  return { orgSlug: invite.organization_slug };
}

/* -------------------------------------------------------------------------- */
/*  Workspace (org) settings                                                  */
/* -------------------------------------------------------------------------- */

export async function updateOrg(input: {
  organizationId: string;
  name?: string;
  slug?: string;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string" && input.name.trim()) {
    patch.name = input.name.trim();
  }
  if (typeof input.slug === "string" && input.slug.trim()) {
    patch.slug = slugify(input.slug);
  }
  if (Object.keys(patch).length === 0) return;
  await admin.from("organizations").update(patch).eq("id", input.organizationId);
}

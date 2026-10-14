/**
 * Organizations, their people and their invitations, as the platform admin
 * works them.
 *
 * Besides self-service creation (`@/lib/organizations/create`), an instance
 * admin can create an organization here and get back a link for the person
 * who will own it. Nothing leaves the building on its own — the link is
 * copied and sent personally, or the admin asks for the email in a second,
 * explicit act (`sendInviteEmail`). That asymmetry is the same one
 * `@/lib/auth/invitations` documents: an email is the only action here that
 * cannot be undone.
 *
 * Everything runs on the service-role client, so every caller must have gone
 * through `gateAdmin` first.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { inviteUrl } from "@/lib/app-url";
import { log } from "@bcontext-dev/contract/log";
import { createInvite, revokeInvite } from "@/lib/workspaces/orgs";
import { sendWorkspaceInviteEmail } from "@/lib/workspaces/invite-email";
import { currentPeriod } from "@/lib/organizations/meters";
import { insertOrganization } from "@/lib/organizations/create";
import { countNodes, periodStart, WRITE_VERBS } from "@/lib/organizations/usage";
import { lastUsedByAgent } from "@/lib/organizations/agents";
import {
  ADMIN_ORG_STATES,
  adminOrgState,
  matchesAdminOrgState,
} from "@bcontext-dev/contract/admin-orgs";
import { pageBounds, searchTerm } from "@/lib/admin/list-params";
import { fetchOrgAiSpend, NO_AI_SPEND, type AdminOrgAiSpend } from "@/lib/admin/ai-spend";
import type {
  AdminInvite,
  AdminOrgBase,
  AdminOrgDetail,
  AdminOrgHealth,
  AdminOrgHealthList,
  AdminOrgListQuery,
  AdminOrgSummary,
  AdminOrgWorkspace,
  AdminPage,
  AdminUserAgent,
  AdminUserDetail,
  AdminUserListQuery,
  AdminUserPage,
  AdminUserRow,
  AdminUserState,
  AdminUserWorkspace,
  InviteEmailStatus,
} from "@bcontext-dev/contract/admin-orgs";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";

/**
 * The list row and the detail, each with what the organization's AI calls
 * cost (`src/lib/admin/ai-spend.ts`). The figures ride on the admin reads
 * rather than the contract because they are the operator's check that the
 * accounting works, read on one screen; `null` means the ledger could not
 * be read, which the panel prints as "unavailable" and never as $0.
 */
export type AdminOrgSummaryWithSpend = AdminOrgSummary & { ai_spend: AdminOrgAiSpend | null };
export type AdminOrgDetailWithSpend = AdminOrgDetail & { ai_spend: AdminOrgAiSpend | null };

export class AdminOrgError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AdminOrgError";
  }
}

const INVITE_COLUMNS =
  "id, organization_id, email, role, token, expires_at, accepted_at, created_at, delivery_state, delivery_at, delivery_error";

interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: InviteRole;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  delivery_state: string | null;
  delivery_at: string | null;
  delivery_error: string | null;
}

function toAdminInvite(row: InviteRow): AdminInvite {
  const state = row.delivery_state;
  const emailStatus: InviteEmailStatus | null =
    state === "sent" ? "sent" : state === "failed" ? "error" : null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    accepted_at: row.accepted_at,
    // Computed rather than left as two dates to compare, because an expiry
    // the reader has to work out is an expiry nobody checks.
    expired: !row.accepted_at && new Date(row.expires_at).getTime() < Date.now(),
    url: inviteUrl(row.token),
    expires_at: row.expires_at,
    created_at: row.created_at,
    email_status: emailStatus,
    email_sent_at: row.delivery_at,
    email_error: row.delivery_error,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A page of organizations, worst first.
 *
 * THE SHAPE OF THE READ, and why `limit`/`offset` do not simply ride on one
 * query: the list is ordered by `state`, which is derived from counters
 * spread across six tables and the auth server. An ORDER BY Postgres cannot
 * express is an ORDER BY that has to happen after the fold, and a fold over
 * one page would rank page two among itself. So the sweep runs over every
 * organization the filters left — `q` reaches the query, and the
 * aggregates are read set-wide, exactly as the health list reads them.
 *
 * What `limit` and `offset` do reach is the expensive half. The invitation
 * rows, links and all, are fetched for the page's organizations and nobody
 * else's: that read grows with the width of the row, and it is the one that
 * would hurt first.
 *
 * `total` is the organizations matching the filters — what the sweep
 * counted, never the length of the page.
 *
 * Personal zones are left out throughout: they are one person's private
 * space, never something an admin onboards or invites into.
 */
export async function listAdminOrgs(
  params: AdminOrgListQuery = {},
): Promise<AdminPage<AdminOrgSummaryWithSpend>> {
  const { limit, offset } = pageBounds(params);
  const rows = await sweepOrgHealth({ q: params.q });
  const state = params.state;
  const matched = state
    ? rows.filter((row) => matchesAdminOrgState(row.state, state))
    : rows;
  matched.sort(worstFirst);

  const page = matched.slice(offset, offset + limit);
  const pageIds = page.map((row) => row.id);
  // Both per-organization reads are cut to the page: the invitations because
  // they are whole rows, the spend because it is a sum over the ledger.
  const [invites, spend] = await Promise.all([
    pendingInvitesByOrg(pageIds),
    fetchOrgAiSpend(pageIds),
  ]);
  return {
    items: page.map((row) => ({
      ...toSummary(row, invites.get(row.id) ?? []),
      ai_spend: spend.available ? (spend.byOrg.get(row.id) ?? NO_AI_SPEND) : null,
    })),
    total: matched.length,
    limit,
    offset,
  };
}

/**
 * The ladder first, then age. Two customers stuck on the same rung are read
 * oldest-problem-first: a company that has sat unopened since March is a
 * worse fact than one that has sat unopened since Tuesday.
 */
function worstFirst(a: OrgHealthRow, b: OrgHealthRow): number {
  const rank =
    ADMIN_ORG_STATES.indexOf(a.state) - ADMIN_ORG_STATES.indexOf(b.state);
  return rank !== 0 ? rank : a.created_at < b.created_at ? -1 : 1;
}

function toSummary(row: OrgHealthRow, pendingInvites: AdminInvite[]): AdminOrgSummary {
  const { owner_emails, owner_email: _owner, ...health } = row;
  return { ...health, owner_emails, pending_invites: pendingInvites };
}

/**
 * The open invitations of the organizations on this page, whole rows.
 *
 * The link *is* the act — an operator who has just created an organization
 * copies it from the row — so it travels with the list rather than behind a
 * detail request per customer. It is also the only part of the row whose
 * cost is per-organization, which is why it is the part that gets the page's
 * ids and not the whole set.
 */
async function pendingInvitesByOrg(
  orgIds: string[],
): Promise<Map<string, AdminInvite[]>> {
  const out = new Map<string, AdminInvite[]>();
  if (orgIds.length === 0) return out;
  const { data } = await getSupabaseAdmin()
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .in("organization_id", orgIds)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });
  for (const row of (data ?? []) as InviteRow[]) {
    const list = out.get(row.organization_id) ?? [];
    list.push(toAdminInvite(row));
    out.set(row.organization_id, list);
  }
  return out;
}

export async function getAdminOrgDetail(id: string): Promise<AdminOrgDetailWithSpend> {
  const admin = getSupabaseAdmin();
  const { data: org } = await admin
    .from("organizations")
    .select("id, slug, name, created_at")
    .eq("id", id)
    .maybeSingle();
  if (!org) throw new AdminOrgError(404, "not_found");

  const [{ data: memberships }, { data: invites }, { data: workspaces }] = await Promise.all([
    admin
      .from("organization_memberships")
      .select("user_id, role, created_at")
      .eq("organization_id", id),
    // Accepted invitations stay in the list: an invitation that disappears
    // the moment it is used leaves no record of what was sent to whom, which
    // is the only account of how this organization came to exist.
    admin
      .from("workspace_invites")
      .select(INVITE_COLUMNS)
      .eq("organization_id", id)
      .order("created_at", { ascending: false }),
    admin
      .from("workspaces")
      .select("id, slug, name, created_at")
      .eq("organization_id", id)
      .order("slug", { ascending: true }),
  ]);

  const rows = (memberships ?? []) as Array<{
    user_id: string;
    role: InviteRole;
    created_at: string | null;
  }>;
  const wsRows = (workspaces ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    created_at: string;
  }>;
  const wsIds = wsRows.map((w) => w.id);

  const [people, nodeCounts, wsMembers, lastActivity, spend] = await Promise.all([
    usersForIds(rows.map((m) => m.user_id)),
    countNodes(wsIds),
    countWorkspaceMembers(wsIds),
    lastActivityByWorkspace(wsIds),
    fetchOrgAiSpend([id]),
  ]);

  const allInvites = ((invites ?? []) as InviteRow[]).map(toAdminInvite);
  // Open means unaccepted, expired included: an invitation nobody took and
  // that has now run out is still an open thread with a person, and it is the
  // one the operator most needs to see. Same rule as the list read.
  const pendingInvites = allInvites.filter((i) => !i.accepted_at);

  return {
    id: org.id as string,
    slug: org.slug as string,
    name: org.name as string,
    created_at: org.created_at as string,
    member_count: rows.length,
    // The summary's count is of what is still open, everywhere it appears.
    pending_invite_count: pendingInvites.length,
    workspace_count: wsRows.length,
    owner_emails: rows
      .filter((m) => m.role === "owner")
      .map((m) => people.get(m.user_id)?.email ?? null)
      .filter((e): e is string => Boolean(e)),
    members: rows.map((m) => ({
      user_id: m.user_id,
      email: people.get(m.user_id)?.email ?? null,
      role: m.role,
      joined_at: m.created_at,
      confirmed: people.get(m.user_id)?.confirmed ?? false,
      last_sign_in_at: people.get(m.user_id)?.last_sign_in_at ?? null,
    })),
    pending_invites: pendingInvites,
    invites: allInvites,
    workspaces: wsRows.map((w): AdminOrgWorkspace => ({
      id: w.id,
      slug: w.slug,
      name: w.name,
      created_at: w.created_at,
      node_count: nodeCounts.get(w.id) ?? 0,
      member_count: wsMembers.get(w.id) ?? 0,
      last_activity_at: lastActivity.get(w.id) ?? null,
    })),
    ai_spend: spend.available ? (spend.byOrg.get(id) ?? NO_AI_SPEND) : null,
  };
}

/**
 * The furthest this list can see. The auth server hands its accounts out in
 * pages of 200 and offers neither a search nor a join, so the walk is the
 * query and the cap is where it stops.
 */
const AUTH_PAGE = 200;
const AUTH_SCAN_CAP = 1000;

/**
 * A page of people, and how far the answer reached.
 *
 * THE OBSTACLE, because it decides everything below: accounts live in the
 * auth server, not in a table this can join or filter. `listUsers` pages and
 * does nothing else — no `where`, no count. So "search the whole platform"
 * and "page through it" cannot both come out of one walk of it, and there
 * were two honest answers:
 *
 *   drive the list from `organization_memberships`, which Postgres can
 *   filter and count, and enrich from the walk;
 *
 *   walk the accounts, filter them in memory, and say where the walk
 *   stopped.
 *
 * The second, because the first would answer a different question. The
 * people this screen exists to find are the ones onboarding lost: invited,
 * never signed in, and — often — in no organization at all, because the
 * membership is written when the invitation is *accepted*. A list built on
 * memberships cannot show a person who has no membership, which is precisely
 * the person being looked for.
 *
 * So: one walk, bounded at `AUTH_SCAN_CAP`; the filters applied to what it
 * saw; `total` counting the matches among those accounts, with `scanned`,
 * `cap` and `capped` saying so out loud. Past the cap the answer is a
 * smaller question than the one asked, and the payload admits it rather than
 * letting the panel report a confident wrong number.
 */
export async function listAdminUsers(
  params: AdminUserListQuery = {},
): Promise<AdminUserPage> {
  const { limit, offset } = pageBounds(params);
  const admin = getSupabaseAdmin();
  const users: AdminUserRow[] = [];
  for (let page = 1; page * AUTH_PAGE <= AUTH_SCAN_CAP; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: AUTH_PAGE,
    });
    if (error) throw new Error(`listAdminUsers: ${error.message}`);
    const batch = data?.users ?? [];
    for (const u of batch) {
      users.push({
        id: u.id,
        email: u.email ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        // An invited person who never set a password has no confirmation.
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
        orgs: [],
      });
    }
    if (batch.length < AUTH_PAGE) break;
  }

  const [{ data: memberships }, { data: orgs }] = await Promise.all([
    admin.from("organization_memberships").select("user_id, organization_id, role"),
    admin.from("organizations").select("id, slug, name"),
  ]);
  const orgById = new Map(
    ((orgs ?? []) as Array<{ id: string; slug: string; name: string }>).map((o) => [o.id, o]),
  );
  const byUser = new Map<string, AdminUserRow["orgs"]>();
  for (const m of (memberships ?? []) as Array<{
    user_id: string;
    organization_id: string;
    role: InviteRole;
  }>) {
    const org = orgById.get(m.organization_id);
    if (!org) continue;
    const list = byUser.get(m.user_id) ?? [];
    list.push({ id: org.id, slug: org.slug, name: org.name, role: m.role });
    byUser.set(m.user_id, list);
  }
  for (const u of users) u.orgs = byUser.get(u.id) ?? [];

  const needle = params.q?.trim().toLowerCase();
  const matched = users.filter((u) => {
    if (needle && !(u.email ?? "").toLowerCase().includes(needle)) return false;
    if (params.organization && !u.orgs.some((o) => o.id === params.organization)) {
      return false;
    }
    if (params.role && !u.orgs.some((o) => o.role === params.role)) return false;
    if (params.state && userState(u) !== params.state) return false;
    return true;
  });
  matched.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return {
    items: matched.slice(offset, offset + limit),
    total: matched.length,
    limit,
    offset,
    scanned: users.length,
    cap: AUTH_SCAN_CAP,
    capped: users.length >= AUTH_SCAN_CAP,
  };
}

/**
 * How far this person got. `invited` is somebody with a row and no password:
 * the invitation worked and they never arrived — the commonest way hand-made
 * onboarding fails quietly, and the reason the state exists at all.
 */
function userState(user: AdminUserRow): AdminUserState {
  if (!user.confirmed) return "invited";
  return user.last_sign_in_at ? "active" : "never-signed-in";
}

/**
 * The auth server's view of a set of people. `listUsers` is paged, so this is
 * one walk of the list rather than a lookup per id, and it stops as soon as
 * everyone asked for has been found.
 */
interface AuthUser {
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  confirmed: boolean;
}

async function usersForIds(userIds: string[]): Promise<Map<string, AuthUser>> {
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
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        // An invited person who never set a password has no confirmation.
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
      });
    }
    if (batch.length < 200 || out.size === wanted.size) break;
  }
  return out;
}

async function emailsForUsers(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [id, user] of await usersForIds(userIds)) {
    if (user.email) out.set(id, user.email);
  }
  return out;
}

/**
 * The four roles a person can hold. `memberships.role` still admits the
 * legacy `agent` value its check constraint was written with, which nothing
 * writes any more and which is not a role a human holds; anything the panel
 * does not recognise reads as the least access rather than as more.
 */
const PERSON_ROLES: readonly InviteRole[] = ["owner", "admin", "editor", "viewer"];

function personRole(role: string): InviteRole {
  return PERSON_ROLES.includes(role as InviteRole) ? (role as InviteRole) : "viewer";
}

/**
 * One person, everything the platform knows about them.
 *
 * THE SHAPE OF THE READ: a fixed handful of queries, none of them per-row.
 * One walk of the paged auth list to find the account, then their org
 * memberships, their workspace memberships, their agents and their last write,
 * in parallel; then the workspaces they reach and the organizations naming
 * them; then the agents' access rows and the three token tables. What grows is
 * the *width* of those `in (…)` lists — with the number of workspaces the
 * person reaches and the number of agents they own — never the number of
 * requests.
 *
 * Reach is not the membership table. Owning or administering an organization
 * is a role in every workspace it holds, including ones this person never
 * joined, so those workspaces are here too, marked `via_org_role` — the same
 * rule `resolveGrant` applies at request time. A panel that listed only the
 * membership rows would show less access than the product actually grants,
 * which is the wrong direction for a screen used to answer "what can they
 * see".
 */
export async function getAdminUserDetail(id: string): Promise<AdminUserDetail> {
  const admin = getSupabaseAdmin();
  const person = (await usersForIds([id])).get(id);
  if (!person) throw new AdminOrgError(404, "not_found");

  const [{ data: orgMemberRows }, { data: wsMemberRows }, { data: agentRows }, lastActivityAt] =
    await Promise.all([
      admin.from("organization_memberships").select("organization_id, role").eq("user_id", id),
      admin.from("memberships").select("workspace_id, role").eq("user_id", id),
      admin
        .from("agents")
        .select("id, name, provider, created_at, last_seen_at")
        .eq("owner_user_id", id),
      lastActivityByActor(id),
    ]);

  const orgRole = new Map<string, InviteRole>(
    ((orgMemberRows ?? []) as Array<{ organization_id: string; role: InviteRole }>).map((m) => [
      m.organization_id,
      m.role,
    ]),
  );
  const wsRole = new Map<string, InviteRole>(
    ((wsMemberRows ?? []) as Array<{ workspace_id: string; role: string }>).map((m) => [
      m.workspace_id,
      personRole(m.role),
    ]),
  );
  // Editor and viewer at organization level reach nothing on their own: those
  // people are let into workspaces one at a time, on purpose.
  const administeredOrgIds = [...orgRole.entries()]
    .filter(([, role]) => role === "owner" || role === "admin")
    .map(([orgId]) => orgId);

  const workspaces = await workspacesReachedBy([...wsRole.keys()], administeredOrgIds);
  const orgIds = [
    ...new Set([...orgRole.keys(), ...workspaces.map((w) => w.organization_id)]),
  ];
  const { data: orgRows } = orgIds.length
    ? await admin.from("organizations").select("id, slug, name").in("id", orgIds)
    : { data: [] };
  const orgById = new Map(
    ((orgRows ?? []) as Array<{ id: string; slug: string; name: string }>).map((o) => [o.id, o]),
  );

  return {
    id,
    email: person.email,
    created_at: person.created_at,
    last_sign_in_at: person.last_sign_in_at,
    confirmed: person.confirmed,
    orgs: [...orgRole.entries()].flatMap(([orgId, role]) => {
      const org = orgById.get(orgId);
      return org ? [{ id: org.id, slug: org.slug, name: org.name, role }] : [];
    }),
    workspaces: workspaces
      .map((w): AdminUserWorkspace => {
        const own = wsRole.get(w.id);
        return {
          id: w.id,
          slug: w.slug,
          name: w.name,
          organization_id: w.organization_id,
          organization_slug: orgById.get(w.organization_id)?.slug ?? "",
          role: own ?? orgRole.get(w.organization_id) ?? "viewer",
          via_org_role: own === undefined,
        };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    agents: await agentsOwnedBy((agentRows ?? []) as OwnedAgentRow[]),
    last_activity_at: lastActivityAt,
  };
}

interface ReachedWorkspace {
  id: string;
  slug: string;
  name: string;
  organization_id: string;
}

/**
 * Every workspace the person can work in: the ones they joined and the ones
 * held by an organization they administer. Two reads rather than one `or`,
 * because the two halves are different questions of different tables' indexes;
 * the union is taken by id, so somebody who both administers the organization
 * and holds a membership appears once.
 */
async function workspacesReachedBy(
  memberWorkspaceIds: string[],
  administeredOrgIds: string[],
): Promise<ReachedWorkspace[]> {
  const admin = getSupabaseAdmin();
  const columns = "id, slug, name, organization_id";
  const [{ data: joined }, { data: viaOrg }] = await Promise.all([
    memberWorkspaceIds.length
      ? admin.from("workspaces").select(columns).in("id", memberWorkspaceIds)
      : Promise.resolve({ data: [] }),
    administeredOrgIds.length
      ? admin.from("workspaces").select(columns).in("organization_id", administeredOrgIds)
      : Promise.resolve({ data: [] }),
  ]);
  const byId = new Map<string, ReachedWorkspace>();
  for (const row of [...(joined ?? []), ...(viaOrg ?? [])] as ReachedWorkspace[]) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

interface OwnedAgentRow {
  id: string;
  name: string;
  provider: string | null;
  created_at: string;
  last_seen_at: string | null;
}

/**
 * The agents this person connected. `last_used_at` is resolved exactly as the
 * organization's agent tab resolves it — across `agents.last_seen_at` and the
 * three token tables — because an agent that has only ever connected over
 * OAuth has a null `last_seen_at` and a live token stamp, and either column
 * alone reports a live agent as unused. Null is a real state, an agent
 * approved and never taken up, so such an agent stays in the list saying so.
 */
async function agentsOwnedBy(rows: OwnedAgentRow[]): Promise<AdminUserAgent[]> {
  if (rows.length === 0) return [];
  const agentIds = rows.map((a) => a.id);
  const [lastUsed, { data: access }] = await Promise.all([
    lastUsedByAgent(agentIds),
    getSupabaseAdmin()
      .from("agent_workspace_access")
      .select("agent_id")
      .in("agent_id", agentIds)
      .is("revoked_at", null),
  ]);
  const reach = new Map<string, number>();
  for (const row of (access ?? []) as Array<{ agent_id: string }>) {
    reach.set(row.agent_id, (reach.get(row.agent_id) ?? 0) + 1);
  }
  return rows
    .map((agent): AdminUserAgent => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      created_at: agent.created_at,
      last_used_at: newest(agent.last_seen_at, lastUsed.get(agent.id) ?? null),
      workspace_count: reach.get(agent.id) ?? 0,
    }))
    // Most recently active first; one that has never been used sorts last,
    // which is exactly the one an operator wants to notice.
    .sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""));
}

/**
 * When this person last wrote anything, anywhere. Signing in is not being
 * around: an account that logs in and reads is a different fact from one that
 * still writes, and only the second says the product is in use.
 *
 * One seek across `activity` by actor, which is a workspace-first index this
 * query cannot use — bounded by `limit 1` and by the retention `activity`
 * already enforces.
 */
async function lastActivityByActor(userId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("activity")
    .select("created_at")
    .eq("actor_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as Array<{ created_at: string | null }>)[0]?.created_at ?? null;
}

/** How many people are in each workspace of a set. */
async function countWorkspaceMembers(
  workspaceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const { data } = await getSupabaseAdmin()
    .from("memberships")
    .select("workspace_id")
    .in("workspace_id", workspaceIds);
  for (const row of (data ?? []) as Array<{ workspace_id: string }>) {
    out.set(row.workspace_id, (out.get(row.workspace_id) ?? 0) + 1);
  }
  return out;
}

/**
 * When each workspace was last written to. One seek per workspace on
 * `activity(workspace_id, created_at desc)`, which is the index that exists:
 * the newest row per workspace in a single statement is a lateral join
 * PostgREST cannot ask for, and reading the rows instead would page through a
 * month of writes to keep one timestamp from each.
 */
async function lastActivityByWorkspace(
  workspaceIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (workspaceIds.length === 0) return out;
  const admin = getSupabaseAdmin();
  await Promise.all(
    workspaceIds.map(async (id) => {
      const { data } = await admin
        .from("activity")
        .select("created_at")
        .eq("workspace_id", id)
        .order("created_at", { ascending: false })
        .limit(1);
      const at = ((data ?? []) as Array<{ created_at: string | null }>)[0]?.created_at;
      if (at) out.set(id, at);
    }),
  );
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Health                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `activity` for the current month, in pages. Same bound and the same reason
 * as the usage tab's: past this many writes an organization has outgrown
 * row-level aggregation, and the health list is a triage screen, not a ledger.
 */
const HEALTH_ACTIVITY_PAGE = 1000;
const HEALTH_ACTIVITY_MAX_PAGES = 20;

/**
 * How many organizations the sweep will ever rank. The list's `total` counts
 * what it swept, so this is also the horizon of the count — past five
 * hundred customers the ranking is a query Postgres should be doing, and
 * this panel is no longer the right tool.
 */
const ORG_SWEEP_MAX = 500;

/**
 * Every organization, ranked, for the Overview's alarm band.
 *
 * Deliberately NOT paginated, and that is the difference from the list. This
 * answers "is anything wrong anywhere" — a band that counted the first fifty
 * customers would go quiet exactly as the platform grew. `GET
 * /api/admin/organizations` answers "show me this page, worst first", and
 * carries the same figures per row so the list costs one read instead of two.
 */
export async function listAdminOrgHealth(
  now: Date = new Date(),
): Promise<AdminOrgHealthList> {
  const rows = await sweepOrgHealth({ now });
  return {
    organizations: rows.map(({ owner_emails: _owners, ...row }) => row),
  };
}

/**
 * The health row plus every owner's address, which the list prints and the
 * alarm band does not.
 */
interface OrgHealthRow extends AdminOrgHealth {
  owner_emails: string[];
}

interface OrgSweepFilters {
  q?: string;
  now?: Date;
}

/**
 * One row per organization, answering the four questions a hand-made
 * onboarding asks: has anyone accepted, has anyone signed in, has an agent
 * connected, and is the place still moving.
 *
 * THE SHAPE OF THE READ, because this is a list and a list is where a
 * per-organization query turns into a hundred:
 *
 *   `q` reaches the organizations query. It matches the name, the
 *   slug or an owner's address — the last of which lives in the auth server
 *   and cannot be joined, so the addresses are resolved to organization ids
 *   first and the three clauses go down as one `or`. The alternative would
 *   be reading every organization and dropping most of them here, which is
 *   the browser-side filter this list exists not to be.
 *
 *   set-wide over what survives, one query each — memberships, workspaces,
 *   open invitations, agent access, the MCP counters for this month and for
 *   the one before it, and the month's `activity` in bounded pages.
 *   Everything is then folded in memory, keyed by organization.
 *
 *   one walk of the auth users list (paged), because sign-in lives in
 *   `auth.users` and nothing joins to it.
 *
 *   one seek per workspace for the node count, and one more only for the
 *   workspaces of organizations that wrote nothing this month — those are the
 *   quiet ones, and "quiet" is exactly the answer that needs a date older than
 *   the window. An organization that is moving costs nothing extra.
 *
 * So the cost grows with workspaces, not with rows, and the busy customers —
 * the ones with the most data — are the cheapest to report on.
 */
async function sweepOrgHealth(filters: OrgSweepFilters = {}): Promise<OrgHealthRow[]> {
  const admin = getSupabaseAdmin();
  const now = filters.now ?? new Date();
  const period = currentPeriod(now);
  const previousPeriod = currentPeriod(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  );
  const since = periodStart(period);

  const term = searchTerm(filters.q);
  let orgQuery = admin
    .from("organizations")
    .select("id, slug, name, created_at")
    .order("created_at", { ascending: false })
    .limit(ORG_SWEEP_MAX);
  if (term) {
    const byOwner = await orgIdsForOwnerEmail(term);
    const clauses = [`name.ilike.*${term}*`, `slug.ilike.*${term}*`];
    if (byOwner.length > 0) clauses.push(`id.in.(${byOwner.join(",")})`);
    orgQuery = orgQuery.or(clauses.join(","));
  }
  const { data: orgRows, error } = await orgQuery;
  if (error) throw new Error(`sweepOrgHealth: ${error.message}`);

  const orgs = (orgRows ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    created_at: string;
  }>;
  if (orgs.length === 0) return [];
  // Only when a filter narrowed the set: unfiltered, the `in (…)` would name
  // every organization there is, which is a longer URL and the same rows.
  const scope = term ? orgs.map((o) => o.id) : null;
  const within = <T>(query: T): T =>
    scope ? (query as { in: (c: string, v: string[]) => T }).in("organization_id", scope) : query;

  const [{ data: memberships }, { data: workspaces }, { data: invites }] = await Promise.all([
    within(admin.from("organization_memberships").select("organization_id, user_id, role")),
    within(admin.from("workspaces").select("id, organization_id")),
    within(
      admin
        .from("workspace_invites")
        .select("organization_id, created_at")
        .is("accepted_at", null),
    ),
  ]);

  const memberRows = (memberships ?? []) as Array<{
    organization_id: string;
    user_id: string;
    role: InviteRole;
  }>;
  const wsRows = (workspaces ?? []) as Array<{ id: string; organization_id: string }>;
  const orgOfWorkspace = new Map(wsRows.map((w) => [w.id, w.organization_id]));
  const wsIds = wsRows.map((w) => w.id);

  const [people, agents, mcpCalls, mcpCallsBefore, activity, nodeCounts] =
    await Promise.all([
      usersForIds(memberRows.map((m) => m.user_id)),
      fetchAgentAccess(wsIds),
      fetchMcpCallsByWorkspace(wsIds, period),
      fetchMcpCallsByWorkspace(wsIds, previousPeriod),
      fetchMonthActivity(wsIds, since),
      countNodes(wsIds),
    ]);

  const byOrg = new Map<string, OrgHealthRow>();
  for (const org of orgs) {
    byOrg.set(org.id, {
      id: org.id,
      slug: org.slug,
      name: org.name,
      created_at: org.created_at,
      owner_email: null,
      owner_emails: [],
      member_count: 0,
      workspace_count: 0,
      node_count: 0,
      oldest_pending_invite_at: null,
      pending_invite_count: 0,
      first_sign_in_at: null,
      last_sign_in_at: null,
      first_agent_connected_at: null,
      agent_count: 0,
      mcp_calls: 0,
      mcp_calls_prev_month: 0,
      writes: 0,
      last_activity_at: null,
      // Overwritten once every counter has been folded in; a ladder read off
      // half-filled numbers would say "never signed in" about everybody.
      state: "never-accepted",
    });
  }

  for (const m of memberRows) {
    const row = byOrg.get(m.organization_id);
    if (!row) continue;
    row.member_count += 1;
    const user = people.get(m.user_id);
    if (m.role === "owner" && user?.email) {
      row.owner_emails.push(user.email);
      row.owner_email ??= user.email;
    }
    // `auth.users` keeps only the LATEST sign-in, so "first" here is the
    // earliest sign-in known across the roster — exact while nobody has come
    // back, and drifting forward afterwards. The load-bearing half is the
    // null: an organization with members and no sign-in at all is an
    // invitation that worked and a product nobody opened, and that is the
    // first thing that goes wrong.
    if (user?.last_sign_in_at) {
      row.first_sign_in_at = oldest(row.first_sign_in_at, user.last_sign_in_at);
      row.last_sign_in_at = newest(row.last_sign_in_at, user.last_sign_in_at);
    }
  }

  for (const w of wsRows) {
    const row = byOrg.get(w.organization_id);
    if (!row) continue;
    row.workspace_count += 1;
    row.node_count += nodeCounts.get(w.id) ?? 0;
    row.mcp_calls += mcpCalls.get(w.id) ?? 0;
    row.mcp_calls_prev_month += mcpCallsBefore.get(w.id) ?? 0;
  }

  for (const invite of (invites ?? []) as Array<{
    organization_id: string;
    created_at: string;
  }>) {
    const row = byOrg.get(invite.organization_id);
    if (!row) continue;
    row.pending_invite_count += 1;
    row.oldest_pending_invite_at = oldest(
      row.oldest_pending_invite_at,
      invite.created_at,
    );
  }

  const agentIdsByOrg = new Map<string, Set<string>>();
  for (const access of agents) {
    const orgId = orgOfWorkspace.get(access.workspace_id);
    const row = orgId ? byOrg.get(orgId) : undefined;
    if (!orgId || !row) continue;
    // Approval IS the connection: `agent_workspace_access` is written when an
    // agent completes the OAuth handshake or a token is scoped to the
    // workspace. Revoked rows count here — the question is whether the
    // product was ever reached, and revoking does not unmake that.
    row.first_agent_connected_at = oldest(
      row.first_agent_connected_at,
      access.approved_at,
    );
    if (access.revoked_at) continue;
    // Distinct: one agent reaching four workspaces is one thing that can read
    // the company's context, not four.
    const seen = agentIdsByOrg.get(orgId) ?? new Set<string>();
    seen.add(access.agent_id);
    agentIdsByOrg.set(orgId, seen);
  }
  for (const [orgId, ids] of agentIdsByOrg) {
    const row = byOrg.get(orgId);
    if (row) row.agent_count = ids.size;
  }

  for (const a of activity) {
    if (!WRITE_VERBS.has(a.verb)) continue;
    const orgId = orgOfWorkspace.get(a.workspace_id);
    const row = orgId ? byOrg.get(orgId) : undefined;
    if (!row) continue;
    row.writes += 1;
    row.last_activity_at = newest(row.last_activity_at, a.created_at);
  }

  // Only for the ones that wrote nothing this month: their last movement is
  // older than the window, and "quiet since March" is a different answer from
  // "never" — telling the two apart is the point of the list.
  const quiet = wsRows.filter((w) => {
    const row = byOrg.get(w.organization_id);
    return row !== undefined && row.last_activity_at === null;
  });
  const olderActivity = await lastActivityByWorkspace(quiet.map((w) => w.id));
  for (const [workspaceId, at] of olderActivity) {
    const orgId = orgOfWorkspace.get(workspaceId);
    const row = orgId ? byOrg.get(orgId) : undefined;
    if (row) row.last_activity_at = newest(row.last_activity_at, at);
  }

  const rows = orgs.map((o) => byOrg.get(o.id)!);
  for (const row of rows) row.state = adminOrgState(row);
  return rows;
}

/**
 * The organizations whose owners' addresses match the search box.
 *
 * Addresses live in the auth server, which nothing joins to, so the only way
 * to make an email search part of the *query* is to resolve it to ids first.
 * Bounded by the same walk as the people list, and for the same reason.
 */
async function orgIdsForOwnerEmail(term: string): Promise<string[]> {
  const admin = getSupabaseAdmin();
  const needle = term.toLowerCase();
  const userIds: string[] = [];
  for (let page = 1; page * AUTH_PAGE <= AUTH_SCAN_CAP; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE });
    const batch = data?.users ?? [];
    for (const u of batch) {
      if ((u.email ?? "").toLowerCase().includes(needle)) userIds.push(u.id);
    }
    if (batch.length < AUTH_PAGE) break;
  }
  if (userIds.length === 0) return [];
  const { data } = await admin
    .from("organization_memberships")
    .select("organization_id")
    .in("user_id", userIds);
  return [
    ...new Set(
      ((data ?? []) as Array<{ organization_id: string }>).map((m) => m.organization_id),
    ),
  ];
}

interface AgentAccessRow {
  agent_id: string;
  workspace_id: string;
  approved_at: string;
  revoked_at: string | null;
}

async function fetchAgentAccess(workspaceIds: string[]): Promise<AgentAccessRow[]> {
  if (workspaceIds.length === 0) return [];
  const { data } = await getSupabaseAdmin()
    .from("agent_workspace_access")
    .select("agent_id, workspace_id, approved_at, revoked_at")
    .in("workspace_id", workspaceIds);
  return (data ?? []) as AgentAccessRow[];
}

/**
 * Reads this month, per workspace.
 *
 * `mcp_usage_counters` and not `org_usage_counters`, which also has an
 * `mcp_calls` meter: the organization counter is keyed by the person the
 * consumption is billed to, and a call an unattributed agent token makes has
 * nobody to bill, so it is not recorded there. The workspace counter records
 * every call. Billing wants the attributable number; this list wants to know
 * whether anything happened at all.
 */
async function fetchMcpCallsByWorkspace(
  workspaceIds: string[],
  period: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const { data, error } = await getSupabaseAdmin()
    .from("mcp_usage_counters")
    .select("workspace_id, calls")
    .in("workspace_id", workspaceIds)
    .eq("period", period);
  // The table arrives with migration 0069; on a database that has not applied
  // it yet the list shows zero reads rather than a 500.
  if (error) return out;
  for (const row of (data ?? []) as Array<{
    workspace_id: string;
    calls: number | null;
  }>) {
    out.set(row.workspace_id, (out.get(row.workspace_id) ?? 0) + (row.calls ?? 0));
  }
  return out;
}

interface HealthActivityRow {
  workspace_id: string;
  verb: string;
  created_at: string;
}

async function fetchMonthActivity(
  workspaceIds: string[],
  since: string,
): Promise<HealthActivityRow[]> {
  if (workspaceIds.length === 0) return [];
  const admin = getSupabaseAdmin();
  const rows: HealthActivityRow[] = [];
  for (let page = 0; page < HEALTH_ACTIVITY_MAX_PAGES; page++) {
    const from = page * HEALTH_ACTIVITY_PAGE;
    const { data, error } = await admin
      .from("activity")
      .select("workspace_id, verb, created_at")
      .in("workspace_id", workspaceIds)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + HEALTH_ACTIVITY_PAGE - 1);
    if (error) break; // Partial counts beat a broken screen; nothing here is billed.
    const batch = (data ?? []) as HealthActivityRow[];
    rows.push(...batch);
    if (batch.length < HEALTH_ACTIVITY_PAGE) break;
  }
  return rows;
}

function oldest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function newest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Create an organization and the invitation that hands it to its first owner.
 *
 * The org is born empty on purpose: the owner's membership is written when
 * they accept, by the same `acceptInvite` path every other member goes
 * through, so there is never a membership pointing at an account that does
 * not exist yet. The admin is recorded as the inviter.
 */
export async function createAdminOrg(input: {
  name: string;
  slug?: string;
  ownerEmail: string;
  role: InviteRole;
  adminUserId: string;
}): Promise<{ org: AdminOrgBase; invite: AdminInvite }> {
  const name = input.name.trim();
  if (!name) throw new AdminOrgError(400, "invalid_name", "The organization needs a name.");
  const email = input.ownerEmail.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AdminOrgError(400, "invalid_email", "Enter a valid owner email.");
  }
  // The owner does not exist yet, so the org is created bare and the owner
  // membership arrives with the acceptance.
  const admin = getSupabaseAdmin();
  const org = await insertOrganization({ name, slug: input.slug });

  const created = await createInvite({
    organizationId: org.id,
    email,
    role: input.role,
    invitedBy: input.adminUserId,
  });

  log.info("admin.org.created", {
    organization_id: org.id,
    slug: org.slug,
    email_domain: email.split("@")[1] ?? null,
    role: input.role,
  });

  const { data: row } = await admin
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .eq("id", created.id)
    .single();

  return {
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      created_at: org.created_at,
      member_count: 0,
      pending_invite_count: 1,
      workspace_count: 0,
      owner_emails: [],
      pending_invites: [toAdminInvite(row as InviteRow)],
    },
    invite: toAdminInvite(row as InviteRow),
  };
}

/** Rename an organization. The slug is an address and never moves. */
export async function updateAdminOrg(
  id: string,
  patch: { name?: string },
  adminUserId: string,
): Promise<AdminOrgDetail> {
  const admin = getSupabaseAdmin();
  const { data: current } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (!current) throw new AdminOrgError(404, "not_found");

  if (patch.name === undefined) {
    throw new AdminOrgError(400, "empty_patch", "Nothing to change.");
  }
  const name = patch.name.trim();
  if (!name) throw new AdminOrgError(400, "invalid_name", "The organization needs a name.");

  const { error } = await admin.from("organizations").update({ name }).eq("id", id);
  if (error) throw new Error(`updateAdminOrg: ${error.message}`);
  log.info("admin.org.renamed", {
    organization_id: id,
    admin_user_id: adminUserId,
    from: current.name as string,
    to: name,
  });

  return getAdminOrgDetail(id);
}

/** A further invitation into an existing organization. Link only. */
export async function createAdminInvite(input: {
  organizationId: string;
  email: string;
  role: InviteRole;
  adminUserId: string;
  /** Workspaces the person joins; ignored for owners and admins. */
  workspaceIds?: string[];
}): Promise<AdminInvite> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new AdminOrgError(400, "invalid_email", "Enter a valid email.");
  }
  const admin = getSupabaseAdmin();
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("id", input.organizationId)
    .maybeSingle();
  if (!org) throw new AdminOrgError(404, "not_found");

  let created;
  try {
    created = await createInvite({
      organizationId: input.organizationId,
      email,
      role: input.role,
      invitedBy: input.adminUserId,
      workspaceIds:
        input.role === "owner" || input.role === "admin"
          ? []
          : input.workspaceIds ?? [],
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error("invite failed");
  }
  const { data: row } = await admin
    .from("workspace_invites")
    .select(INVITE_COLUMNS)
    .eq("id", created.id)
    .single();
  return toAdminInvite(row as InviteRow);
}

export async function revokeAdminInvite(
  organizationId: string,
  inviteId: string,
): Promise<void> {
  await revokeInvite(organizationId, inviteId);
}

/**
 * The one irreversible act, and it happens only when the admin asks for it by
 * name. The outcome is written back on the row so a failed send is visible in
 * the panel rather than assumed — and the link is still there to fall back on.
 */
export async function sendInviteEmail(inviteId: string): Promise<AdminInvite> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("workspace_invites")
    .select(`${INVITE_COLUMNS}, organization:organizations(name)`)
    .eq("id", inviteId)
    .maybeSingle();
  if (!data) throw new AdminOrgError(404, "not_found");
  const row = data as InviteRow & { organization?: { name: string } };
  if (row.accepted_at) {
    throw new AdminOrgError(409, "already_accepted", "That invitation was already accepted.");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AdminOrgError(409, "expired", "That invitation has expired — issue a new one.");
  }

  // An owner invitation is an admin handing someone their organization,
  // so it gets the "it's ready, start using it" voice; anything else is a
  // colleague being added to a team that already exists.
  const delivery = await sendWorkspaceInviteEmail({
    email: row.email,
    inviteToken: row.token,
    organizationName: row.organization?.name ?? "Bcontext",
    role: row.role,
    variant: row.role === "owner" ? "owner" : "member",
  });

  const state = delivery.status === "sent" ? "sent" : "failed";
  const { data: updated } = await admin
    .from("workspace_invites")
    .update({
      delivery_state: state,
      delivery_at: new Date().toISOString(),
      delivery_error: delivery.error,
    })
    .eq("id", inviteId)
    .select(INVITE_COLUMNS)
    .single();

  return toAdminInvite(updated as InviteRow);
}

/**
 * The platform admin's view of organizations, their people and the invite
 * links that let someone in. Contract between bcontext-api and bcontext-web.
 *
 * Besides self-service creation (`POST /api/organizations`), an instance
 * admin can create an organization and its first owner by hand, get back a
 * link, and decide how it travels — copy it and send it personally, or ask
 * the panel to send the invitation email. Nothing is ever sent automatically.
 */
import type { InviteRole } from "./workspaces.js";

/** A pending invitation, with the link already built for the panel. */
export interface AdminInvite {
  id: string;
  email: string;
  role: InviteRole;
  /** Set once somebody used it; the invitation stays on the record. */
  accepted_at: string | null;
  /** True when it can no longer be used, so nobody has to compare dates. */
  expired: boolean;
  /** Absolute /invite/<token> URL — what the admin copies or emails. */
  url: string;
  expires_at: string;
  created_at: string;
  /** Last delivery attempt for this invite, if the admin asked for one. */
  email_status: InviteEmailStatus | null;
  email_sent_at: string | null;
  email_error: string | null;
}

export type InviteEmailStatus = "sent" | "skipped" | "error";

export interface AdminOrgMember {
  user_id: string;
  email: string | null;
  role: InviteRole;
  joined_at: string | null;
  /**
   * Whether they ever set a password, and when they last signed in. An owner
   * who never signed in is the commonest way hand-made onboarding fails
   * quietly, so the fact travels with the member rather than being joined in
   * from the accounts list — which costs a second read and misses anybody
   * past its cap.
   */
  confirmed: boolean;
  last_sign_in_at: string | null;
}

/**
 * What every screen knows about an organization before it asks anything
 * else: who it is, how many people and workspaces it holds, and the
 * invitations still open.
 *
 * The list row and the detail share this and diverge after it. The detail
 * does not carry the health figures below, because it is one organization
 * opened on purpose — the numbers that make a *list* sortable cost a sweep
 * of every counter, and paying for it to render one modal would be paying
 * for a ranking nobody asked for.
 */
export interface AdminOrgBase {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  member_count: number;
  pending_invite_count: number;
  workspace_count: number;
  /** Emails of the org's owners — who to talk to, at a glance. */
  owner_emails: string[];
  /**
   * The invitations still open, links included. They ride on the list read
   * because the link *is* the act: an operator who has just created an
   * organization needs to copy it from the row, and fetching the detail of
   * every organization to find one string is a request per customer on the
   * screen you look at most.
   */
  pending_invites: AdminInvite[];
}

/**
 * GET /api/admin/organizations — one customer as the panel ranks them.
 *
 * The health figures are here rather than behind a second request because
 * the list is *sorted by* `state`, and `state` is derived from exactly these
 * fields. A sort that lives in the browser cannot survive pagination — page
 * two would be ordered among itself — so the derivation and the order have
 * to happen on the side that cuts the rows, and once they do the numbers are
 * already in hand. One read draws the row.
 */
export interface AdminOrgSummary extends AdminOrgBase {
  node_count: number;
  /** The oldest open invitation, so a stale one is visible without arithmetic. */
  oldest_pending_invite_at: string | null;
  /** Null while nobody has ever signed in — the first thing that goes wrong. */
  first_sign_in_at: string | null;
  last_sign_in_at: string | null;
  /** Null while no agent has ever connected: the moment the product starts. */
  first_agent_connected_at: string | null;
  agent_count: number;
  /** MCP calls and writes this month — whether the place is still alive. */
  mcp_calls: number;
  writes: number;
  /**
   * Last month's calls, which is what turns "quiet" from a guess into a
   * fact: a customer who was busy and stopped on the 2nd still has a recent
   * `last_activity_at`, and only the comparison shows what happened.
   */
  mcp_calls_prev_month: number;
  last_activity_at: string | null;
  /** Where this customer is on the ladder — the list's sort key. */
  state: AdminOrgState;
}

/**
 * How far a customer got, as a ladder: each rung is the first thing that has
 * not happened yet, and `healthy` is the absence of all of them.
 *
 * One derivation, in `adminOrgState` — the list sorts by it, the `state`
 * filter selects on it and the panel prints it. Two definitions of "quiet"
 * that can drift is the bug this shape exists to prevent.
 */
export type AdminOrgState =
  | "never-accepted"
  | "never-signed-in"
  | "no-agent"
  | "quiet"
  | "healthy";

/** The ladder, worst first. Also the list's sort order. */
export const ADMIN_ORG_STATES: readonly AdminOrgState[] = [
  "never-accepted",
  "never-signed-in",
  "no-agent",
  "quiet",
  "healthy",
];

/** What each rung means, for the one screen that shows them. */
export const ADMIN_ORG_STATE_LABELS: Record<AdminOrgState, string> = {
  "never-accepted": "Never accepted",
  "never-signed-in": "Never signed in",
  "no-agent": "No agent",
  quiet: "Quiet",
  healthy: "Healthy",
};

/**
 * What the `state` filter accepts: a rung, or the shorthand for everything
 * short of healthy — which is the only question an operator opens this
 * screen to ask.
 */
export type AdminOrgStateFilter = AdminOrgState | "needs-attention";

export const ADMIN_ORG_STATE_FILTERS: readonly AdminOrgStateFilter[] = [
  ...ADMIN_ORG_STATES,
  "needs-attention",
];

/** The fields the ladder reads. Both `AdminOrgSummary` and `AdminOrgHealth`
 *  satisfy it, so the two surfaces cannot answer differently. */
export interface AdminOrgStateInput {
  member_count: number;
  first_sign_in_at: string | null;
  first_agent_connected_at: string | null;
  mcp_calls: number;
  writes: number;
}

/**
 * Which rung this customer is on.
 *
 * Order is the argument. An organization nobody accepted has no sign-in and
 * no agent either, and saying so three times tells the operator nothing —
 * the useful answer is the *first* thing missing, because that is the thing
 * to do something about today.
 */
export function adminOrgState(row: AdminOrgStateInput): AdminOrgState {
  if (row.member_count === 0) return "never-accepted";
  if (!row.first_sign_in_at) return "never-signed-in";
  if (!row.first_agent_connected_at) return "no-agent";
  // Quiet is about this month and nothing else: a customer who was busy and
  // stopped on the 2nd still has a recent `last_activity_at`, so a date
  // cannot tell the two apart and the month's counters can.
  if (row.mcp_calls === 0 && row.writes === 0) return "quiet";
  return "healthy";
}

/** Does this customer answer the filter? `needs-attention` is the first four
 *  rungs — everything that is not yet working. */
export function matchesAdminOrgState(
  state: AdminOrgState,
  filter: AdminOrgStateFilter,
): boolean {
  return filter === "needs-attention" ? state !== "healthy" : state === filter;
}

/**
 * How every admin list travels: a page of rows and how many there are in
 * total. The count comes from the database rather than the length of the
 * page — a screen that says "50" while a thousand people wait behind it is
 * how an operator stops trusting the panel.
 */
export interface AdminPage<T> {
  items: T[];
  /** Rows matching the query, ignoring `limit` and `offset`. */
  total: number;
  limit: number;
  offset: number;
}

/**
 * What every admin list accepts. Search and filters live here rather than in
 * the browser: with the rows cut server-side, filtering the page you happen
 * to be on would answer "no such customer" about somebody on page four.
 */
export interface AdminListQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * GET /api/admin/organizations. `q` is matched against the name, the slug
 * and the owners' addresses — an operator searching a customer types
 * whichever of the three they happen to have.
 */
export interface AdminOrgListQuery extends AdminListQuery {
  state?: AdminOrgStateFilter;
}

/** A workspace of an organization, as the admin panel lists it. */
export interface AdminOrgWorkspace {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  node_count: number;
  member_count: number;
  last_activity_at: string | null;
}

/** GET /api/admin/organizations/:id */
export interface AdminOrgDetail extends AdminOrgBase {
  members: AdminOrgMember[];
  /** Open invitations **and** the ones already taken, newest first: an
   *  invitation that vanishes on acceptance leaves no history of what was
   *  sent to whom. */
  invites: AdminInvite[];
  workspaces: AdminOrgWorkspace[];
}

/** PATCH /api/admin/organizations/:id */
export interface AdminOrgPatch {
  name?: string;
}

/**
 * One customer, as an operator reads them at a glance: has anyone accepted,
 * has anyone signed in, has anything connected, and is it still moving.
 *
 * This is the row that makes hand-made onboarding possible at twenty
 * customers — without it the same questions take twenty page visits and a
 * model held in somebody's head.
 *
 * The same figures now ride on `AdminOrgSummary`, and the two answer
 * different questions. `GET /api/admin/organizations` answers "show me this
 * page of customers, worst first" and is cut to a page. `GET
 * /api/admin/organizations/health` answers "is anything wrong anywhere" and
 * is deliberately NOT paginated: the Overview's alarm band counts every
 * customer in trouble, and a band that counted the first fifty would go
 * quiet exactly as the platform grew.
 */
export interface AdminOrgHealth {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  member_count: number;
  workspace_count: number;
  node_count: number;
  /** The oldest open invitation, so a stale one is visible without arithmetic. */
  oldest_pending_invite_at: string | null;
  pending_invite_count: number;
  /** Null while nobody has ever signed in — the first thing that goes wrong. */
  first_sign_in_at: string | null;
  last_sign_in_at: string | null;
  /** Null while no agent has ever connected: the moment the product starts. */
  first_agent_connected_at: string | null;
  agent_count: number;
  /** MCP calls and writes this month — whether the place is still alive. */
  mcp_calls: number;
  writes: number;
  /**
   * Last month's calls, which is what turns "quiet" from a guess into a
   * fact: a customer who was busy and stopped on the 2nd still has a recent
   * `last_activity_at`, and only the comparison shows what happened.
   */
  mcp_calls_prev_month: number;
  last_activity_at: string | null;
  /** The same ladder the list sorts by, so the Overview's alarm band and the
   *  list cannot disagree about who is in trouble. */
  state: AdminOrgState;
}

export interface AdminOrgHealthList {
  organizations: AdminOrgHealth[];
}

/** POST /api/admin/organizations */
export interface CreateAdminOrgBody {
  name: string;
  slug?: string;
  /** The person who will own it. An invite link is issued for this address. */
  owner_email: string;
  role?: InviteRole;
}

export interface CreateAdminOrgResult {
  /** The organization as it is one second old, without the health figures:
   *  nothing has happened to it yet, so there is nothing to measure. */
  org: AdminOrgBase;
  invite: AdminInvite;
}

/** POST /api/admin/organizations/:id/invites */
export interface CreateAdminInviteBody {
  email: string;
  role?: InviteRole;
}

/** POST /api/admin/invites/:id/email — explicit, admin-triggered delivery. */
export interface SendInviteEmailResult {
  status: InviteEmailStatus;
  error: string | null;
  invite: AdminInvite;
}

/** GET /api/admin/users */
export interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  /** False while the person has been invited but never set a password. */
  confirmed: boolean;
  orgs: Array<{ id: string; slug: string; name: string; role: InviteRole }>;
}

/** Where a person got to. `invited` is somebody who has a row and no
 *  password: the invitation worked and they never arrived. */
export type AdminUserState = "invited" | "never-signed-in" | "active";

export const ADMIN_USER_STATES: readonly AdminUserState[] = [
  "invited",
  "never-signed-in",
  "active",
];

/** GET /api/admin/users. `q` is matched against the address. */
export interface AdminUserListQuery extends AdminListQuery {
  /** Organization id — everyone who belongs to that one company. */
  organization?: string;
  role?: InviteRole;
  state?: AdminUserState;
}

/**
 * A page of people, and how far into the platform the answer reached.
 *
 * People live in the auth server, which hands its list out in pages and
 * cannot be searched or joined. So this list walks it and stops: `scanned`
 * is how many accounts that walk saw, `cap` is where it stops, and `capped`
 * says the platform has more people than the walk reached — at which point
 * `total` counts matches among the accounts scanned and NOT among all of
 * them. The flag exists so the panel can say that out loud instead of
 * quietly answering a smaller question than the one asked.
 */
export interface AdminUserPage extends AdminPage<AdminUserRow> {
  scanned: number;
  cap: number;
  capped: boolean;
}

/**
 * One person, everything the platform knows about them.
 *
 * The list answers "who is here"; this answers the questions that follow —
 * where they can work, what they connected, and whether any of it has been
 * used. An operator opens it when a name on a list has become a question.
 */
export interface AdminUserWorkspace {
  id: string;
  slug: string;
  name: string;
  organization_id: string;
  organization_slug: string;
  /** The role they hold there, and whether it comes from the org rather than
   *  a membership of their own. */
  role: InviteRole;
  via_org_role: boolean;
}

export interface AdminUserAgent {
  id: string;
  name: string;
  provider: string | null;
  created_at: string;
  last_used_at: string | null;
  workspace_count: number;
}

/** GET /api/admin/users/:id */
export interface AdminUserDetail extends AdminUserRow {
  workspaces: AdminUserWorkspace[];
  /** Agents this person connected — the things acting in their name. */
  agents: AdminUserAgent[];
  /** Their last write anywhere, which is what "still around" actually means. */
  last_activity_at: string | null;
}

/**
 * An organization as the people inside it administer it — not as the instance
 * admin does (that is `admin-orgs.ts`, gated on the platform allowlist).
 *
 * The shapes here back one modal with five tabs, and the split is the
 * product's own model: people belong to the organization, access belongs to
 * the workspace, and an owner or admin reaches every workspace their
 * organization holds. So `OrgAdminMember` carries both — the role in the
 * company, and the projects that role does not already cover.
 */
import type { InviteRole, WorkspaceRole } from "./workspaces.js";
import type { InviteEmailStatus } from "./admin-orgs.js";
import type { Workspace } from "./types.js";

/* -------------------------------------------------------------------------- */
/*  Creation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Who may create an organization on this instance, from `ORG_CREATION`:
 * `open` lets any signed-in person create one (and sign up), `admin` keeps
 * it to the instance admins (`ADMIN_EMAILS`), who then invite the owners.
 */
export type OrgCreationPolicy = "open" | "admin";

export const ORG_CREATION_POLICIES: readonly OrgCreationPolicy[] = ["open", "admin"];

/** How long an organization's name may be; the slug follows the same cap. */
export const ORG_NAME_MAX = 80;

/**
 * `POST /api/organizations` — a signed-in person creates an organization
 * and becomes its owner. The first workspace is created with it, so the
 * person lands somewhere they can work instead of an empty company.
 *
 * `slug` is optional: without it the address is derived from the name and
 * disambiguated (`acme`, `acme-2`). A slug given explicitly is taken as is
 * or refused with 409 `slug_taken` — somebody who typed an address expects
 * that address.
 */
export interface CreateOrganizationBody {
  name: string;
  slug?: string;
  /** The first workspace's name. Defaults to "General". */
  workspace_name?: string;
}

export interface CreatedOrganization {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

/** `201` from `POST /api/organizations`. */
export interface CreateOrganizationResult {
  organization: CreatedOrganization;
  workspace: Workspace;
}

/* -------------------------------------------------------------------------- */
/*  Meters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What an organization consumes, counted for observability — there are no
 * ceilings on a self-hosted instance, only numbers an administrator reads.
 *
 *   ai_queries      calls to a model on a user's behalf (chat, ask_rag, …)
 *   mcp_calls       what agents read
 *   nodes           how much context the organization holds (a stock)
 *   meeting_minutes recorded meeting time
 */
export type UsageKind = "ai_queries" | "mcp_calls" | "nodes" | "meeting_minutes";

export const USAGE_KINDS: readonly UsageKind[] = [
  "ai_queries",
  "mcp_calls",
  "nodes",
  "meeting_minutes",
];

/** Where a person can work, inside one organization. */
export interface OrgMemberWorkspace {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
  /** True when the access comes from the org role rather than a membership. */
  via_org_role: boolean;
}

/**
 * A workspace whose grant was revoked is absent from a member's list even
 * though the membership row survives, because that is what the request path
 * does: the grant is authoritative and denies before anything else is asked.
 * The screen shows the access somebody actually has, not the access their
 * rows suggest.
 */

export interface OrgAdminMember {
  user_id: string;
  email: string | null;
  /** Their profile name, joined; null while they have not given one. */
  name: string | null;
  role: InviteRole;
  joined_at: string | null;
  last_sign_in_at: string | null;
  /** False while the person was created or invited and never signed in. */
  confirmed: boolean;
  /** True for the caller's own row, so the UI can refuse to lock them out. */
  is_you: boolean;
  workspaces: OrgMemberWorkspace[];
}

export interface OrgAdminWorkspace {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  node_count: number;
  /**
   * People who can reach it: memberships **plus** the organization's owners
   * and admins, whose role lets them in without one. Counting rows alone
   * reports zero for a workspace its owner works in every day.
   */
  member_count: number;
}

export interface OrgAdminInvite {
  id: string;
  email: string;
  role: InviteRole;
  /** The link the admin copies; emailing it is a separate, explicit act. */
  url: string;
  expires_at: string;
  created_at: string;
  workspace_ids: string[];
  email_status: InviteEmailStatus | null;
  email_sent_at: string | null;
  email_error: string | null;
}

/** `GET /api/organizations/:org` — everything the modal opens with. */
export interface OrgAdminDetail {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  /** The caller's role. Only `owner` and `admin` can reach this at all. */
  role: InviteRole;
  members: OrgAdminMember[];
  workspaces: OrgAdminWorkspace[];
  invites: OrgAdminInvite[];
}

/** `PATCH /api/organizations/:org`. The slug is an address and never moves. */
export interface OrgPatch {
  name?: string;
}

/**
 * `POST /api/organizations/:org/invites` — how a person is added, and the
 * only way.
 *
 * An administrator could have been allowed to create the account outright
 * with a password of their choosing, but that path ends with one colleague
 * knowing another's credentials, and the person has to replace the password
 * on first sign-in anyway. The invitation is the same journey with one step
 * fewer and nobody else's password in it.
 */
export interface CreateOrgInviteBody {
  email: string;
  role?: InviteRole;
  /** Workspaces to join; ignored for owners and admins, who reach them all. */
  workspaces?: string[];
}

/** `PATCH /api/organizations/:org/members/:userId` */
export interface OrgMemberPatch {
  role?: InviteRole;
  /**
   * The complete list of workspace ids this person should reach —
   * reconciled, not appended: what is missing from it is taken away.
   *
   * Ignored for owners and admins. Their role already reaches every
   * workspace, and writing per-workspace rows for them is noise at best and
   * a lockout at worst: removing one revokes a grant, and a revoked grant
   * denies before the organization role is ever consulted.
   */
  workspaces?: string[];
}

/* -------------------------------------------------------------------------- */
/*  Usage                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * MCP tool calls: the only measure of how much an organization's context is
 * READ. `activity` records writes only, so until this counter existed a month
 * of retrievals left no trace anywhere.
 *
 * Split by tool because they are not the same thing: `ping` is noise,
 * `nodes(op=search)` is a retrieval with embeddings behind it.
 */
export interface OrgMcpToolUsage {
  tool: string;
  calls: number;
}

export interface OrgMcpUsage {
  total: number;
  /** Busiest tool first. */
  by_tool: OrgMcpToolUsage[];
}

export interface OrgUsageWorkspace {
  id: string;
  slug: string;
  name: string;
  node_count: number;
  nodes_created: number;
  nodes_edited: number;
  meeting_minutes: number;
  mcp_calls: number;
}

/**
 * `GET /api/organizations/:org/usage` — what the organization is consuming
 * this month. Measured, never priced: every field is something the database
 * counts.
 */
export interface OrgUsage {
  /** `YYYY-MM` — the month the counters cover. */
  period: string;
  nodes_total: number;
  nodes_created: number;
  nodes_edited: number;
  /**
   * Writes split by who made them: the people, and the agents they connected.
   * They do not add up to the total on purpose — a migration or a backfill
   * writes as `system`, and crediting that to either side would claim work
   * nobody did or inflate the one figure this screen exists to keep honest.
   */
  writes_by_people: number;
  writes_by_agents: number;
  ai_queries: number;
  meeting_minutes: number;
  member_count: number;
  agent_count: number;
  mcp_calls: OrgMcpUsage;
  workspaces: OrgUsageWorkspace[];
}

/* -------------------------------------------------------------------------- */
/*  Agents                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A non-human thing that can read the company's context, and what it reaches.
 * This view exists because that list was only ever visible one workspace at a
 * time, which is no way to answer "what can read our data".
 */
export interface OrgAgent {
  id: string;
  name: string;
  provider: string | null;
  created_at: string;
  last_used_at: string | null;
  /**
   * Who connected it — the person answerable for it.
   *
   * The id is what the panel groups by, and the reason it is here at all: an
   * email address is a label, not a key, so a list keyed on it splits one
   * person into two the moment they change address. The email and the name
   * are what gets rendered; the id is what decides which pile a row lands in.
   */
  connected_by_user_id: string | null;
  connected_by_email: string | null;
  /** Their profile name, joined; null while they have not given one. */
  connected_by_name: string | null;
  workspaces: Array<{ id: string; slug: string; name: string; scopes: string[] }>;
}

export interface OrgAgentList {
  agents: OrgAgent[];
}

/* -------------------------------------------------------------------------- */
/*  One person, in full                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/organizations/:org/members/:userId` — everything an administrator
 * needs about one person, in one read.
 *
 * The roster answers "who is here"; this answers "what is this person doing".
 * It gathers access, the agents they connected and what they consumed,
 * because an agent consumes on behalf of the person who owns it.
 */
export interface OrgMemberAgent {
  id: string;
  name: string;
  provider: string | null;
  created_at: string;
  last_used_at: string | null;
  workspaces: Array<{ id: string; slug: string; name: string; scopes: string[] }>;
}

/** One meter, for one person: what they consumed, beside the whole organization. */
export interface OrgMemberMeter {
  kind: UsageKind;
  used: number;
  /** What the organization as a whole consumed, so a share is readable. */
  org_used: number;
}

export interface OrgMemberDetail {
  user_id: string;
  email: string | null;
  name: string | null;
  role: InviteRole;
  joined_at: string | null;
  last_sign_in_at: string | null;
  confirmed: boolean;
  is_you: boolean;
  /** True while this is the last owner: the UI must not offer to demote them. */
  is_last_owner: boolean;
  workspaces: OrgMemberWorkspace[];
  agents: OrgMemberAgent[];
  /** `YYYY-MM` — the month the meters cover. */
  period: string;
  meters: OrgMemberMeter[];
}

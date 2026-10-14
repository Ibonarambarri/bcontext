/**
 * Workspaces, membership and invitations, as the API returns them and the
 * hub / invite / consent pages render them.
 *
 * Part of the contract between bcontext-api and bcontext-web. The
 * reads and writes behind these live in `@/lib/workspaces/*` and
 * `@/lib/auth/invitations` on the API side; the web side only ever sees these
 * shapes, over HTTP.
 */
import type { Workspace } from "./types.js";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer" | "agent";

/** A role an invitation can carry. `agent` is a token's role, never a person's. */
export type InviteRole = Exclude<WorkspaceRole, "agent">;

/** The organization a workspace belongs to, as a card needs to name it. */
export interface WorkspaceOrgRef {
  id: string;
  slug: string;
  name: string;
  /** The caller's role in the organization, not in the workspace. */
  role: InviteRole | null;
}

/**
 * A workspace as the hub shows it: the row plus what the caller holds in it,
 * the organization it lives in and the numbers on the card.
 * `GET /api/workspaces?stats=1`.
 */
export interface WorkspaceCard extends Workspace {
  role: WorkspaceRole;
  organization: WorkspaceOrgRef;
  member_count: number;
  open_task_count: number;
  node_count: number;
  last_activity_at: string;
}

/**
 * An organization the caller belongs to, with what they may do in it. The
 * hub groups by these, and `can_create_workspace` is what decides whether
 * the org appears in the "new workspace" picker.
 */
export interface OrganizationCard {
  id: string;
  slug: string;
  name: string;
  role: InviteRole;
  workspace_count: number;
  member_count: number;
  can_create_workspace: boolean;
  can_manage: boolean;
}

/** `GET /api/workspaces` — the hub's single read. */
export interface WorkspacesResponse {
  workspaces: WorkspaceCard[];
  organizations: OrganizationCard[];
}

/**
 * `POST /api/workspaces` body. The organization is required: a workspace is
 * always created inside one, and only an owner or admin of that organization
 * may create it. The slug is derived from the name and never supplied — see
 * `slugify` and the numeric disambiguation in the API.
 */
export interface CreateWorkspaceBody {
  organization: string;
  name: string;
  description?: string;
}

/**
 * `PATCH /api/workspaces/:ws` body. Every field optional; nothing given is a
 * no-op. The slug is not here on purpose: it is generated from the name when
 * the workspace is created and then frozen, because it is the address people
 * and agents have written down.
 */
export interface WorkspacePatch {
  name?: string;
  /** 0–360, or null to leave the deterministic accent in place. */
  accent_hue?: number | null;
  /** A `GRADIENTS` id from `@/lib/workspace-gradients`. */
  accent_gradient?: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string | null;
  role: WorkspaceRole;
  joined: string;
  isYou: boolean;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  /** Absolute /invite/<token> URL — what the roster copies and shares. */
  url: string;
  expiresAt: string;
  createdAt: string;
}

/** `GET /api/workspaces/:ws/members`. */
export interface WorkspaceMembersResponse {
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  role: WorkspaceRole | null;
  canManage?: boolean;
  /** Set when the workspace lives in demo storage: no roster exists. */
  demo?: boolean;
}

/**
 * What the invite page shows before the person signs in. The token is what
 * they used to ask, so it is not echoed back.
 */
export interface InvitePreview {
  email: string;
  role: InviteRole;
  organization_name: string;
  organization_slug: string;
  expires_at: string;
}

/** `POST /api/invites/:token/accept`. */
export interface InviteAccepted {
  orgSlug: string;
  /**
   * Where to land the person: the first workspace the invitation actually
   * let them into, or null when it only made them a member of the
   * organization — an owner or admin, who lands on the hub and sees
   * everything the organization holds.
   */
  workspaceSlug: string | null;
}

/**
 * The registered OAuth client, reduced to what the consent screen shows and
 * checks. The secret hash and the registrant never leave the API.
 */
export interface OAuthClientPublic {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  scope: string;
  client_uri: string | null;
  logo_uri: string | null;
}

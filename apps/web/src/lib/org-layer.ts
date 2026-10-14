/**
 * Progressive disclosure of the organization layer.
 *
 * The model is organization → workspace and the URLs say so (`/w/<org>/<ws>`);
 * that never changes. What changes is whether the interface *talks* about the
 * organization. For one person with one project it is a word they never chose
 * and cannot act on: a section header above a single card, a filter with one
 * option, a `/w/<org>/<ws>` address on every card. So the layer only shows up
 * once it means something — when there is more than one organization to tell
 * apart, or when the one they are in holds more than one workspace or more
 * than one person.
 *
 * The boolean governs how the interface talks, never what it allows. The
 * hub's "New workspace" and "Manage organization" buttons are there for
 * anyone who may use them, layer or no layer: inviting the second person is
 * exactly the act that makes the layer appear, and it has to be reachable
 * from the screen that hides it.
 *
 * This module is the only place that decision is made. Everything else takes
 * the boolean: the hub, the switcher, the settings drawer, the wizard. A new
 * screen that needs to know asks `showOrgLayer` rather than counting again.
 *
 * The counts come from `GET /api/workspaces?stats=1`, which already returns
 * `organizations[].workspace_count` and `organizations[].member_count`
 * alongside the workspace cards — no extra read, no API change.
 */

/** Two of anything is what makes the level worth naming. */
export const ORG_LAYER_THRESHOLD = 2;

/** An organization as the hub read reports it (`OrganizationCard`-shaped). */
export interface OrgLayerOrganization {
  id: string;
  workspace_count?: number;
  member_count?: number;
}

/** A workspace card, reduced to the organization it lives in. */
export interface OrgLayerWorkspace {
  organization: { id: string };
}

/** What the hub read gives us, with both halves optional. */
export interface OrgLayerInput {
  organizations?: readonly OrgLayerOrganization[] | null;
  workspaces?: readonly OrgLayerWorkspace[] | null;
}

interface OrgCounts {
  workspaces: number;
  members: number;
}

/**
 * Per-organization counts, taking the larger of what the organization card
 * claims and what the caller can actually see. The card is authoritative for
 * a company whose other workspaces are none of this person's business; the
 * visible list is the floor when the card is missing (a workspace whose
 * organization did not come back in the list at all).
 */
function countByOrganization(input: OrgLayerInput): Map<string, OrgCounts> {
  const counts = new Map<string, OrgCounts>();
  const bump = (id: string): OrgCounts => {
    const existing = counts.get(id);
    if (existing) return existing;
    const fresh: OrgCounts = { workspaces: 0, members: 0 };
    counts.set(id, fresh);
    return fresh;
  };

  for (const org of input.organizations ?? []) {
    const entry = bump(org.id);
    entry.workspaces = Math.max(entry.workspaces, org.workspace_count ?? 0);
    entry.members = Math.max(entry.members, org.member_count ?? 0);
  }

  const visible = new Map<string, number>();
  for (const workspace of input.workspaces ?? []) {
    const id = workspace.organization.id;
    visible.set(id, (visible.get(id) ?? 0) + 1);
  }
  for (const [id, seen] of visible) {
    const entry = bump(id);
    entry.workspaces = Math.max(entry.workspaces, seen);
  }

  return counts;
}

/**
 * Does the organization level exist for this person, in the sense of being
 * something they can see the shape of?
 *
 * True when they reach more than one organization, or when any organization
 * they belong to holds two or more workspaces or two or more members. False
 * is the solo case: one company, one project, one person — and the interface
 * says "workspace" and nothing else.
 */
export function showOrgLayer(input: OrgLayerInput): boolean {
  const counts = countByOrganization(input);
  if (counts.size >= ORG_LAYER_THRESHOLD) return true;
  for (const entry of counts.values()) {
    if (entry.workspaces >= ORG_LAYER_THRESHOLD) return true;
    if (entry.members >= ORG_LAYER_THRESHOLD) return true;
  }
  return false;
}

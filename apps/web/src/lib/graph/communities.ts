import { tagHueDegrees, tagNodeColor } from "@/lib/tag-color";
import type { GraphEdgePayload, GraphResourcePayload } from "@bcontext-dev/contract/graph/model";

/**
 * Community detection for the graph engine.
 *
 * graphify (the reference visualizer) runs Leiden/Louvain over an untyped
 * corpus because it has no ground-truth grouping. Bcontext does: the tag
 * taxonomy. A node's community is the ROOT TAG of its primary tag's parent
 * chain — deterministic, stable across renders, and semantically honest
 * (colors answer "which area of the workspace is this?" instead of
 * "which blob did a stochastic optimizer find?").
 *
 * Tags inherit the community of their root ancestor, so a whole taxonomy
 * branch — the root tag, its descendants and every node they classify —
 * reads as one colored region, exactly like graphify's cluster coloring.
 */

export const UNTAGGED_COMMUNITY = "community:untagged";

export interface GraphCommunity {
  /** Stable key — the root tag resource id, or UNTAGGED_COMMUNITY. */
  key: string;
  /** Human label — the root tag name without the `#` prefix. */
  label: string;
  /** Identity hue in degrees, derived from this community's own tag id. -1 for untagged. */
  hue: number;
  /** Members currently visible (tags + content nodes). */
  size: number;
}

/** Resource id → community key, plus the legend entries ordered by size. */
export interface GraphCommunityAssignment {
  communityByResource: Map<string, string>;
  communities: GraphCommunity[];
}

/**
 * Community color is tag color: a community IS a tag (its key is that tag's
 * resource id), so both live in one module shared with the chips outside the
 * graph — see src/lib/tag-color.ts for the derivation and its trade-offs.
 */
export { tagNodeColor as communityColor };


/**
 * Assign every rendered resource to a community.
 *
 * - Tag resources walk `tag-parent` edges up to their root tag.
 * - Content nodes take the community of their primary tag — the first entry
 *   of the node's own `tags` list that is rendered in this snapshot (same
 *   precedence the layout's orbit seeding uses). A node touching several
 *   rendered tags therefore resolves deterministically to the first one in
 *   its own stored tag order (membership-edge order as the fallback).
 * - Untagged content, the workspace hub and cluster aggregates fall into
 *   the neutral UNTAGGED_COMMUNITY.
 *
 * Filter-centered snapshots (tags with `role: "filter-center"`) descend ONE
 * level: each center is its own community (its color follows its tag id, so
 * it matches the unfiltered graph), and every DIRECT child of a center becomes its
 * own community — the child, its whole subtree and the nodes they classify
 * share the child's color, reading as subsections of the filter. Content
 * hanging straight off a center takes the center's community. The
 * unfiltered graph has no filter-center tags, so its behavior is untouched.
 *
 * Deterministic: same snapshot in → same assignment and palette slots out.
 */
export function assignGraphCommunities(
  nodes: readonly GraphResourcePayload[],
  edges: readonly GraphEdgePayload[],
): GraphCommunityAssignment {
  const tagResources = nodes.filter((node) => node.resource_type === "tag");
  const tagResourceIds = new Set(tagResources.map((tag) => tag.id));
  const centerIds = new Set(
    tagResources.filter((tag) => tag.role === "filter-center").map((tag) => tag.id),
  );

  // tag-parent edges: from = parent tag resource, to = child tag resource.
  const parentByTag = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type !== "tag-parent") continue;
    if (!tagResourceIds.has(edge.from) || !tagResourceIds.has(edge.to)) continue;
    if (!parentByTag.has(edge.to)) parentByTag.set(edge.to, edge.from);
  }

  const rootCache = new Map<string, string>();
  const rootOf = (tagResourceId: string): string => {
    const cached = rootCache.get(tagResourceId);
    if (cached) return cached;
    // Filter-centered mode: a center is its own community, and the walk up
    // from any other tag stops one step BELOW the first center it meets —
    // that direct child of the filter is the community.
    const seen = new Set<string>([tagResourceId]);
    let current = tagResourceId;
    while (!centerIds.has(current)) {
      const parent = parentByTag.get(current);
      if (!parent || seen.has(parent)) break;
      if (centerIds.has(parent)) break;
      seen.add(parent);
      current = parent;
    }
    for (const id of seen) rootCache.set(id, current);
    return current;
  };

  // Primary tag per content node: first of the node's own tag tokens that is
  // rendered. Tag payload exposes name/slug/normalized_name; node payloads
  // carry name tokens (getNodeTags), so index all three.
  const tagResourceByToken = new Map<string, string>();
  for (const tag of tagResources) {
    if (tag.resource_type !== "tag") continue;
    for (const token of [tag.tag.name, tag.tag.slug, tag.tag.normalized_name]) {
      const key = token.toLocaleLowerCase("en-US");
      if (!tagResourceByToken.has(key)) tagResourceByToken.set(key, tag.id);
    }
  }

  const membershipByNode = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.layer !== "taxonomy") continue;
    const tagId = tagResourceIds.has(edge.from) ? edge.from : tagResourceIds.has(edge.to) ? edge.to : null;
    if (!tagId) continue;
    const nodeId = edge.from === tagId ? edge.to : edge.from;
    membershipByNode.set(nodeId, [...(membershipByNode.get(nodeId) ?? []), tagId].sort());
  }

  const communityByResource = new Map<string, string>();
  const sizeByCommunity = new Map<string, number>();
  const record = (resourceId: string, community: string) => {
    communityByResource.set(resourceId, community);
    sizeByCommunity.set(community, (sizeByCommunity.get(community) ?? 0) + 1);
  };

  for (const resource of nodes) {
    if (resource.resource_type === "tag") {
      record(resource.id, rootOf(resource.id));
      continue;
    }
    if (resource.resource_type === "cluster") {
      record(resource.id, UNTAGGED_COMMUNITY);
      continue;
    }
    // Content node: prefer the node's own tag order, fall back to the first
    // rendered membership edge, else untagged. In filter-centered mode every
    // result node carries the filter, so the center is only the FALLBACK:
    // the node takes the first rendered NON-center tag in its own stored
    // order (its subsection of the filter), and the center's color only when
    // it hangs straight off the center with no rendered sub-tag.
    const candidates: string[] = [];
    for (const token of resource.tags) {
      const tagId = tagResourceByToken.get(token.toLocaleLowerCase("en-US"));
      if (tagId) candidates.push(tagId);
    }
    candidates.push(...(membershipByNode.get(resource.id) ?? []));
    const primary = candidates.find((tagId) => !centerIds.has(tagId)) ?? candidates[0] ?? null;
    record(resource.id, primary ? rootOf(primary) : UNTAGGED_COMMUNITY);
  }

  const labelByCommunity = new Map<string, string>();
  for (const tag of tagResources) {
    if (tag.resource_type !== "tag") continue;
    const root = rootOf(tag.id);
    if (tag.id === root) labelByCommunity.set(root, tag.tag.name);
  }

  const orderedKeys = [...sizeByCommunity.keys()]
    .filter((key) => key !== UNTAGGED_COMMUNITY)
    .sort((a, b) =>
      (sizeByCommunity.get(b)! - sizeByCommunity.get(a)!)
        || (labelByCommunity.get(a) ?? a).localeCompare(labelByCommunity.get(b) ?? b),
    );

  // A community's hue is a pure function of its own tag id: not its size,
  // not its rank in this snapshot, not which view is rendering it. So a
  // filter-centered snapshot keeps the exact colors of the unfiltered graph
  // for free, and a tag's chip anywhere in the app can compute the same hue without
  // knowing anything about this snapshot.
  const communities: GraphCommunity[] = orderedKeys.map((key) => ({
    key,
    label: labelByCommunity.get(key) ?? key.replace(/^tag:/, ""),
    hue: tagHueDegrees(key),
    size: sizeByCommunity.get(key)!,
  }));
  if (sizeByCommunity.has(UNTAGGED_COMMUNITY)) {
    communities.push({
      key: UNTAGGED_COMMUNITY,
      label: "untagged",
      hue: -1,
      size: sizeByCommunity.get(UNTAGGED_COMMUNITY)!,
    });
  }

  return { communityByResource, communities };
}

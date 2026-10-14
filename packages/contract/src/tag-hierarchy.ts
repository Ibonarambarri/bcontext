import type { TagRelation, WorkspaceTag } from "./types.js";

/**
 * Pure helpers for the tag hierarchy (`tag_relations`).
 *
 * Semantics (owner decision, query-time inheritance — nothing is ever
 * materialized into `node_tags`):
 *   - a node's *effective* tags = its direct tags ∪ every ANCESTOR of those
 *     tags (multi-parent DAG walk over `relation: "parent"` edges);
 *   - equivalently, filtering by a tag T matches nodes tagged with T or with
 *     any DESCENDANT of T.
 * `relation: "related"` is a symmetric association and NEVER inherits.
 *
 * All walks are cycle-safe (the DB forbids parent cycles, but these helpers
 * stay defensive) and run in O(tags + relations) per call.
 */

export type TagHierarchyRelation = Pick<
  TagRelation,
  "from_tag_id" | "to_tag_id" | "relation"
>;

type TagRefLike = Pick<WorkspaceTag, "id" | "slug" | "normalized_name">;

/** `relation: "parent"` means `from_tag_id` is a CHILD of `to_tag_id`. */
function buildAdjacency(
  relations: readonly TagHierarchyRelation[],
  direction: "descendants" | "ancestors",
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.relation !== "parent") continue;
    const [from, to] =
      direction === "descendants"
        ? [relation.to_tag_id, relation.from_tag_id]
        : [relation.from_tag_id, relation.to_tag_id];
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  }
  return adjacency;
}

/** Cycle-safe BFS; returns every reachable id including the seeds. */
function walk(
  seeds: readonly string[],
  adjacency: Map<string, string[]>,
): Set<string> {
  const visited = new Set<string>(seeds);
  const queue = [...visited];
  for (let index = 0; index < queue.length; index++) {
    for (const next of adjacency.get(queue[index]!) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

/**
 * The given tag ids plus every descendant (transitive children via `parent`
 * edges). Use to expand a tag filter so it also matches nodes tagged with a
 * descendant tag.
 */
export function expandTagIdsWithDescendants(
  tagIds: readonly string[],
  relations: readonly TagHierarchyRelation[],
): Set<string> {
  return walk(tagIds, buildAdjacency(relations, "descendants"));
}

/**
 * Every strict ancestor of the given tag ids (transitive parents via
 * `parent` edges). The input ids themselves are excluded, even when a
 * defensive cycle would make them reachable. Use to compute a node's
 * inherited ("effective minus direct") tags.
 */
export function ancestorsOfTags(
  tagIds: readonly string[],
  relations: readonly TagHierarchyRelation[],
): Set<string> {
  const reached = walk(tagIds, buildAdjacency(relations, "ancestors"));
  for (const id of tagIds) reached.delete(id);
  return reached;
}

/**
 * A single requested tag reference, pre-expanded for hierarchy-aware
 * matching: `ids` holds the exact tag ids that satisfy the reference
 * (the referenced tag plus its descendants); `slug` keeps the raw slug
 * fallback for references that do not resolve to a workspace tag, which
 * preserves the historical direct slug/normalized-name match.
 */
export interface TagRefMatcher {
  ids: Set<string>;
  slug?: string;
}

/**
 * Build one matcher per requested tag reference (ids and slugs keep their
 * own identity so `tagsMatch: "all"` still counts each requested tag once).
 * O((ids + slugs) × relations); both sides are small and bounded.
 */
export function buildTagRefMatchers(
  refs: { ids?: readonly string[]; slugs?: readonly string[] },
  tags: readonly TagRefLike[],
  relations: readonly TagHierarchyRelation[],
): TagRefMatcher[] {
  const bySlug = new Map<string, string>();
  for (const tag of tags) {
    bySlug.set(tag.slug, tag.id);
    bySlug.set(tag.normalized_name, tag.id);
  }
  const matchers: TagRefMatcher[] = [];
  for (const id of refs.ids ?? []) {
    matchers.push({ ids: expandTagIdsWithDescendants([id], relations) });
  }
  for (const slug of refs.slugs ?? []) {
    const tagId = bySlug.get(slug);
    matchers.push({
      ids: tagId ? expandTagIdsWithDescendants([tagId], relations) : new Set(),
      slug,
    });
  }
  return matchers;
}

/** Hierarchy-aware `any`/`all` matching of a node's direct tags. */
export function nodeMatchesTagRefMatchers(
  nodeTags: readonly TagRefLike[],
  matchers: readonly TagRefMatcher[],
  match: "any" | "all",
): boolean {
  if (matchers.length === 0) return true;
  const ids = new Set(nodeTags.map((tag) => tag.id));
  const slugs = new Set(
    nodeTags.flatMap((tag) => [tag.slug, tag.normalized_name]),
  );
  for (const matcher of matchers) {
    let hit = matcher.slug !== undefined && slugs.has(matcher.slug);
    if (!hit) {
      for (const id of matcher.ids) {
        if (ids.has(id)) {
          hit = true;
          break;
        }
      }
    }
    if (match === "all" && !hit) return false;
    if (match === "any" && hit) return true;
  }
  return match === "all";
}

/**
 * Pure derivations for BrowseRenderer's tag-hierarchy explorer.
 *
 * The browse view no longer walks `parent_id` — it walks the *tag* hierarchy
 * (`tag_relations`, `relation: "parent"` meaning `from_tag_id` IS A CHILD OF
 * `to_tag_id`, see `@bcontext-dev/contract/tag-hierarchy`). A level shows only:
 *   - the direct child tags of the current tag (root level: tags with no
 *     parent at all), rendered as folder cards, then
 *   - the nodes DIRECTLY tagged with the current tag (never descendants —
 *     server-side tag filters inherit downward, so this must be computed
 *     from each node's own direct `tags` array, not a query result).
 *
 * `usage_count` (from `GET /api/tags`) is each tag's direct assignment
 * count — exactly the badge a folder card wants, no extra derivation.
 */

import type { KnowledgeNode, TagRelation, WorkspaceTag } from "@bcontext-dev/contract/types";

export interface TagWithUsage extends WorkspaceTag {
  usage_count: number;
}

export type TagHierarchyRelation = Pick<TagRelation, "from_tag_id" | "to_tag_id" | "relation">;

function isActiveTag(tag: WorkspaceTag): boolean {
  return tag.deleted_at === null && tag.merged_into_id === null;
}

/** Root tags: active tags that are not a `from_tag_id` in any `parent` row. */
export function rootTags(tags: readonly TagWithUsage[], relations: readonly TagHierarchyRelation[]): TagWithUsage[] {
  const hasParent = new Set(
    relations.filter((r) => r.relation === "parent").map((r) => r.from_tag_id),
  );
  return tags.filter((tag) => isActiveTag(tag) && !hasParent.has(tag.id));
}

/** Direct child tags of `tagId` (tags whose `parent` row points `to_tag_id === tagId`). */
export function childTagsOf(
  tagId: string,
  tags: readonly TagWithUsage[],
  relations: readonly TagHierarchyRelation[],
): TagWithUsage[] {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const childIds = relations
    .filter((r) => r.relation === "parent" && r.to_tag_id === tagId)
    .map((r) => r.from_tag_id);
  const children: TagWithUsage[] = [];
  for (const id of childIds) {
    const tag = tagsById.get(id);
    if (tag && isActiveTag(tag)) children.push(tag);
  }
  return children;
}

/** Nodes directly tagged with `tagId` — excludes descendant-tag matches. */
export function nodesDirectlyTagged(nodes: readonly KnowledgeNode[], tagId: string): KnowledgeNode[] {
  return nodes.filter((node) => node.tags.some((tag) => tag.id === tagId));
}

/** Nodes with zero direct tags — surfaced under the "Untagged" bucket. */
export function untaggedNodes(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  return nodes.filter((node) => node.tags.length === 0);
}

function bySlugThenName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/** Folder-card order: by slug, then name — stable across renders and re-fetches. */
export function sortTags(tags: readonly TagWithUsage[]): TagWithUsage[] {
  return [...tags].sort(bySlugThenName);
}

/** The person's own `position` order first, title as the tie-break. */
export function sortNodes(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  return [...nodes].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}

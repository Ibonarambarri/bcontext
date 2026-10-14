/**
 * Storage adapter over the in-memory `demo-store`. Methods are async to
 * satisfy the interface, but operations resolve synchronously.
 */
import {
  type KnowledgeNode,
  type NodeSummary,
  type TagRelation,
  type Workspace,
  type WorkspaceTag,
} from "@bcontext-dev/contract/types";
import {
  DEFAULT_WORKSPACE_TAGS,
  normalizeTagName,
  normalizeTagNames,
  tagSlugBase,
} from "@bcontext-dev/contract/tags";
import { nodeSubtaskProgress } from "@bcontext-dev/contract/subtasks";
import { afterNodeWrite } from "@/lib/nexo/after-write";
import { buildTagRefMatchers, nodeMatchesTagRefMatchers } from "@bcontext-dev/contract/tag-hierarchy";
import {
  createNode as demoCreate,
  demoSeedTag,
  deleteNode as demoDelete,
  getNode as demoGetNode,
  getWorkspace as demoGetWorkspace,
  listNodes as demoListNodes,
  listWorkspaces as demoListWorkspaces,
  updateNode as demoUpdate,
} from "@/lib/demo-store";
import {
  assertNoTagRelationCycle,
  ConflictError,
  assertNodeDataContract,
  assertSemanticParent,
  type CreateNodeInput,
  type CreateTagInput,
  type NodeEdge,
  type Storage,
  TagConflictError,
  TagNotFoundError,
  TagRelationError,
  type TagRelationInput,
  type TagRelationTarget,
  type UpdateNodeOpts,
  type UpdateNodePatch,
  type UpdateTagInput,
} from "./index";

// Module-level edge store, same lifetime semantics as demo-store's node
// maps (per server process, resets on restart). Keyed by workspace slug.
const demoEdges = new Map<string, NodeEdge[]>();
const demoTags = new Map<string, WorkspaceTag[]>();
const demoTagAliases = new Map<string, Map<string, string>>();
const demoTagRelations = new Map<string, TagRelation[]>();
let demoTagCounter = 0;
let demoTagRelationCounter = 0;

class DemoStorage implements Storage {
  readonly backend = "demo" as const;
  constructor(public readonly workspace: Workspace) {}

  async listNodes(opts?: Parameters<Storage["listNodes"]>[0]): Promise<KnowledgeNode[]> {
    const taxonomy = ensureDemoTaxonomy(this.workspace);
    const all = demoListNodes(this.workspace.slug);
    const nodes = opts?.kinds?.length
      ? all.filter((node) => opts.kinds!.includes(node.kind))
      : all;
    const wantedIds = new Set(opts?.tagIds ?? []);
    const wantedSlugs = new Set<string>();
    const aliases = demoTagAliases.get(this.workspace.slug) ?? new Map();
    for (const value of normalizeTagNames(opts?.tagSlugs ?? [])) {
      const target = aliases.get(value);
      if (target) wantedIds.add(target);
      else wantedSlugs.add(value);
    }
    if (wantedIds.size + wantedSlugs.size === 0) {
      return nodes.slice(0, opts?.limit ?? nodes.length);
    }
    // Tag filters inherit through the hierarchy: a requested tag also
    // matches nodes tagged with any of its descendants (node_tags stays
    // direct-only; expansion happens at query time from tag_relations).
    const matchers = buildTagRefMatchers(
      { ids: [...wantedIds], slugs: [...wantedSlugs] },
      taxonomy.filter((tag) => !tag.deleted_at && !tag.merged_into_id),
      demoTagRelations.get(this.workspace.slug) ?? [],
    );
    const match = opts?.tagsMatch === "all" ? "all" : "any";
    const filtered = nodes.filter((node) => nodeMatchesTagRefMatchers(node.tags, matchers, match));
    return filtered.slice(0, opts?.limit ?? filtered.length);
  }

  async listNodeSummaries(opts?: Parameters<Storage["listNodeSummaries"]>[0]): Promise<NodeSummary[]> {
    return (await this.listNodes(opts)).map(toSummary);
  }

  async listNodeContext(id: string, limit = 200): Promise<KnowledgeNode[]> {
    const nodes = await this.listNodes({ limit: 5000 });
    const edges = await this.listEdges();
    const touching = new Set([id]);
    for (const edge of edges) {
      if (edge.from_node === id || edge.to_node === id) {
        touching.add(edge.from_node);
        touching.add(edge.to_node);
      }
    }
    // Demo workspaces are intentionally tiny; keep the same correctness as
    // production while still honoring the public bound.
    return nodes.filter((node) => touching.has(node.id) || node.content_md.includes(id)).slice(0, limit);
  }

  async countTagUsage(): Promise<Map<string, number>> {
    const usage = new Map<string, number>();
    for (const node of await this.listNodeSummaries({ limit: 5000 })) {
      for (const tag of node.tags) usage.set(tag.id, (usage.get(tag.id) ?? 0) + 1);
    }
    return usage;
  }

  async getNode(id: string): Promise<KnowledgeNode | null> {
    ensureDemoTaxonomy(this.workspace);
    return demoGetNode(this.workspace.slug, id);
  }

  async createNode(input: CreateNodeInput): Promise<KnowledgeNode> {
    assertNodeDataContract(input.data);
    if (input.tag_ids !== undefined) this.assertActiveTagIds(input.tag_ids);
    assertSemanticParent(
      demoListNodes(this.workspace.slug),
      this.workspace.id,
      input.parent_id,
    );
    const created = demoCreate(this.workspace.slug, {
      title: input.title,
      kind: input.kind,
      parent_id: input.parent_id,
      content_md: input.content_md ?? "",
      data: input.data ?? {},
      status: (input.status ?? null) as never,
      priority: input.priority ?? null,
      due_date: input.due_date ?? null,
      slug: input.slug,
    });
    const node = input.tag_ids === undefined ? created : await this.setNodeTags(created.id, input.tag_ids);
    afterNodeWrite(this, node, { created: true, contentChanged: true });
    return node;
  }

  async updateNode(
    id: string,
    patch: UpdateNodePatch,
    opts?: UpdateNodeOpts,
  ): Promise<KnowledgeNode | null> {
    // The demo store is synchronous single-process memory, so pre-checks
    // here ARE atomic (no await between check and write).
    const current = demoGetNode(this.workspace.slug, id);
    if (!current) return null;
    if ("data" in patch) assertNodeDataContract(patch.data);
    if ("parent_id" in patch && patch.parent_id !== current.parent_id) {
      assertSemanticParent(
        demoListNodes(this.workspace.slug),
        this.workspace.id,
        patch.parent_id ?? null,
        current.id,
      );
    }
    // Presence check, NOT truthiness — see SupabaseStorage.
    if (opts?.ifUpdatedAt !== undefined && current.updated_at !== opts.ifUpdatedAt) {
      throw new ConflictError(id, current.updated_at, opts.ifUpdatedAt);
    }
    // No-op writes must not bump updated_at (mirrors SupabaseStorage) —
    // a phantom bump manufactures spurious 409s for guarded editors.
    const changed = Object.entries(patch).some(([k, v]) =>
      k === "data" ? v !== undefined : v !== current[k as keyof KnowledgeNode],
    );
    if (!changed) return current;
    const { tag_ids, ...rawNodePatch } = patch;
    const nodePatch = { ...rawNodePatch };
    const updated = Object.keys(nodePatch).length > 0
      ? demoUpdate(this.workspace.slug, id, nodePatch)
      : current;
    if (!updated) return null;
    const next = tag_ids !== undefined ? await this.setNodeTags(id, tag_ids) : updated;
    afterNodeWrite(this, next, {
      created: false,
      contentChanged: typeof patch.title === "string" || typeof patch.content_md === "string",
    });
    return next;
  }

  async deleteNode(id: string): Promise<boolean> {
    const current = demoGetNode(this.workspace.slug, id);
    if (!current) return false;
    const ok = demoDelete(this.workspace.slug, id);
    // Mirror the Postgres ON DELETE CASCADE on edges.
    const edges = demoEdges.get(this.workspace.slug);
    if (ok && edges) {
      demoEdges.set(
        this.workspace.slug,
        edges.filter((e) => e.from_node !== id && e.to_node !== id),
      );
    }
    return ok;
  }

  async listTags(opts?: { includeInactive?: boolean }): Promise<WorkspaceTag[]> {
    const tags = ensureDemoTaxonomy(this.workspace);
    return tags
      .filter((tag) => opts?.includeInactive || (!tag.deleted_at && !tag.merged_into_id))
      .sort((a, b) => a.normalized_name.localeCompare(b.normalized_name));
  }

  async getTag(id: string): Promise<WorkspaceTag | null> {
    return ensureDemoTaxonomy(this.workspace).find((tag) => tag.id === id) ?? null;
  }

  async resolveTagIds(names: string[]): Promise<Map<string, string>> {
    const requested = normalizeTagNames(names);
    const active = ensureDemoTaxonomy(this.workspace).filter(
      (tag) => !tag.deleted_at && !tag.merged_into_id,
    );
    const activeIds = new Set(active.map((tag) => tag.id));
    const lookup = new Map<string, string>();
    for (const tag of active) {
      lookup.set(tag.normalized_name, tag.id);
      lookup.set(tag.slug, tag.id);
    }
    for (const [alias, tagId] of demoTagAliases.get(this.workspace.slug) ?? []) {
      if (activeIds.has(tagId)) lookup.set(alias, tagId);
    }
    return new Map(
      requested
        .map((name) => [name, lookup.get(name)] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    );
  }

  async createTag(input: CreateTagInput): Promise<WorkspaceTag> {
    const tags = ensureDemoTaxonomy(this.workspace);
    const normalized = normalizeTagName(input.name);
    if (!normalized) throw new TagConflictError("duplicate", "tag name is required");
    const aliases = demoTagAliases.get(this.workspace.slug) ?? new Map();
    if (aliases.has(normalized)) {
      throw new TagConflictError("alias_conflict", `tag conflicts with an existing alias: ${input.name}`);
    }
    if (tags.some((tag) => !tag.deleted_at && !tag.merged_into_id && tag.normalized_name === normalized)) {
      throw new TagConflictError("duplicate", `tag already exists: ${input.name}`);
    }
    const now = new Date().toISOString();
    const base = tagSlugBase(input.name);
    let slug = base;
    let suffix = 1;
    while (tags.some((tag) => !tag.deleted_at && tag.slug === slug)) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    demoTagCounter += 1;
    const tag: WorkspaceTag = {
      id: `demo-tag-${demoTagCounter}-${slug}`,
      workspace_id: this.workspace.id,
      name: input.name.trim().replace(/\s+/g, " "),
      normalized_name: normalized,
      slug,
      description: input.description?.trim() || null,
      merged_into_id: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    tags.push(tag);
    demoTags.set(this.workspace.slug, tags);
    return tag;
  }

  async updateTag(id: string, input: UpdateTagInput): Promise<WorkspaceTag> {
    const tags = ensureDemoTaxonomy(this.workspace);
    const tag = tags.find((candidate) => candidate.id === id && !candidate.deleted_at && !candidate.merged_into_id);
    if (!tag) throw new TagNotFoundError(id);
    const name = input.name ?? tag.name;
    const normalized = normalizeTagName(name);
    const aliases = demoTagAliases.get(this.workspace.slug) ?? new Map();
    const duplicate = tags.some(
      (candidate) => candidate.id !== id && !candidate.deleted_at && !candidate.merged_into_id && candidate.normalized_name === normalized,
    );
    if (duplicate || (aliases.has(normalized) && aliases.get(normalized) !== id)) {
      throw new TagConflictError("duplicate", `tag already exists: ${name}`);
    }
    if (normalized !== tag.normalized_name) {
      aliases.set(tag.normalized_name, id);
      aliases.set(tag.slug, id);
    }
    demoTagAliases.set(this.workspace.slug, aliases);
    tag.name = name.trim().replace(/\s+/g, " ");
    tag.normalized_name = normalized;
    tag.slug = uniqueDemoTagSlug(tags, name, id);
    // Omitted keeps, null clears — same contract as the Supabase RPC path.
    if (input.description !== undefined) tag.description = input.description?.trim() || null;
    tag.updated_at = new Date().toISOString();
    this.resyncAssignedNodes(id);
    return tag;
  }

  async mergeTags(sourceId: string, targetId: string): Promise<WorkspaceTag> {
    if (sourceId === targetId) {
      throw new TagConflictError("duplicate", "cannot merge a tag into itself");
    }
    const tags = ensureDemoTaxonomy(this.workspace);
    const source = tags.find((tag) => tag.id === sourceId && !tag.deleted_at && !tag.merged_into_id);
    const target = tags.find((tag) => tag.id === targetId && !tag.deleted_at && !tag.merged_into_id);
    if (!source) throw new TagNotFoundError(sourceId);
    if (!target) throw new TagNotFoundError(targetId);
    const aliases = demoTagAliases.get(this.workspace.slug) ?? new Map();
    aliases.set(source.normalized_name, target.id);
    aliases.set(source.slug, target.id);
    for (const [alias, tagId] of aliases) {
      if (tagId === source.id) aliases.set(alias, target.id);
    }
    demoTagAliases.set(this.workspace.slug, aliases);
    source.merged_into_id = target.id;
    source.deleted_at = new Date().toISOString();
    source.updated_at = source.deleted_at;
    for (const node of demoListNodes(this.workspace.slug)) {
      const ids = node.tags.map((tag) => tag.id);
      if (!ids.includes(source.id)) continue;
      const next = Array.from(new Set(ids.map((id) => id === source.id ? target.id : id)));
      this.applyNodeTagIds(node, next);
    }
    // Repoint tag_relations edges from source onto target, dropping any
    // edge the repoint turns into a self-loop or a duplicate of an edge the
    // target already has.
    const relations = demoTagRelations.get(this.workspace.slug) ?? [];
    const seenKeys = new Set<string>();
    const nextRelations: TagRelation[] = [];
    for (const rel of relations) {
      const from = rel.from_tag_id === source.id ? target.id : rel.from_tag_id;
      const to = rel.to_tag_id === source.id ? target.id : rel.to_tag_id;
      if (from === to) continue;
      const key = `${from}:${to}:${rel.relation}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      nextRelations.push({ ...rel, from_tag_id: from, to_tag_id: to });
    }
    demoTagRelations.set(this.workspace.slug, nextRelations);
    return target;
  }

  async deleteTag(id: string): Promise<boolean> {
    const tag = ensureDemoTaxonomy(this.workspace).find(
      (candidate) => candidate.id === id && !candidate.deleted_at && !candidate.merged_into_id,
    );
    if (!tag) return false;
    tag.deleted_at = new Date().toISOString();
    tag.updated_at = tag.deleted_at;
    const aliases = demoTagAliases.get(this.workspace.slug);
    if (aliases) {
      for (const [alias, tagId] of aliases) if (tagId === id) aliases.delete(alias);
    }
    for (const node of demoListNodes(this.workspace.slug)) {
      if (node.tags.some((assigned) => assigned.id === id)) {
        this.applyNodeTagIds(node, node.tags.filter((assigned) => assigned.id !== id).map((assigned) => assigned.id));
      }
    }
    // Tags are soft-deleted (deleted_at), so mirror the Postgres
    // delete_workspace_tag cleanup explicitly instead of relying on a FK
    // cascade that only fires on a real row delete.
    const relations = demoTagRelations.get(this.workspace.slug);
    if (relations) {
      demoTagRelations.set(
        this.workspace.slug,
        relations.filter((r) => r.from_tag_id !== id && r.to_tag_id !== id),
      );
    }
    return true;
  }

  async setNodeTags(nodeId: string, tagIds: string[]): Promise<KnowledgeNode> {
    this.assertActiveTagIds(tagIds);
    const node = demoGetNode(this.workspace.slug, nodeId);
    if (!node) throw new Error(`node not found: ${nodeId}`);
    return this.applyNodeTagIds(node, Array.from(new Set(tagIds)));
  }

  private assertActiveTagIds(tagIds: string[]): void {
    const tags = ensureDemoTaxonomy(this.workspace);
    for (const id of new Set(tagIds)) {
      if (!tags.some((tag) => tag.id === id && !tag.deleted_at && !tag.merged_into_id)) {
        throw new TagNotFoundError(id);
      }
    }
  }

  async listTagRelations(): Promise<TagRelation[]> {
    return [...(demoTagRelations.get(this.workspace.slug) ?? [])];
  }

  async createTagRelations(
    fromTagId: string,
    input: TagRelationInput,
  ): Promise<TagRelation[]> {
    this.assertActiveTagIds([
      fromTagId,
      ...(input.parent_ids ?? []),
      ...(input.related_ids ?? []),
    ]);
    const relations = demoTagRelations.get(this.workspace.slug) ?? [];
    const created: TagRelation[] = [];
    const now = new Date().toISOString();

    for (const parentId of input.parent_ids ?? []) {
      if (parentId === fromTagId) {
        throw new TagRelationError("self", "a tag cannot be its own parent");
      }
      const exists = relations.some(
        (r) => r.from_tag_id === fromTagId && r.to_tag_id === parentId && r.relation === "parent",
      );
      if (exists) continue;
      assertNoTagRelationCycle(relations, fromTagId, parentId);
      demoTagRelationCounter += 1;
      const relation: TagRelation = {
        id: `demo-tag-relation-${demoTagRelationCounter}`,
        workspace_id: this.workspace.id,
        from_tag_id: fromTagId,
        to_tag_id: parentId,
        relation: "parent",
        created_at: now,
      };
      relations.push(relation);
      created.push(relation);
    }

    for (const relatedId of input.related_ids ?? []) {
      if (relatedId === fromTagId) {
        throw new TagRelationError("self", "a tag cannot relate to itself");
      }
      const exists = relations.some(
        (r) =>
          r.relation === "related" &&
          ((r.from_tag_id === fromTagId && r.to_tag_id === relatedId) ||
            (r.from_tag_id === relatedId && r.to_tag_id === fromTagId)),
      );
      if (exists) continue;
      demoTagRelationCounter += 1;
      const relation: TagRelation = {
        id: `demo-tag-relation-${demoTagRelationCounter}`,
        workspace_id: this.workspace.id,
        from_tag_id: fromTagId,
        to_tag_id: relatedId,
        relation: "related",
        created_at: now,
      };
      relations.push(relation);
      created.push(relation);
    }

    demoTagRelations.set(this.workspace.slug, relations);
    return created;
  }

  async deleteTagRelation(target: TagRelationTarget): Promise<boolean> {
    const relations = demoTagRelations.get(this.workspace.slug) ?? [];
    let removed = false;
    const next = relations.filter((r) => {
      const match =
        "id" in target
          ? r.id === target.id
          : r.relation === target.relation &&
            (target.relation === "related"
              ? (r.from_tag_id === target.fromTagId && r.to_tag_id === target.toTagId) ||
                (r.from_tag_id === target.toTagId && r.to_tag_id === target.fromTagId)
              : r.from_tag_id === target.fromTagId && r.to_tag_id === target.toTagId);
      if (match) removed = true;
      return !match;
    });
    demoTagRelations.set(this.workspace.slug, next);
    return removed;
  }

  private applyNodeTagIds(node: KnowledgeNode, tagIds: string[]): KnowledgeNode {
    const tags = ensureDemoTaxonomy(this.workspace).filter(
      (tag) => tagIds.includes(tag.id) && !tag.deleted_at && !tag.merged_into_id,
    );
    return demoUpdate(this.workspace.slug, node.id, {
      tags,
    })!;
  }

  private resyncAssignedNodes(tagId: string): void {
    for (const node of demoListNodes(this.workspace.slug)) {
      if (node.tags.some((tag) => tag.id === tagId)) {
        this.applyNodeTagIds(node, node.tags.map((tag) => tag.id));
      }
    }
  }

  async listEdges(): Promise<NodeEdge[]> {
    return [...(demoEdges.get(this.workspace.slug) ?? [])];
  }

  async createEdge(edge: NodeEdge): Promise<NodeEdge> {
    for (const id of [edge.from_node, edge.to_node]) {
      if (!demoGetNode(this.workspace.slug, id)) {
        throw new Error(`createEdge: node not found: ${id}`);
      }
    }
    const edges = demoEdges.get(this.workspace.slug) ?? [];
    const exists = edges.some(
      (e) =>
        e.from_node === edge.from_node &&
        e.to_node === edge.to_node &&
        e.relation === edge.relation,
    );
    if (!exists) {
      edges.push({ ...edge });
      demoEdges.set(this.workspace.slug, edges);
    }
    return edge;
  }

  async deleteEdge(edge: NodeEdge): Promise<boolean> {
    const edges = demoEdges.get(this.workspace.slug) ?? [];
    const next = edges.filter(
      (e) =>
        !(
          e.from_node === edge.from_node &&
          e.to_node === edge.to_node &&
          e.relation === edge.relation
        ),
    );
    demoEdges.set(this.workspace.slug, next);
    return next.length < edges.length;
  }
}

function toSummary(node: KnowledgeNode): NodeSummary {
  const source = typeof node.data?.source === "string" ? node.data.source : null;
  return {
    ...node,
    content_md: "",
    data: source ? { source } : {},
    source,
    subtasks: nodeSubtaskProgress({ data: node.data }),
  };
}

export function resolveDemoStorage(workspaceSlug: string): Storage | null {
  const ws = demoGetWorkspace(workspaceSlug);
  if (!ws) return null;
  return new DemoStorage(ws);
}

/**
 * Resolve by workspace UUID — seeded demo workspaces have fixed ids, so
 * id-addressed API routes (e.g. the Review board's ingest candidates)
 * work in demo mode too.
 */
export function resolveDemoStorageById(workspaceId: string): Storage | null {
  const ws = demoListWorkspaces().find((w) => w.id === workspaceId);
  if (!ws) return null;
  return new DemoStorage(ws);
}

function ensureDemoTaxonomy(workspace: Workspace): WorkspaceTag[] {
  const existing = demoTags.get(workspace.slug);
  if (existing) return existing;
  const seeded = DEFAULT_WORKSPACE_TAGS.map((normalized) =>
    demoSeedTag(workspace.id, normalized),
  );
  demoTags.set(workspace.slug, seeded);
  demoTagAliases.set(workspace.slug, new Map());
  return seeded;
}

function uniqueDemoTagSlug(tags: WorkspaceTag[], name: string, ignoreId: string): string {
  const base = tagSlugBase(name);
  let candidate = base;
  let suffix = 1;
  while (tags.some((tag) => tag.id !== ignoreId && !tag.deleted_at && tag.slug === candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

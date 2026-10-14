/**
 * Storage adapter over Supabase Postgres using the service-role client.
 *
 * The service-role bypasses RLS. That's safe in this layer because the
 * auth gate has already proved the caller has access to `workspace_id`
 * (either via a workspace-scoped bearer token or a user session whose
 * membership was checked). Every method scopes its query by workspace
 * id explicitly so a wrong-workspace fetch never escapes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { KnowledgeNode, NodeSummary, TagRelation, Workspace, WorkspaceTag } from "@bcontext-dev/contract/types";
import { slugify } from "@bcontext-dev/contract/utils";
import { normalizeTagNames } from "@bcontext-dev/contract/tags";
import { buildTagRefMatchers, nodeMatchesTagRefMatchers } from "@bcontext-dev/contract/tag-hierarchy";
import { scheduleEmbed } from "@/lib/rag/embed";
import { afterNodeWrite } from "@/lib/nexo/after-write";
import { nextPreviousBlockIds } from "@bcontext-dev/contract/rag/chunk";
import {
  assertNoTagRelationCycle,
  ConflictError,
  assertNodeDataContract,
  assertSemanticParent,
  canonicalNodeData,
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

class SupabaseStorage implements Storage {
  readonly backend = "supabase" as const;
  constructor(
    public readonly workspace: Workspace,
    private readonly client: SupabaseClient,
  ) {}

  async listNodes(opts?: Parameters<Storage["listNodes"]>[0]): Promise<KnowledgeNode[]> {
    const limit = Math.max(1, Math.min(5000, opts?.limit ?? 2000));
    // Tag filtering happens after hydration because aliases and any/all
    // semantics span the join table. Fetch the bounded workspace set first,
    // then apply the caller's requested result limit, otherwise matching
    // nodes after the first N positions would disappear.
    const hasTagFilter =
      (opts?.tagIds?.length ?? 0) > 0 || (opts?.tagSlugs?.length ?? 0) > 0;
    const fetchLimit = hasTagFilter ? 5000 : limit;
    const query = this.client
      .from("nodes")
      .select("*")
      .eq("workspace_id", this.workspace.id);
    // Pushed to the database rather than filtered after hydration: the point
    // of asking for one kind is not to load the other 4.999 rows.
    if (opts?.kinds?.length) query.in("kind", opts.kinds);
    const { data, error } = await query
      .order("position", { ascending: true })
      .limit(fetchLimit);
    if (error) throw new Error(`listNodes: ${error.message}`);
    const rows = (data ?? []).map((row) => rowToNode(row));
    const tagsByNode = await this.loadNodeTags(rows.map((node) => node.id));
    const hydrated = rows.map((node) => ({
      ...node,
      tags: tagsByNode.get(node.id) ?? [],
    }));
    const resolvedFilters = await this.resolveTagFilterAliases(opts);
    return filterNodesByTags(hydrated, resolvedFilters, await this.loadTagHierarchyForFilter(resolvedFilters)).slice(0, limit);
  }

  async listNodeSummaries(opts?: Parameters<Storage["listNodeSummaries"]>[0]): Promise<NodeSummary[]> {
    const limit = Math.max(1, Math.min(5000, opts?.limit ?? 2000));
    const { data, error } = await this.client.rpc("list_node_summaries", {
      p_workspace_id: this.workspace.id,
      p_limit: (opts?.tagIds?.length || opts?.tagSlugs?.length) ? 5000 : limit,
    });
    if (error) throw new Error(`listNodeSummaries: ${error.message}`);
    const rows: NodeSummary[] = (data ?? []).map((row: Record<string, unknown>) => rowToSummary(row));
    const resolvedFilters = await this.resolveTagFilterAliases(opts);
    return filterNodesByTags<NodeSummary>(rows, resolvedFilters, await this.loadTagHierarchyForFilter(resolvedFilters)).slice(0, limit);
  }

  async listNodeContext(id: string, limit = 200): Promise<KnowledgeNode[]> {
    const { data, error } = await this.client.rpc("get_node_context_candidates", {
      p_workspace_id: this.workspace.id,
      p_node_id: id,
      p_limit: Math.max(1, Math.min(500, limit)),
    });
    if (error) throw new Error(`listNodeContext: ${error.message}`);
    return (data ?? []).map((row: Record<string, unknown>) => rowToNodeWithTags(row));
  }

  async countTagUsage(): Promise<Map<string, number>> {
    // Preferred: one aggregated row per tag (`count_tag_usage`). Falls back
    // to the raw assignment scan if the function is missing, so an
    // environment behind on migrations degrades instead of failing.
    const { data: aggregated, error: aggregateError } = await this.client.rpc(
      "count_tag_usage",
      { p_workspace_id: this.workspace.id },
    );
    if (!aggregateError) {
      const usage = new Map<string, number>();
      for (const row of (aggregated ?? []) as Array<{ tag_id: string; usage_count: number }>) {
        usage.set(row.tag_id, Number(row.usage_count) || 0);
      }
      return usage;
    }
    const { data, error } = await this.client
      .from("node_tags")
      .select("tag_id")
      .eq("workspace_id", this.workspace.id)
      .limit(10000);
    if (error) throw new Error(`countTagUsage: ${error.message}`);
    const usage = new Map<string, number>();
    for (const row of data ?? []) {
      const id = row.tag_id as string;
      usage.set(id, (usage.get(id) ?? 0) + 1);
    }
    return usage;
  }

  async getNode(id: string): Promise<KnowledgeNode | null> {
    const { data, error } = await this.client
      .from("nodes")
      .select("*")
      .eq("workspace_id", this.workspace.id)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getNode: ${error.message}`);
    if (!data) return null;
    const node = rowToNode(data);
    const tagsByNode = await this.loadNodeTags([node.id]);
    return { ...node, tags: tagsByNode.get(node.id) ?? [] };
  }

  async createNode(input: CreateNodeInput): Promise<KnowledgeNode> {
    assertNodeDataContract(input.data);
    if (input.tag_ids !== undefined) {
      await this.assertActiveTagIds(input.tag_ids);
    }
    if (input.parent_id) {
      assertSemanticParent(
        await this.loadHierarchySnapshot(),
        this.workspace.id,
        input.parent_id,
      );
    }
    const baseSlug = slugify(input.slug ?? input.title);
    const slug = await uniqueSlug(this.client, this.workspace.id, baseSlug);
    const position = await nextPosition(
      this.client,
      this.workspace.id,
      input.parent_id ?? null,
    );

    const { data, error } = await this.client
      .from("nodes")
      .insert({
        workspace_id: this.workspace.id,
        parent_id: input.parent_id,
        kind: input.kind,
        slug,
        title: input.title,
        content_md: input.content_md ?? "",
        data: input.data ?? {},
        status: input.status ?? null,
        priority: input.priority ?? null,
        due_date: input.due_date ?? null,
        position,
      })
      .select("*")
      .single();
    if (error || !data) {
      throw new Error(`createNode: ${error?.message ?? "no row returned"}`);
    }
    let node = await this.getNode(data.id as string);
    if (!node) throw new Error("createNode: created row could not be reloaded");
    if (input.tag_ids !== undefined) {
      node = await this.setNodeTags(node.id, input.tag_ids);
    }
    scheduleEmbed(this.client, node.id);
    afterNodeWrite(this, node, { created: true, contentChanged: true });
    return node;
  }

  async updateNode(
    id: string,
    patch: UpdateNodePatch,
    opts?: UpdateNodeOpts,
  ): Promise<KnowledgeNode | null> {
    if ("data" in patch) assertNodeDataContract(patch.data);
    const current = await this.getNode(id);
    if (!current) return null;
    const tagIds = patch.tag_ids;
    if (tagIds !== undefined) await this.assertActiveTagIds(tagIds);
    if ("parent_id" in patch && patch.parent_id !== current.parent_id) {
      assertSemanticParent(
        await this.loadHierarchySnapshot(),
        this.workspace.id,
        patch.parent_id ?? null,
        current.id,
      );
    }
    // Presence check, NOT truthiness: an empty-string guard must conflict
    // (it never matches a real timestamp), not silently disable the guard.
    if (opts?.ifUpdatedAt !== undefined && current.updated_at !== opts.ifUpdatedAt) {
      throw new ConflictError(id, current.updated_at, opts.ifUpdatedAt);
    }

    // Compute next slug (title rename → regenerate unless caller supplied one).
    let nextSlug = current.slug;
    if (
      typeof patch.title === "string" &&
      patch.title.trim() !== current.title &&
      patch.slug === undefined
    ) {
      const base = slugify(patch.title);
      nextSlug = await uniqueSlug(
        this.client,
        this.workspace.id,
        base,
        current.id,
      );
    } else if (typeof patch.slug === "string") {
      nextSlug = patch.slug;
    }

    let nextData: Record<string, unknown> = patch.data ?? current.data ?? {};
    let dataChanged = patch.data !== undefined;
    if (nextSlug !== current.slug) {
      const prevList = Array.isArray(nextData.previous_slugs)
        ? (nextData.previous_slugs as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      if (!prevList.includes(current.slug)) prevList.push(current.slug);
      nextData = { ...nextData, previous_slugs: prevList };
      dataChanged = true;
    }
    if (
      typeof patch.content_md === "string" &&
      patch.content_md !== current.content_md
    ) {
      const nextPrev = nextPreviousBlockIds(
        current.content_md,
        patch.content_md,
        nextData.previous_block_ids,
      );
      if (nextPrev) {
        nextData = { ...nextData, previous_block_ids: nextPrev };
        dataChanged = true;
      }
    }

    // Only ship fields whose value actually differs. A no-op write (e.g.
    // setting status to the value it already has) must NOT bump updated_at:
    // the trigger fires on any UPDATE, and a phantom bump manufactures
    // spurious 409s for concurrent guarded editors.
    const updatePayload: Record<string, unknown> = {};
    if ("title" in patch && patch.title !== current.title)
      updatePayload.title = patch.title;
    if ("content_md" in patch && patch.content_md !== current.content_md)
      updatePayload.content_md = patch.content_md;
    if ("status" in patch && patch.status !== current.status)
      updatePayload.status = patch.status;
    if ("priority" in patch && patch.priority !== current.priority)
      updatePayload.priority = patch.priority;
    if ("due_date" in patch && patch.due_date !== current.due_date)
      updatePayload.due_date = patch.due_date;
    if ("parent_id" in patch && patch.parent_id !== current.parent_id)
      updatePayload.parent_id = patch.parent_id;
    if ("position" in patch && patch.position !== current.position)
      updatePayload.position = patch.position;
    if (nextSlug !== current.slug) updatePayload.slug = nextSlug;
    if (dataChanged) updatePayload.data = nextData;
    if (Object.keys(updatePayload).length === 0) {
      return tagIds === undefined ? current : this.setNodeTags(id, tagIds);
    }

    let query = this.client
      .from("nodes")
      .update(updatePayload)
      .eq("workspace_id", this.workspace.id)
      .eq("id", id);
    // Re-assert the guard inside the UPDATE itself so a write that lands
    // between our read above and this statement still can't be clobbered.
    if (opts?.ifUpdatedAt !== undefined) query = query.eq("updated_at", opts.ifUpdatedAt);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(`updateNode: ${error.message}`);
    if (!data) {
      if (opts?.ifUpdatedAt !== undefined) {
        const now = await this.getNode(id);
        if (now) throw new ConflictError(id, now.updated_at, opts.ifUpdatedAt);
      }
      return null;
    }
    let next = await this.getNode(data.id as string);
    if (!next) return null;
    if (tagIds !== undefined) next = await this.setNodeTags(id, tagIds);
    // Re-embed only on content-bearing changes to avoid burning Gateway
    // tokens on metadata-only updates like status transitions.
    const contentChanged =
      typeof patch.title === "string" ||
      typeof patch.content_md === "string";
    if (contentChanged) scheduleEmbed(this.client, next.id);
    afterNodeWrite(this, next, { created: false, contentChanged });
    return next;
  }

  async deleteNode(id: string): Promise<boolean> {
    const current = await this.getNode(id);
    if (!current) return false;
    // Precompute the subtree BEFORE the delete: the DB cascade removes the
    // rows silently, and each removed node may own attachment blobs that
    // must not outlive it (publicly-reachable orphans otherwise).
    let subtree: string[] = [id];
    try {
      const { data } = await this.client
        .from("nodes")
        .select("id, parent_id")
        .eq("workspace_id", this.workspace.id)
        .limit(5000);
      const { collectSubtreeIds } = await import("./index");
      subtree = collectSubtreeIds(
        (data ?? []) as Array<{ id: string; parent_id: string | null }>,
        id,
      );
    } catch {
      // Blob cleanup degrades to the root node only — never block the delete.
    }
    // ON DELETE CASCADE on the FK handles descendants.
    const { error } = await this.client
      .from("nodes")
      .delete()
      .eq("workspace_id", this.workspace.id)
      .eq("id", id);
    if (error) throw new Error(`deleteNode: ${error.message}`);
    void import("@/lib/attachments")
      .then(({ cleanupAttachmentsFor }) =>
        cleanupAttachmentsFor(this.workspace.id, subtree),
      )
      .catch(() => {});
    return true;
  }

  async listTags(opts?: { includeInactive?: boolean }): Promise<WorkspaceTag[]> {
    let query = this.client
      .from("tags")
      .select("*")
      .eq("workspace_id", this.workspace.id)
      .order("normalized_name", { ascending: true });
    if (!opts?.includeInactive) {
      query = query.is("deleted_at", null).is("merged_into_id", null);
    }
    const { data, error } = await query.limit(5000);
    if (error) throw new Error(`listTags: ${error.message}`);
    return (data ?? []).map(rowToTag);
  }

  async getTag(id: string): Promise<WorkspaceTag | null> {
    const { data, error } = await this.client
      .from("tags")
      .select("*")
      .eq("workspace_id", this.workspace.id)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getTag: ${error.message}`);
    return data ? rowToTag(data) : null;
  }

  async resolveTagIds(names: string[]): Promise<Map<string, string>> {
    const requested = normalizeTagNames(names);
    if (requested.length === 0) return new Map();
    const active = await this.listTags();
    const activeIds = new Set(active.map((tag) => tag.id));
    const lookup = new Map<string, string>();
    for (const tag of active) {
      lookup.set(tag.normalized_name, tag.id);
      lookup.set(tag.slug, tag.id);
    }
    const { data, error } = await this.client
      .from("tag_aliases")
      .select("tag_id, normalized_name, slug")
      .eq("workspace_id", this.workspace.id)
      .limit(5000);
    if (error) throw new Error(`resolveTagIds: ${error.message}`);
    for (const alias of data ?? []) {
      const tagId = alias.tag_id as string;
      if (!activeIds.has(tagId)) continue;
      lookup.set(alias.normalized_name as string, tagId);
      lookup.set(alias.slug as string, tagId);
    }
    return new Map(
      requested
        .map((name) => [name, lookup.get(name)] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    );
  }

  async createTag(input: CreateTagInput): Promise<WorkspaceTag> {
    const { data, error } = await this.client.rpc("create_workspace_tag", {
      p_workspace_id: this.workspace.id,
      p_name: input.name,
      p_description: input.description ?? null,
      p_created_by: input.created_by ?? null,
    });
    if (error) throwTagError(error, input.name);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("createTag: no row returned");
    const tag = rowToTag(row as Record<string, unknown>);
    return tag;
  }

  async updateTag(id: string, input: UpdateTagInput): Promise<WorkspaceTag> {
    // The RPC writes both columns, so an omitted field is filled from the
    // current row rather than wiped: editing a description must not clear
    // the name and renaming must not clear the description.
    const current = await this.getTag(id);
    if (!current || current.deleted_at || current.merged_into_id) throw new TagNotFoundError(id);
    const name = input.name ?? current.name;
    const description = input.description === undefined ? current.description : input.description;
    const { data, error } = await this.client.rpc("rename_workspace_tag", {
      p_workspace_id: this.workspace.id,
      p_tag_id: id,
      p_name: name,
      p_description: description ?? null,
    });
    if (error) throwTagError(error, name, id);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new TagNotFoundError(id);
    const tag = rowToTag(row as Record<string, unknown>);
    return tag;
  }

  async mergeTags(sourceId: string, targetId: string): Promise<WorkspaceTag> {
    const { data, error } = await this.client.rpc("merge_workspace_tags", {
      p_workspace_id: this.workspace.id,
      p_source_id: sourceId,
      p_target_id: targetId,
    });
    if (error) throwTagError(error, sourceId, sourceId);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new TagNotFoundError(sourceId);
    const tag = rowToTag(row as Record<string, unknown>);
    return tag;
  }

  async deleteTag(id: string): Promise<boolean> {
    const { data, error } = await this.client.rpc("delete_workspace_tag", {
      p_workspace_id: this.workspace.id,
      p_tag_id: id,
    });
    if (error) throwTagError(error, id, id);
    const deleted = Boolean(data);
    return deleted;
  }

  async setNodeTags(nodeId: string, tagIds: string[]): Promise<KnowledgeNode> {
    const uniqueIds = Array.from(new Set(tagIds));
    await this.assertActiveTagIds(uniqueIds);
    const target = await this.getNode(nodeId);
    if (!target) throw new Error(`node not found: ${nodeId}`);
    const { error } = await this.client.rpc("assign_node_tags", {
      p_workspace_id: this.workspace.id,
      p_node_id: nodeId,
      p_tag_ids: uniqueIds,
    });
    if (error) {
      if (error.message.includes("node_not_found")) {
        throw new Error(`node not found: ${nodeId}`);
      }
      if (error.message.includes("unknown_or_inactive_tag")) {
        throw new TagNotFoundError("unknown");
      }
      throw new Error(`setNodeTags: ${error.message}`);
    }
    const node = await this.getNode(nodeId);
    if (!node) throw new Error(`node not found: ${nodeId}`);
    return node;
  }

  async listTagRelations(): Promise<TagRelation[]> {
    const { data, error } = await this.client
      .from("tag_relations")
      .select("*")
      .eq("workspace_id", this.workspace.id)
      .limit(5000);
    if (error) throw new Error(`listTagRelations: ${error.message}`);
    return (data ?? []).map(rowToTagRelation);
  }

  async createTagRelations(
    fromTagId: string,
    input: TagRelationInput,
  ): Promise<TagRelation[]> {
    await this.assertActiveTagIds([
      fromTagId,
      ...(input.parent_ids ?? []),
      ...(input.related_ids ?? []),
    ]);
    // Load the current edge set once; cycle checks and duplicate checks
    // below run against this in-memory snapshot plus the edges we're about
    // to add, so a batch of parent_ids that chains through each other is
    // checked correctly.
    const existing = await this.listTagRelations();
    const rowsToInsert: Array<{
      workspace_id: string;
      from_tag_id: string;
      to_tag_id: string;
      relation: TagRelation["relation"];
    }> = [];

    for (const parentId of input.parent_ids ?? []) {
      if (parentId === fromTagId) {
        throw new TagRelationError("self", "a tag cannot be its own parent");
      }
      const dup = existing.some(
        (r) => r.from_tag_id === fromTagId && r.to_tag_id === parentId && r.relation === "parent",
      );
      if (dup) continue;
      assertNoTagRelationCycle(existing, fromTagId, parentId);
      const row = { workspace_id: this.workspace.id, from_tag_id: fromTagId, to_tag_id: parentId, relation: "parent" as const };
      rowsToInsert.push(row);
      existing.push({ id: "", created_at: "", ...row });
    }
    for (const relatedId of input.related_ids ?? []) {
      if (relatedId === fromTagId) {
        throw new TagRelationError("self", "a tag cannot relate to itself");
      }
      const dup = existing.some(
        (r) =>
          r.relation === "related" &&
          ((r.from_tag_id === fromTagId && r.to_tag_id === relatedId) ||
            (r.from_tag_id === relatedId && r.to_tag_id === fromTagId)),
      );
      if (dup) continue;
      const row = { workspace_id: this.workspace.id, from_tag_id: fromTagId, to_tag_id: relatedId, relation: "related" as const };
      rowsToInsert.push(row);
      existing.push({ id: "", created_at: "", ...row });
    }
    if (rowsToInsert.length === 0) return [];
    const { data, error } = await this.client
      .from("tag_relations")
      .insert(rowsToInsert)
      .select("*");
    if (error) throw new Error(`createTagRelations: ${error.message}`);
    return (data ?? []).map(rowToTagRelation);
  }

  async deleteTagRelation(target: TagRelationTarget): Promise<boolean> {
    if ("id" in target) {
      const { data, error } = await this.client
        .from("tag_relations")
        .delete()
        .eq("workspace_id", this.workspace.id)
        .eq("id", target.id)
        .select("id");
      if (error) throw new Error(`deleteTagRelation: ${error.message}`);
      const deleted = (data ?? []).length > 0;
      return deleted;
    }
    if (target.relation === "related") {
      // A `related` edge is stored as a single row in either direction;
      // try both without building a dynamic filter string from user input.
      const { data: forward, error: forwardError } = await this.client
        .from("tag_relations")
        .delete()
        .eq("workspace_id", this.workspace.id)
        .eq("relation", "related")
        .eq("from_tag_id", target.fromTagId)
        .eq("to_tag_id", target.toTagId)
        .select("id");
      if (forwardError) throw new Error(`deleteTagRelation: ${forwardError.message}`);
      if ((forward ?? []).length > 0) {
        return true;
      }
      const { data: reverse, error: reverseError } = await this.client
        .from("tag_relations")
        .delete()
        .eq("workspace_id", this.workspace.id)
        .eq("relation", "related")
        .eq("from_tag_id", target.toTagId)
        .eq("to_tag_id", target.fromTagId)
        .select("id");
      if (reverseError) throw new Error(`deleteTagRelation: ${reverseError.message}`);
      const deleted = (reverse ?? []).length > 0;
      return deleted;
    }
    const { data, error } = await this.client
      .from("tag_relations")
      .delete()
      .eq("workspace_id", this.workspace.id)
      .eq("relation", target.relation)
      .eq("from_tag_id", target.fromTagId)
      .eq("to_tag_id", target.toTagId)
      .select("id");
    if (error) throw new Error(`deleteTagRelation: ${error.message}`);
    const deleted = (data ?? []).length > 0;
    return deleted;
  }

  private async loadHierarchySnapshot(): Promise<Array<{
    id: string;
    workspace_id: string;
    parent_id: string | null;
    kind: KnowledgeNode["kind"];
  }>> {
    const { data, error } = await this.client
      .from("nodes")
      .select("id, workspace_id, parent_id")
      .eq("workspace_id", this.workspace.id)
      .limit(5000);
    if (error) throw new Error(`validateParent: ${error.message}`);
    return (data ?? []) as Array<{
      id: string;
      workspace_id: string;
      parent_id: string | null;
      kind: KnowledgeNode["kind"];
    }>;
  }

  private async assertActiveTagIds(tagIds: string[]): Promise<void> {
    const uniqueIds = Array.from(new Set(tagIds));
    if (uniqueIds.length === 0) return;
    const { data, error } = await this.client
      .from("tags")
      .select("id")
      .eq("workspace_id", this.workspace.id)
      .is("deleted_at", null)
      .is("merged_into_id", null)
      .in("id", uniqueIds);
    if (error) throw new Error(`validateTags: ${error.message}`);
    const valid = new Set((data ?? []).map((row) => row.id as string));
    const missing = uniqueIds.find((id) => !valid.has(id));
    if (missing) throw new TagNotFoundError(missing);
  }

  private async loadNodeTags(
    nodeIds: string[],
  ): Promise<Map<string, WorkspaceTag[]>> {
    const out = new Map<string, WorkspaceTag[]>();
    if (nodeIds.length === 0) return out;
    const assignments: Array<{ node_id: string; tag_id: string }> = [];
    for (const chunk of chunks(nodeIds, 200)) {
      const { data, error } = await this.client
        .from("node_tags")
        .select("node_id, tag_id")
        .eq("workspace_id", this.workspace.id)
        .in("node_id", chunk)
        .limit(10000);
      if (error) throw new Error(`loadNodeTags: ${error.message}`);
      assignments.push(...((data ?? []) as Array<{ node_id: string; tag_id: string }>));
    }
    const tagIds = Array.from(
      new Set(assignments.map((row) => row.tag_id)),
    );
    if (tagIds.length === 0) return out;
    const tagRows: Record<string, unknown>[] = [];
    for (const chunk of chunks(tagIds, 200)) {
      const { data, error } = await this.client
        .from("tags")
        .select("*")
        .eq("workspace_id", this.workspace.id)
        .is("deleted_at", null)
        .is("merged_into_id", null)
        .in("id", chunk)
        .limit(5000);
      if (error) throw new Error(`loadNodeTags: ${error.message}`);
      tagRows.push(...((data ?? []) as Record<string, unknown>[]));
    }
    const byTag = new Map(
      tagRows.map((row) => {
        const tag = rowToTag(row);
        return [tag.id, tag] as const;
      }),
    );
    for (const assignment of assignments) {
      const tag = byTag.get(assignment.tag_id);
      if (!tag) continue;
      const nodeId = assignment.node_id;
      const list = out.get(nodeId) ?? [];
      list.push(tag);
      out.set(nodeId, list);
    }
    for (const list of out.values()) {
      list.sort((a, b) => a.normalized_name.localeCompare(b.normalized_name));
    }
    return out;
  }

  private async resolveTagFilterAliases(opts?: {
    tagIds?: string[];
    tagSlugs?: string[];
    tagsMatch?: "any" | "all";
  }): Promise<{
    tagIds?: string[];
    tagSlugs?: string[];
    tagsMatch?: "any" | "all";
  } | undefined> {
    const requested = normalizeTagNames(opts?.tagSlugs ?? []);
    if (requested.length === 0) return opts;
    const { data, error } = await this.client
      .from("tag_aliases")
      .select("tag_id, normalized_name, slug")
      .eq("workspace_id", this.workspace.id)
      .limit(5000);
    if (error) throw new Error(`resolveTagAliases: ${error.message}`);
    const aliases = new Map<string, string>();
    for (const row of data ?? []) {
      aliases.set(row.normalized_name as string, row.tag_id as string);
      aliases.set(row.slug as string, row.tag_id as string);
    }
    const resolvedIds = new Set(opts?.tagIds ?? []);
    const unresolvedSlugs: string[] = [];
    for (const value of requested) {
      const tagId = aliases.get(value);
      if (tagId) resolvedIds.add(tagId);
      else unresolvedSlugs.push(value);
    }
    return {
      ...opts,
      tagIds: Array.from(resolvedIds),
      tagSlugs: unresolvedSlugs,
    };
  }

  /**
   * Taxonomy + tag_relations for hierarchy-aware tag filtering. Loaded only
   * when a tag filter is actually present (two bounded workspace queries);
   * expansion itself stays in memory — node_tags is never materialized.
   */
  private async loadTagHierarchyForFilter(opts?: {
    tagIds?: string[];
    tagSlugs?: string[];
  }): Promise<TagFilterHierarchy | undefined> {
    if ((opts?.tagIds?.length ?? 0) === 0 && (opts?.tagSlugs?.length ?? 0) === 0) return undefined;
    const [tags, relations] = await Promise.all([this.listTags(), this.listTagRelations()]);
    return { tags, relations };
  }

  async listEdges(): Promise<NodeEdge[]> {
    const { data, error } = await this.client
      .from("edges")
      .select("from_node, to_node, relation")
      .eq("workspace_id", this.workspace.id)
      .limit(5000);
    if (error) throw new Error(`listEdges: ${error.message}`);
    return (data ?? []) as NodeEdge[];
  }

  async createEdge(edge: NodeEdge): Promise<NodeEdge> {
    // Both endpoints must live in this workspace — the FK alone would
    // accept a node from another tenant.
    const { data: endpoints, error: epErr } = await this.client
      .from("nodes")
      .select("id")
      .eq("workspace_id", this.workspace.id)
      .in("id", [edge.from_node, edge.to_node]);
    if (epErr) throw new Error(`createEdge: ${epErr.message}`);
    const found = new Set((endpoints ?? []).map((r) => r.id as string));
    for (const id of [edge.from_node, edge.to_node]) {
      if (!found.has(id)) throw new Error(`createEdge: node not found: ${id}`);
    }
    const { error } = await this.client.from("edges").upsert(
      {
        workspace_id: this.workspace.id,
        from_node: edge.from_node,
        to_node: edge.to_node,
        relation: edge.relation,
      },
      { onConflict: "from_node,to_node,relation", ignoreDuplicates: true },
    );
    if (error) throw new Error(`createEdge: ${error.message}`);
    return edge;
  }

  async deleteEdge(edge: NodeEdge): Promise<boolean> {
    const { data, error } = await this.client
      .from("edges")
      .delete()
      .eq("workspace_id", this.workspace.id)
      .eq("from_node", edge.from_node)
      .eq("to_node", edge.to_node)
      .eq("relation", edge.relation)
      .select("id");
    if (error) throw new Error(`deleteEdge: ${error.message}`);
    return (data ?? []).length > 0;
  }
}

async function nextPosition(
  client: SupabaseClient,
  workspaceId: string,
  parentId: string | null,
): Promise<number> {
  const query = client
    .from("nodes")
    .select("position")
    .eq("workspace_id", workspaceId)
    .order("position", { ascending: false })
    .limit(1);
  const { data } = parentId
    ? await query.eq("parent_id", parentId)
    : await query.is("parent_id", null);
  return ((data?.[0]?.position as number | undefined) ?? 0) + 1;
}

async function uniqueSlug(
  client: SupabaseClient,
  workspaceId: string,
  base: string,
  ignoreId?: string,
): Promise<string> {
  // Fetch only slugs that could collide (the stem itself or `stem-N`).
  // A full-table read silently truncates at PostgREST's row cap (1000 by
  // default) past which duplicate slugs would violate the unique index.
  // slugify output is [a-z0-9-], so interpolating into the .or() filter
  // is safe.
  const stem0 = base || "node";
  const { data } = await client
    .from("nodes")
    .select("id, slug")
    .eq("workspace_id", workspaceId)
    .or(`slug.eq.${stem0},slug.like.${stem0}-%`)
    .limit(2000);
  const taken = new Set(
    (data ?? [])
      .filter((row) => row.id !== ignoreId)
      .map((row) => row.slug as string),
  );
  const stem = base || "node";
  if (!taken.has(stem)) return stem;
  for (let i = 2; i <= 999; i++) {
    const candidate = `${stem}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

function rowToNode(row: Record<string, unknown>): KnowledgeNode {
  // Tag assignments are hydrated from `node_tags`; `data` must never carry a
  // `tags` key, or a caller that spreads a fetched node.data back into an
  // update would trip the database's data-contract guard (migration 0045).
  const data = canonicalNodeData(row.data);
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    parent_id: (row.parent_id as string | null) ?? null,
    kind: row.kind as KnowledgeNode["kind"],
    slug: row.slug as string,
    title: row.title as string,
    content_md: (row.content_md as string) ?? "",
    data,
    tags: [],
    status: (row.status as KnowledgeNode["status"]) ?? null,
    priority: (row.priority as KnowledgeNode["priority"]) ?? null,
    assignee_id: (row.assignee_id as string | null) ?? null,
    due_date: (row.due_date as string | null) ?? null,
    position: (row.position as number) ?? 0,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowTags(row: Record<string, unknown>): WorkspaceTag[] {
  return Array.isArray(row.tags)
    ? row.tags.filter((tag): tag is Record<string, unknown> => Boolean(tag && typeof tag === "object")).map(rowToTag)
    : [];
}

function rowToSummary(row: Record<string, unknown>): NodeSummary {
  const source = typeof row.source === "string" ? row.source : null;
  // Counts arrive from list_node_summaries (0078); an older function without
  // the columns reads as "no subtasks" rather than as a crash.
  const total = typeof row.subtasks_total === "number" ? row.subtasks_total : null;
  const done = typeof row.subtasks_done === "number" ? row.subtasks_done : 0;
  return {
    ...rowToNode({ ...row, content_md: "", data: source ? { source } : {} }),
    content_md: "",
    data: source ? { source } : {},
    tags: rowTags(row),
    source,
    subtasks: total !== null && total > 0 ? { done, total } : null,
  };
}

function rowToNodeWithTags(row: Record<string, unknown>): KnowledgeNode {
  return { ...rowToNode(row), tags: rowTags(row) };
}

function rowToTag(row: Record<string, unknown>): WorkspaceTag {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    name: row.name as string,
    normalized_name: row.normalized_name as string,
    slug: row.slug as string,
    description: (row.description as string | null) ?? null,
    merged_into_id: (row.merged_into_id as string | null) ?? null,
    deleted_at: (row.deleted_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToTagRelation(row: Record<string, unknown>): TagRelation {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    from_tag_id: row.from_tag_id as string,
    to_tag_id: row.to_tag_id as string,
    relation: row.relation as TagRelation["relation"],
    created_at: row.created_at as string,
  };
}

interface TagFilterHierarchy {
  tags: WorkspaceTag[];
  relations: TagRelation[];
}

function filterNodesByTags<T extends Pick<KnowledgeNode, "tags">>(
  nodes: T[],
  opts?: {
    tagIds?: string[];
    tagSlugs?: string[];
    tagsMatch?: "any" | "all";
  },
  hierarchy?: TagFilterHierarchy,
): T[] {
  const wantedIds = [...new Set(opts?.tagIds ?? [])];
  const wantedSlugs = [...new Set(normalizeTagNames(opts?.tagSlugs ?? []))];
  if (wantedIds.length + wantedSlugs.length === 0) return nodes;
  // Hierarchy-aware: each requested tag also matches its descendant tags.
  const matchers = buildTagRefMatchers(
    { ids: wantedIds, slugs: wantedSlugs },
    hierarchy?.tags ?? [],
    hierarchy?.relations ?? [],
  );
  const match = opts?.tagsMatch === "all" ? "all" : "any";
  return nodes.filter((node) => nodeMatchesTagRefMatchers(node.tags, matchers, match));
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    out.push(values.slice(offset, offset + size));
  }
  return out;
}

function throwTagError(
  error: { message: string; code?: string | null },
  value: string,
  id?: string,
): never {
  if (error.message.includes("tag_not_found") || error.code === "P0002") {
    throw new TagNotFoundError(id ?? value);
  }
  if (
    error.message.includes("tag_alias_conflict") ||
    error.message.includes("tag_name_conflict")
  ) {
    throw new TagConflictError("alias_conflict", `tag conflicts with an existing alias: ${value}`);
  }
  if (error.code === "23505") {
    throw new TagConflictError("duplicate", `tag already exists: ${value}`);
  }
  throw new Error(`tag operation failed: ${error.message}`);
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    github_repo: (row.github_repo as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at as string,
  };
}

/**
 * Resolve a workspace named as `<org>/<workspace>` or `<org>~<workspace>`.
 *
 * A workspace slug is unique only inside its organization, so a bare slug
 * does not identify one — it identifies as many as there are organizations
 * that chose the same name. This used to work by accident: every workspace
 * had an organization to itself. Now that organizations really hold several,
 * the pair is required, and a bare slug resolves to nothing rather than to
 * whichever row the database happened to return first.
 */
export async function resolveSupabaseStorage(
  workspaceRef: string,
): Promise<Storage | null> {
  let client: SupabaseClient;
  try {
    client = getSupabaseAdmin();
  } catch {
    return null;
  }
  const ref = parseWorkspaceRef(workspaceRef);
  if (!ref) return null;

  const { data, error } = await client
    .from("workspaces")
    .select("*, organization:organizations!inner(slug)")
    .eq("slug", ref.workspace)
    .eq("organization.slug", ref.org)
    .maybeSingle();
  if (error || !data) return null;
  return new SupabaseStorage(rowToWorkspace(data), client);
}

export async function resolveSupabaseStorageById(
  workspaceId: string,
): Promise<Storage | null> {
  let client: SupabaseClient;
  try {
    client = getSupabaseAdmin();
  } catch {
    return null;
  }
  const { data, error } = await client
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  return new SupabaseStorage(rowToWorkspace(data), client);
}

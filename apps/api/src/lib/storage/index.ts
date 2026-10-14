/**
 * Storage interface — single seam between API routes / MCP tools and the
 * underlying data store. Two implementations:
 *
 *   - `DemoStorage` wraps the in-memory store from `src/lib/demo-store.ts`.
 *     Used when Supabase is not configured OR when the workspace slug
 *     resolves only locally (the demo workspace).
 *   - `SupabaseStorage` talks to Postgres through the service-role client.
 *     Used for any workspace that exists in the `workspaces` table. The
 *     auth layer (`gate`) is the gatekeeper — the service-role bypasses
 *     RLS and trusts the workspace_id resolved at request time.
 *
 * Routes pick the right impl via `getStorage(workspaceSlug)`, then call
 * an API that does NOT carry the workspace slug — the instance is bound.
 */
import { REDACTED_VALUE } from "@bcontext-dev/contract/credentials";
import { supabaseConfigured } from "@/lib/env";
import type {
  KnowledgeNode,
  NodeKind,
  NodeSummary,
  TagRelation,
  Workspace,
  WorkspaceTag,
} from "@bcontext-dev/contract/types";

export type StorageBackend = "demo" | "supabase";

export interface CreateNodeInput {
  title: string;
  kind: NodeKind;
  parent_id: string | null;
  content_md?: string;
  data?: Record<string, unknown>;
  status?: KnowledgeNode["status"];
  priority?: KnowledgeNode["priority"];
  /**
   * Settable on create because a goal's horizon ends here, in the column, and
   * not inside `data`: creating one and then patching the date would leave a
   * goal with no deadline for the length of a round-trip, and every filter
   * that reads this column would miss it.
   */
  due_date?: string | null;
  slug?: string;
  /** Stable ids of existing workspace tags to assign on create. */
  tag_ids?: string[];
}

export type UpdateNodePatch = Partial<
  Pick<
    KnowledgeNode,
    | "title"
    | "slug"
    | "parent_id"
    | "content_md"
    | "status"
    | "priority"
    | "due_date"
    | "data"
    | "position"
  >
> & { tag_ids?: string[] };

export type NodeWriteErrorCode =
  | "invalid_parent"
  | "parent_cycle"
  | "legacy_data_tags"
  | "redacted_credential_write";

/** Stable, non-sensitive errors shared by REST, MCP and connector writers. */
export class NodeWriteError extends Error {
  constructor(
    public readonly code: NodeWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NodeWriteError";
  }
}

/** `node_tags` is canonical; the retired JSON mirror is never accepted. */
export function assertNodeDataContract(data: unknown): void {
  if (
    data !== null
    && typeof data === "object"
    && !Array.isArray(data)
    && Object.prototype.hasOwnProperty.call(data, "tags")
  ) {
    throw new NodeWriteError(
      "legacy_data_tags",
      "data.tags is retired; assign canonical tag_ids instead",
    );
  }
  assertNotRedactedCredential(data);
}

/**
 * A credential's values reach a bearer-token principal as `[redacted]` (see
 * `scopedStorage`'s `maskCredentials`). Writing that copy back would overwrite
 * the real secret with the sentinel — silent, irreversible data loss dressed
 * up as an ordinary update. Refuse it: whoever sent this never had the value,
 * so they cannot have meant to set it.
 */
function assertNotRedactedCredential(data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const fields = (data as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    if (field && typeof field === "object" && (field as { value?: unknown }).value === REDACTED_VALUE) {
      throw new NodeWriteError(
        "redacted_credential_write",
        "this credential was read redacted; writing it back would destroy the value. Patch only the fields you actually set.",
      );
    }
  }
}

/**
 * `data` as callers may see it: a plain object with no `tags` key. Tag
 * assignments live in `node_tags` and the database refuses a `data.tags`
 * key on write (migration 0045), so a caller that spreads a fetched
 * `node.data` back into an update must never receive one.
 */
export function canonicalNodeData(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
  const canonical = { ...(data as Record<string, unknown>) };
  delete canonical.tags;
  return canonical;
}

/**
 * Validate a semantic parent against a bounded workspace snapshot. The
 * storage implementations call this before writes; Postgres repeats it in a
 * trigger so service-role/direct connector writes cannot bypass the contract.
 */
export function assertSemanticParent(
  nodes: Array<Pick<KnowledgeNode, "id" | "workspace_id" | "parent_id">>,
  workspaceId: string,
  parentId: string | null,
  movingNodeId?: string,
): void {
  if (!parentId) return;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = byId.get(parentId);
  if (!parent || parent.workspace_id !== workspaceId) {
    throw new NodeWriteError(
      "invalid_parent",
      "parent_id must reference a semantic node in the same workspace",
    );
  }
  const seen = new Set<string>();
  let cursor: typeof parent | undefined = parent;
  while (cursor) {
    if (movingNodeId && cursor.id === movingNodeId) {
      throw new NodeWriteError(
        "parent_cycle",
        "parent_id would create a hierarchy cycle",
      );
    }
    if (seen.has(cursor.id)) {
      throw new NodeWriteError(
        "parent_cycle",
        "parent hierarchy already contains a cycle",
      );
    }
    seen.add(cursor.id);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
}

export interface CreateTagInput {
  name: string;
  description?: string | null;
  created_by?: string | null;
}

/**
 * A partial edit: an omitted field keeps its current value, `description:
 * null` clears it. Renaming keeps the stable id and the old name as an alias.
 */
export interface UpdateTagInput {
  name?: string;
  description?: string | null;
}

export class TagConflictError extends Error {
  constructor(
    public readonly code: "duplicate" | "alias_conflict",
    message: string,
  ) {
    super(message);
    this.name = "TagConflictError";
  }
}

export class TagNotFoundError extends Error {
  constructor(public readonly tagId: string) {
    super(`tag not found or inactive: ${tagId}`);
    this.name = "TagNotFoundError";
  }
}

/** Optional edges to create alongside a new tag/relation write. */
export interface TagRelationInput {
  parent_ids?: string[];
  related_ids?: string[];
}

/** Identify a single relation row either by id or by its (from, to, kind) key. */
export type TagRelationTarget =
  | { id: string }
  | { fromTagId: string; toTagId: string; relation: TagRelation["relation"] };

export type TagRelationErrorCode = "self" | "cycle";

/** Thrown when a requested tag_relations write is structurally invalid. */
export class TagRelationError extends Error {
  constructor(
    public readonly code: TagRelationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TagRelationError";
  }
}

/**
 * Reject a candidate `parent` edge (fromTagId IS A CHILD OF toTagId) that
 * would introduce a cycle in the tag hierarchy. Tags may have multiple
 * parents (a DAG), so this walks every parent edge reachable from toTagId
 * looking for fromTagId, rather than a single ancestor chain.
 */
export function assertNoTagRelationCycle(
  relations: Array<Pick<TagRelation, "from_tag_id" | "to_tag_id" | "relation">>,
  fromTagId: string,
  toTagId: string,
): void {
  if (fromTagId === toTagId) {
    throw new TagRelationError("self", "a tag cannot relate to itself");
  }
  const parentsOf = new Map<string, string[]>();
  for (const rel of relations) {
    if (rel.relation !== "parent") continue;
    const list = parentsOf.get(rel.from_tag_id) ?? [];
    list.push(rel.to_tag_id);
    parentsOf.set(rel.from_tag_id, list);
  }
  const queue = [toTagId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cursor = queue.shift()!;
    if (cursor === fromTagId) {
      throw new TagRelationError("cycle", "relation would create a hierarchy cycle");
    }
    if (seen.has(cursor)) continue;
    seen.add(cursor);
    for (const parent of parentsOf.get(cursor) ?? []) queue.push(parent);
  }
}

export interface UpdateNodeOpts {
  /**
   * Optimistic-concurrency guard: the `updated_at` the caller last read.
   * When set and the stored row's `updated_at` differs, the update is
   * rejected with `ConflictError` instead of last-write-wins clobbering
   * a concurrent session's edit. Callers surface this as HTTP 409.
   */
  ifUpdatedAt?: string;
}

/**
 * Thrown by `updateNode` when `ifUpdatedAt` doesn't match the stored row.
 * Carries the current `updated_at` so the caller can re-fetch and rebase.
 */
export class ConflictError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly currentUpdatedAt: string,
    public readonly expected: string,
  ) {
    super(
      `conflict: node ${nodeId} was modified (updated_at is ${currentUpdatedAt}, expected ${expected})`,
    );
    this.name = "ConflictError";
  }
}

export type { NodeEdge } from "@bcontext-dev/contract/types";
import type { NodeEdge } from "@bcontext-dev/contract/types";

export interface Storage {
  backend: StorageBackend;
  workspace: Workspace;

  listNodes(opts?: {
    limit?: number;
    /**
     * Restrict to these kinds. The one read that needs full nodes rather than
     * summaries is "the goals of this workspace" — scope, key results and the
     * timeframe all live in `data`, which the summary index drops — and
     * scanning every node's markdown to find a dozen goals is a cost `brief`
     * pays on every session start.
     */
    kinds?: NodeKind[];
    tagIds?: string[];
    tagSlugs?: string[];
    tagsMatch?: "any" | "all";
  }): Promise<KnowledgeNode[]>;
  /** Hot-path workspace index: no content_md and no arbitrary data. */
  listNodeSummaries(opts?: {
    limit?: number;
    tagIds?: string[];
    tagSlugs?: string[];
    tagsMatch?: "any" | "all";
  }): Promise<NodeSummary[]>;
  /** Bounded documents needed to resolve links/edges around one node. */
  listNodeContext(id: string, limit?: number): Promise<KnowledgeNode[]>;
  countTagUsage(): Promise<Map<string, number>>;
  getNode(id: string): Promise<KnowledgeNode | null>;
  createNode(input: CreateNodeInput): Promise<KnowledgeNode>;
  updateNode(
    id: string,
    patch: UpdateNodePatch,
    opts?: UpdateNodeOpts,
  ): Promise<KnowledgeNode | null>;
  deleteNode(id: string): Promise<boolean>;

  listTags(opts?: { includeInactive?: boolean }): Promise<WorkspaceTag[]>;
  getTag(id: string): Promise<WorkspaceTag | null>;
  /** Resolve current names/slugs and historical aliases to active stable ids. */
  resolveTagIds(names: string[]): Promise<Map<string, string>>;
  createTag(input: CreateTagInput): Promise<WorkspaceTag>;
  updateTag(id: string, input: UpdateTagInput): Promise<WorkspaceTag>;
  mergeTags(sourceId: string, targetId: string): Promise<WorkspaceTag>;
  deleteTag(id: string): Promise<boolean>;
  /** Replace a node's complete assignment set with existing active tag ids. */
  setNodeTags(nodeId: string, tagIds: string[]): Promise<KnowledgeNode>;

  /** All tag-graph edges (parent + related) in the workspace. */
  listTagRelations(): Promise<TagRelation[]>;
  /**
   * Create parent/related edges from `fromTagId` to each given tag. Existing
   * edges are a no-op (idempotent); a `parent` edge that would introduce a
   * cycle throws `TagRelationError`. Returns only the newly created rows.
   */
  createTagRelations(
    fromTagId: string,
    input: TagRelationInput,
  ): Promise<TagRelation[]>;
  /** Delete one relation row by id or by its (from, to, kind) key. */
  deleteTagRelation(target: TagRelationTarget): Promise<boolean>;

  /** All typed edges in the workspace (bounded; workspaces are small). */
  listEdges(): Promise<NodeEdge[]>;
  /**
   * Create a typed edge. Both endpoints must exist in this workspace.
   * Idempotent: creating an existing (from, to, relation) is a no-op.
   */
  createEdge(edge: NodeEdge): Promise<NodeEdge>;
  /** Delete a typed edge. Returns false when it didn't exist. */
  deleteEdge(edge: NodeEdge): Promise<boolean>;
}

/**
 * Ids of `rootId` plus every descendant, walking parent_id links. Used to
 * echo a delete's blast radius and to clean up per-node blob storage —
 * the DB cascade removes rows silently, so callers must precompute this.
 */
export function collectSubtreeIds(
  nodes: Array<{ id: string; parent_id: string | null }>,
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = children.get(n.parent_id) ?? [];
    list.push(n.id);
    children.set(n.parent_id, list);
  }
  const out: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) queue.push(c);
  }
  return out;
}

/**
 * Resolve the storage bound to a workspace slug. Tries Supabase first
 * (when configured); falls back to the demo store. Returns null when no
 * matching workspace exists in either backend.
 */
export async function getStorage(
  workspaceSlug: string,
): Promise<Storage | null> {
  // Lazy-import both backends to avoid bundling Supabase into demo-only
  // environments and vice versa.
  if (supabaseConfigured()) {
    const { resolveSupabaseStorage } = await import("./supabase");
    const supa = await resolveSupabaseStorage(workspaceSlug);
    if (supa) return supa;
  }
  const { resolveDemoStorage } = await import("./demo");
  return resolveDemoStorage(workspaceSlug);
}

/**
 * Resolve a storage instance from a workspace UUID. Used when the only id
 * the caller has is the one carried on the bearer token.
 */
export async function getStorageById(
  workspaceId: string,
): Promise<Storage | null> {
  if (supabaseConfigured()) {
    const { resolveSupabaseStorageById } = await import("./supabase");
    const supa = await resolveSupabaseStorageById(workspaceId);
    if (supa) return supa;
  }
  // Demo fallback: seeded demo workspaces carry fixed UUIDs (and
  // runtime-created ones live for the process), so id-addressed routes —
  // e.g. the Review board's /api/ingest/candidates — work without Supabase.
  const { resolveDemoStorageById } = await import("./demo");
  return resolveDemoStorageById(workspaceId);
}

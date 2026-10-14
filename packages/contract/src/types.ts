// Domain types — mirror the SQL schema in /supabase/migrations.

import { normalizeTagNames } from "./tags.js";
import type { SubtaskProgress } from "./subtasks.js";

export type NodeKind =
  | "doc"
  | "task"
  | "decision"
  | "meeting"
  | "bug"
  | "adr"
  | "entity"
  | "skill"
  | "data"
  | "credential"
  | "goal";

/**
 * The kinds, as a value. Three copies of this list existed when `goal` was
 * added and two of them were missed — a change feed silently stopped
 * classifying goal entries, and filtering by kind dropped them. A kind is
 * vocabulary, and vocabulary belongs in one place.
 */
export const NODE_KINDS = [
  "doc", "task", "decision", "meeting", "bug", "adr", "entity", "skill", "data", "credential", "goal",
] as const satisfies readonly NodeKind[];

/** Stable discriminant shared by graph query/storage payloads. */
export type GraphResourceType = "node" | "tag" | "cluster";

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "blocked"
  | "done"
  /**
   * Out of the way, not deleted: hidden from views, boards and the graph,
   * still readable by id and still the target of links. Any other status
   * brings it back.
   */
  | "archived";

/**
 * How a goal is doing. A goal does not move backlog → done: it is either
 * tracking, drifting, or over. Stored in the same `status` column as
 * TaskStatus — the column is free text in SQL, so the vocabularies coexist
 * without a migration and both stay filterable from MCP and views.
 */
export type GoalStatus =
  | "on_track"
  | "at_risk"
  | "off_track"
  | "achieved"
  | "missed"
  | "abandoned";

/** Anything the `status` column may hold, whatever the node's kind. */
export type NodeStatus = TaskStatus | GoalStatus;

/**
 * The vocabulary itself, ordered from best to worst. Exported because every
 * surface that validates a goal's status (the MCP tool schemas, the REST
 * routes) needs the list and not just the type — and a second copy written out
 * by hand is how the two drift apart.
 */
export const GOAL_STATUSES = [
  "on_track", "at_risk", "off_track", "achieved", "missed", "abandoned",
] as const satisfies readonly GoalStatus[];

const GOAL_STATUS_SET: ReadonlySet<string> = new Set<string>(GOAL_STATUSES);

export function isGoalStatus(status: string | null | undefined): status is GoalStatus {
  return typeof status === "string" && GOAL_STATUS_SET.has(status);
}

export const TASK_STATUSES = [
  "backlog", "todo", "in_progress", "review", "blocked", "done", "archived",
] as const satisfies readonly TaskStatus[];

/**
 * Everything the `status` column may hold. The two vocabularies share one
 * column and which of them applies is decided by the node's kind, so a surface
 * that validates `status` without knowing the kind — every REST route that
 * takes a patch — validates against this.
 */
export const NODE_STATUSES = [
  ...TASK_STATUSES,
  ...GOAL_STATUSES,
] as const satisfies readonly NodeStatus[];

/** Statuses nothing further happens in: a blocker in one of these no longer blocks. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "archived"];

export function isTerminalStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "archived";
}

export function isArchived(node: { status: TaskStatus | null }): boolean {
  return node.status === "archived";
}

export type Priority = "low" | "med" | "high" | "urgent";

export interface WorkspaceTag {
  id: string;
  workspace_id: string;
  name: string;
  normalized_name: string;
  slug: string;
  description: string | null;
  merged_into_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TagAlias {
  id: string;
  workspace_id: string;
  tag_id: string;
  normalized_name: string;
  slug: string;
  reason: "rename" | "merge";
  created_at: string;
}

/**
 * A directed edge in the tag dependency graph.
 *   - `relation: "parent"`  — `from_tag_id` IS A CHILD OF `to_tag_id`.
 *     Multiple parents per tag are allowed (a DAG, not a strict tree).
 *   - `relation: "related"` — symmetric association; a single row encodes
 *     the pair and readers must treat (from, to) and (to, from) as the
 *     same edge.
 * Tag relations never grant permissions — see WorkspaceTag.
 */
export interface TagRelation {
  id: string;
  workspace_id: string;
  from_tag_id: string;
  to_tag_id: string;
  relation: "parent" | "related";
  created_at: string;
}

/**
 * Conventions for the `data` JSONB field on a node:
 *   - `previous_slugs?: string[]` — historical slugs for redirect resolution
 *   - `__optimistic?: boolean`    — UI-only marker for pending creates
 */
export interface KnowledgeNode {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: NodeKind;
  slug: string;
  title: string;
  content_md: string;
  data: Record<string, unknown>;
  /** Canonical many-to-many taxonomy assignments. */
  tags: WorkspaceTag[];
  status: NodeStatus | null;
  priority: Priority | null;
  assignee_id: string | null;
  due_date: string | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Lightweight workspace-index row. The storage query never selects a node's
 * markdown body or arbitrary JSON data. The two empty compatibility fields
 * keep existing renderers structurally compatible while they migrate to the
 * explicit read model; `source` is the only projected JSON attribute.
 */
export interface NodeSummary extends KnowledgeNode {
  content_md: "";
  data: { source?: string };
  source: string | null;
  /** done/total of `data.subtasks`; null when the node has none. Computed by the summary query. */
  subtasks: SubtaskProgress | null;
}

export interface Workspace {
  id: string;
  organization_id: string;
  /**
   * Unique **within its organization**, not globally — which is why a
   * workspace is addressed as `<org>/<workspace>` everywhere it is named.
   */
  slug: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface NodeTreeItem extends KnowledgeNode {
  children?: NodeTreeItem[];
}

export interface ChatCitation {
  node_id: string;
  title: string;
  kind: NodeKind;
  similarity: number;
  /** Set when this node has a newer `supersedes` edge onto it. */
  superseded_by?: string | null;
  /** Edit age combined with query frequency crossed the staleness threshold. */
  stale?: boolean;
  /**
   * Index of the chunk inside the source node, as produced by
   * `chunkMarkdown` (0-based). `null` when the retriever can't anchor
   * to a specific chunk (e.g. legacy memory-fallback path). Used to
   * build deep-links of the form `?highlight=<chunk_index>`.
   */
  chunk_index: number | null;
  /**
   * Stable H2-derived block id of the cited chunk (`/n/<node_id>#<block_id>`),
   * or `null` when the retriever has no block granularity. Lets agents
   * verify and link the exact section a claim came from.
   */
  block_id: string | null;
  /**
   * Ready-to-paste reference path — `/n/<node_id>` or
   * `/n/<node_id>#<block_id>` when the block is known.
   */
  ref: string;
  /**
   * Short single-line preview of the cited chunk, suitable for hover
   * tooltips and citation lists.
   */
  snippet: string;
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  achieved: "Achieved",
  missed: "Missed",
  abandoned: "Abandoned",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  archived: "Archived",
};

/** Label for either vocabulary, so call sites need not know the node's kind. */
export function statusLabel(status: NodeStatus | null | undefined): string {
  if (!status) return "";
  return isGoalStatus(status) ? GOAL_STATUS_LABELS[status] : STATUS_LABELS[status];
}

/** Return normalized names from canonical first-class assignments. */
export function getNodeTags(
  node: Partial<Pick<KnowledgeNode, "tags">>,
): string[] {
  const canonical: unknown[] = [];
  if (Array.isArray(node.tags)) {
    for (const tag of node.tags) {
      if (tag && typeof tag === "object") {
        const record = tag as Partial<WorkspaceTag>;
        canonical.push(record.name ?? record.normalized_name);
      }
    }
  }
  return normalizeTagNames(canonical);
}

export function getNodeTagIds(
  node: Partial<Pick<KnowledgeNode, "tags">>,
): string[] {
  if (!Array.isArray(node.tags)) return [];
  return Array.from(
    new Set(
      node.tags
        .map((tag) => tag?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
}

/**
 * Read the explicit `mentions` array from a node's `data` field. Explicit
 * mentions are node ids the user has connected via the Mentions section in
 * the node header — they create graph edges without polluting the markdown
 * body. Defensive: returns an empty array when missing or malformed.
 *
 * Persisted format (`data.mentions[]`) accepts two shapes per entry, for
 * backward compatibility with writes made before block-aware mentions:
 *   - String (legacy):  `"node-id"`
 *   - Object (v1 block-aware): `{ id: "node-id", block_id?: "vision" }`
 *
 * This helper collapses both shapes to bare node ids. Callers that need
 * the optional `block_id` should use `getNodeMentionRecords` instead.
 */
export function getNodeMentions(node: Pick<KnowledgeNode, "data">): string[] {
  return getNodeMentionRecords(node).map((r) => r.id);
}

/**
 * Variant of `getNodeMentions` that preserves the optional `block_id` on
 * each entry. Each record has `id: string` and `block_id: string | null`.
 * Deduped on the `(id, block_id)` pair — the same node referenced via
 * two distinct blocks survives as two records.
 */
export function getNodeMentionRecords(
  node: Pick<KnowledgeNode, "data">,
): Array<{ id: string; block_id: string | null }> {
  const data = node.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as Record<string, unknown>).mentions;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; block_id: string | null }> = [];
  const seen = new Set<string>();
  for (const v of raw) {
    let id: string | null = null;
    let block_id: string | null = null;
    if (typeof v === "string") {
      id = v.trim();
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      if (typeof obj.id === "string") id = obj.id.trim();
      if (typeof obj.block_id === "string") {
        const b = obj.block_id.trim();
        block_id = b ? b : null;
      }
    }
    if (!id) continue;
    const key = `${id}#${block_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, block_id });
  }
  return out;
}

/** Typed relation between two nodes (the `edges` table / demo map). Contract type: the API stores it, the UI draws it.. */
export interface NodeEdge {
  from_node: string;
  to_node: string;
  relation: string;
}

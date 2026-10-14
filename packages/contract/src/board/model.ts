/**
 * The task board as a pure model: which statuses earn a column, how a saved
 * view's query + presentation turn a node list into columns (by status,
 * priority, tag…), what a card shows, and the patch a drag between columns
 * produces. The web renders `boardColumns()`; the API applies
 * `boardMovePatch()` — same rules on both sides, so a move the UI allows is
 * one the server accepts.
 */
import {
  STATUS_LABELS,
  type KnowledgeNode,
  type NodeKind,
  type NodeStatus,
  type Priority,
  type TaskStatus,
  type WorkspaceTag,
} from "../types.js";
import type { NodeEdge } from "../types.js";
import type { ViewPresentation, ViewQuery } from "../views/schema.js";

/** The board is a task board: goal statuses never earn a column. */
export function isBoardStatus(status: NodeStatus): status is TaskStatus {
  return (BOARD_STATUS_COLUMNS as readonly string[]).includes(status);
}

export const BOARD_STATUS_COLUMNS: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
];

const PRIORITY_COLUMNS = ["urgent", "high", "med", "low", "none"] as const;
const BOARD_KINDS: NodeKind[] = ["task", "bug"];

export type BoardGroupBy =
  | "status"
  | "priority"
  | "kind"
  | "tag"
  | "source"
  | "assignee_id"
  | string;

export interface BoardColumn {
  id: string;
  value: string;
  label: string;
}

export interface BoardBlockerState {
  total: number;
  active: number;
}

export interface BoardCreateDraft {
  title: string;
  kind: NodeKind;
  parent_id: string | null;
  content_md: string;
  status?: TaskStatus | null;
  priority?: Priority | null;
  data?: Record<string, unknown>;
  tag_ids?: string[];
  navigate: false;
}

export type BoardCreateResult =
  | { ok: true; input: BoardCreateDraft }
  | { ok: false; reason: string };

export interface BoardModelOptions {
  query: ViewQuery;
  presentation: ViewPresentation;
  nodes: KnowledgeNode[];
  allNodes?: KnowledgeNode[];
}

type BoardLayout = {
  column_values?: string[];
  column_labels?: Record<string, string>;
  create_kind?: NodeKind;
  create_parent_id?: string | null;
  default_column?: string;
  card_fields?: string[];
};

export function boardGroupBy(presentation: ViewPresentation): BoardGroupBy {
  const raw = presentation.group_by?.trim().toLocaleLowerCase("en-US") || "status";
  return raw === "tags" ? "tag" : raw;
}

export function boardCardFields(presentation: ViewPresentation): Set<string> {
  const board = readBoardLayout(presentation);
  const configured = presentation.columns.length > 0
    ? presentation.columns
    : board.card_fields;
  return new Set(
    configured && configured.length > 0
      ? configured
      : ["kind", "title", "priority", "tags", "subtasks", "blockers", "due_date", "provenance"],
  );
}

export function boardColumns({ query, presentation, nodes, allNodes = nodes }: BoardModelOptions): BoardColumn[] {
  const groupBy = boardGroupBy(presentation);
  const layout = readBoardLayout(presentation);
  const configured = cleanStrings(layout.column_values ?? []);
  const values = configured.length > 0
    ? configured
    : defaultColumnValues(groupBy, query, nodes, allNodes);
  return values.map((value) => ({
    id: `${groupBy}:${value}`,
    value,
    label: layout.column_labels?.[value] ?? columnLabel(groupBy, value, allNodes),
  }));
}

export function groupBoardNodes(
  options: BoardModelOptions,
  optimistic: Readonly<Record<string, string>> = {},
): Map<string, KnowledgeNode[]> {
  const groupBy = boardGroupBy(options.presentation);
  const columns = boardColumns(options);
  const groups = new Map(columns.map((column) => [column.value, [] as KnowledgeNode[]]));
  for (const node of dedupeNodes(options.nodes)) {
    if (!BOARD_KINDS.includes(node.kind)) continue;
    const value = optimistic[node.id] ?? boardValue(node, groupBy, columns);
    const fallback = readBoardLayout(options.presentation).default_column ?? columns[0]?.value;
    const target = groups.has(value) ? value : fallback;
    if (target && groups.has(target)) groups.get(target)!.push(node);
  }
  for (const cards of groups.values()) sortBoardNodes(cards, options.presentation);
  return groups;
}

export function boardValue(
  node: KnowledgeNode,
  groupBy: BoardGroupBy,
  columns: BoardColumn[] = [],
): string {
  switch (groupBy) {
    case "status":
      return node.status ?? "todo";
    case "priority":
      return node.priority ?? "none";
    case "kind":
      return node.kind;
    case "tag": {
      const allowed = new Set(columns.map((column) => column.value));
      const matching = node.tags.find((tag) => allowed.has(tag.id) || allowed.has(tag.slug) || allowed.has(tag.normalized_name));
      return matching?.id ?? matching?.slug ?? node.tags[0]?.id ?? "untagged";
    }
    case "source":
      return typeof node.data.source === "string" && node.data.source.trim() ? node.data.source : "none";
    case "assignee_id":
      return node.assignee_id ?? "unassigned";
    default: {
      const value = readPath(node, groupBy);
      return typeof value === "string" && value.trim() ? value : "none";
    }
  }
}

export function canMoveBoardCards(groupBy: BoardGroupBy): boolean {
  return ["status", "priority", "tag", "source", "parent_id"].includes(groupBy);
}

export function boardMovePatch(
  node: KnowledgeNode,
  groupBy: BoardGroupBy,
  columnValue: string,
  columns: BoardColumn[],
  availableTags: WorkspaceTag[] = node.tags,
): Record<string, unknown> | null {
  if (groupBy === "status" && BOARD_STATUS_COLUMNS.includes(columnValue as TaskStatus)) {
    return { status: columnValue };
  }
  if (groupBy === "priority" && PRIORITY_COLUMNS.includes(columnValue as (typeof PRIORITY_COLUMNS)[number])) {
    return { priority: columnValue === "none" ? null : columnValue };
  }
  if (groupBy === "source") {
    const data = { ...node.data };
    if (columnValue === "none") delete data.source;
    else data.source = columnValue;
    return { data };
  }
  if (groupBy === "parent_id") return { parent_id: columnValue === "none" ? null : columnValue };
  if (groupBy === "tag") {
    const target = columnValue === "untagged" ? null : findTag(columnValue, availableTags);
    if (columnValue !== "untagged" && !target) return null;
    const boardTagIds = new Set(columns.flatMap((column) => {
      const tag = findTag(column.value, availableTags);
      return tag ? [tag.id, tag.slug, tag.normalized_name] : [column.value];
    }));
    const retained = node.tags
      .filter((tag) => !boardTagIds.has(tag.id) && !boardTagIds.has(tag.slug) && !boardTagIds.has(tag.normalized_name))
      .map((tag) => tag.id);
    return { tag_ids: target ? [...new Set([...retained, target.id])] : retained };
  }
  return null;
}

export function deriveBoardCreate(
  options: BoardModelOptions,
  columnValue: string,
  title = "Untitled",
): BoardCreateResult {
  const { query, presentation, allNodes = options.nodes } = options;
  const groupBy = boardGroupBy(presentation);
  const layout = readBoardLayout(presentation);
  const kinds = query.kinds.filter((kind): kind is NodeKind =>
    BOARD_KINDS.includes(kind));
  let kind: NodeKind = "task";
  if (layout.create_kind) kind = layout.create_kind;
  else if (kinds.includes("task")) kind = "task";
  else if (kinds[0]) kind = kinds[0];
  if (!BOARD_KINDS.includes(kind) || (query.kinds.length > 0 && !query.kinds.includes(kind))) {
    return { ok: false, reason: "This view does not define a creatable task or bug kind." };
  }

  if (query.actor.length > 0) return { ok: false, reason: "Actor-filtered views cannot assign an author during create." };
  if (query.dates.some((date) => date.field === "due_date")) {
    return { ok: false, reason: "Choose a due date before creating in this filtered view." };
  }

  let parentId = layout.create_parent_id ?? null;
  if (layout.create_parent_id === undefined && query.root_node_ids.length === 1) {
    const root = allNodes.find((node) => node.id === query.root_node_ids[0]);
    parentId = root?.id ?? null;
  } else if (layout.create_parent_id === undefined && query.root_node_ids.length > 1) {
    return { ok: false, reason: "Choose a create parent for this multi-root view." };
  }
  if (query.traversal && !parentId) {
    return { ok: false, reason: "Creating cannot guarantee membership in this traversal view." };
  }

  let status: NodeStatus | null | undefined;
  if (groupBy === "status") status = columnValue as NodeStatus;
  else if (query.statuses.length === 1) status = query.statuses[0];
  else if (query.statuses.length > 1) {
    return { ok: false, reason: "Choose a status column before creating in this filtered view." };
  }
  if (status && !isBoardStatus(status)) return { ok: false, reason: "Invalid status column." };
  if (status && query.statuses.length > 0 && !query.statuses.includes(status)) {
    return { ok: false, reason: "That column is outside the active status filter." };
  }

  let priority: Priority | null | undefined;
  if (groupBy === "priority") priority = columnValue === "none" ? null : columnValue as Priority;

  const tagIds = new Set<string>();
  const tagIndex = indexTags(allNodes);
  const requiredTagRefs = [...query.tags_all];
  if (query.tags_any.length === 1) requiredTagRefs.push(query.tags_any[0]!);
  if (query.tags_any.length > 1 && groupBy !== "tag") {
    return { ok: false, reason: "Choose a tag column before creating in this any-tag view." };
  }
  if (groupBy === "tag" && columnValue !== "untagged") requiredTagRefs.push(columnValue);
  for (const ref of requiredTagRefs) {
    const tag = tagIndex.get(ref.toLocaleLowerCase("en-US"));
    if (!tag) return { ok: false, reason: `Tag “${ref}” is not available in this workspace.` };
    tagIds.add(tag.id);
  }
  if (query.tags_any.length > 1) {
    const matchesAny = query.tags_any.some((ref) => {
      const tag = tagIndex.get(ref.toLocaleLowerCase("en-US"));
      return tag ? tagIds.has(tag.id) : false;
    });
    if (!matchesAny) return { ok: false, reason: "That column is outside the active tag filter." };
  }

  const data: Record<string, unknown> = {};
  if (query.source.length === 1) data.source = query.source[0];
  else if (query.source.length > 1 && groupBy !== "source") {
    return { ok: false, reason: "Choose a source column before creating in this filtered view." };
  }
  if (groupBy === "source" && columnValue !== "none") data.source = columnValue;
  if (groupBy === "source" && query.source.length > 0 && !query.source.includes(columnValue)) {
    return { ok: false, reason: "That column is outside the active source filter." };
  }

  return {
    ok: true,
    input: {
      title,
      kind,
      parent_id: parentId,
      content_md: "",
      ...(status !== undefined ? { status } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
      ...(tagIds.size > 0 ? { tag_ids: [...tagIds] } : {}),
      navigate: false,
    },
  };
}

export function buildBoardBlockers(
  nodes: KnowledgeNode[],
  edges: NodeEdge[],
  resultIds?: Iterable<string>,
): Record<string, BoardBlockerState> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const allowed = resultIds ? new Set(resultIds) : null;
  const result: Record<string, BoardBlockerState> = {};
  for (const edge of edges) {
    if (edge.relation !== "blocked_by" || (allowed && !allowed.has(edge.from_node))) continue;
    const current = result[edge.from_node] ?? { total: 0, active: 0 };
    current.total += 1;
    if (byId.get(edge.to_node)?.status !== "done") current.active += 1;
    result[edge.from_node] = current;
  }
  return result;
}

function defaultColumnValues(groupBy: BoardGroupBy, query: ViewQuery, nodes: KnowledgeNode[], allNodes: KnowledgeNode[]): string[] {
  if (groupBy === "status") return [...BOARD_STATUS_COLUMNS];
  if (groupBy === "priority") return [...PRIORITY_COLUMNS];
  if (groupBy === "kind") return (query.kinds.length > 0 ? query.kinds : BOARD_KINDS)
    .filter((kind) => BOARD_KINDS.includes(kind));
  if (groupBy === "tag") {
    const requested = [...query.tags_all, ...query.tags_any];
    const index = indexTags(allNodes);
    const ids = requested.map((ref) => index.get(ref.toLocaleLowerCase("en-US"))?.id).filter((id): id is string => Boolean(id));
    const visible = ids.length > 0 ? ids : nodes.flatMap((node) => node.tags.map((tag) => tag.id));
    return [...new Set([...visible, "untagged"])];
  }
  const values = nodes.map((node) => boardValue(node, groupBy)).filter(Boolean);
  return [...new Set([...values, groupBy === "source" ? "none" : groupBy === "assignee_id" ? "unassigned" : "none"])];
}

function columnLabel(groupBy: BoardGroupBy, value: string, nodes: KnowledgeNode[]): string {
  if (groupBy === "status") return STATUS_LABELS[value as TaskStatus] ?? value;
  if (value === "none") return "None";
  if (value === "untagged") return "Untagged";
  if (value === "unassigned") return "Unassigned";
  if (groupBy === "tag") return findTag(value, nodes.flatMap((node) => node.tags))?.name ?? value;
  return value.replaceAll("_", " ");
}

function sortBoardNodes(nodes: KnowledgeNode[], presentation: ViewPresentation): void {
  const priorityRank: Record<string, number> = { urgent: 4, high: 3, med: 2, low: 1 };
  nodes.sort((a, b) => {
    for (const sort of presentation.sort_by) {
      const av = sort.field === "priority" ? priorityRank[a.priority ?? ""] ?? 0 : readPath(a, sort.field);
      const bv = sort.field === "priority" ? priorityRank[b.priority ?? ""] ?? 0 : readPath(b, sort.field);
      const compared = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true });
      if (compared !== 0) return sort.direction === "desc" ? -compared : compared;
    }
    return a.position - b.position || a.title.localeCompare(b.title);
  });
}

function readBoardLayout(presentation: ViewPresentation): BoardLayout {
  const candidate = presentation.layout.board;
  const raw = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : presentation.layout;
  const createKind = typeof raw.create_kind === "string" && BOARD_KINDS.includes(raw.create_kind as NodeKind)
    ? raw.create_kind as NodeKind
    : undefined;
  return {
    column_values: Array.isArray(raw.column_values) ? cleanStrings(raw.column_values) : undefined,
    column_labels: isStringRecord(raw.column_labels) ? raw.column_labels : undefined,
    create_kind: createKind,
    create_parent_id: typeof raw.create_parent_id === "string" || raw.create_parent_id === null ? raw.create_parent_id : undefined,
    default_column: typeof raw.default_column === "string" ? raw.default_column : undefined,
    card_fields: Array.isArray(raw.card_fields) ? cleanStrings(raw.card_fields) : undefined,
  };
}

function indexTags(nodes: KnowledgeNode[]): Map<string, WorkspaceTag> {
  const result = new Map<string, WorkspaceTag>();
  for (const node of nodes) for (const tag of node.tags) {
    for (const key of [tag.id, tag.slug, tag.normalized_name, tag.name]) result.set(key.toLocaleLowerCase("en-US"), tag);
  }
  return result;
}

function findTag(value: string, tags: WorkspaceTag[], columns: BoardColumn[] = []): WorkspaceTag | undefined {
  const aliases = new Set([value, columns.find((column) => column.value === value)?.value].filter(Boolean).map((item) => item!.toLocaleLowerCase("en-US")));
  return tags.find((tag) => [tag.id, tag.slug, tag.normalized_name, tag.name].some((key) => aliases.has(key.toLocaleLowerCase("en-US"))));
}

function dedupeNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function readPath(node: KnowledgeNode, field: string): unknown {
  if (field.startsWith("data.")) return node.data[field.slice(5)];
  if (field in node) return node[field as keyof KnowledgeNode];
  return node.data[field];
}

function cleanStrings(value: unknown[]): string[] {
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string"));
}

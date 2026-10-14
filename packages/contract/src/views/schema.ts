/**
 * Saved views — the zod schema of a view's `query` (what nodes: kinds,
 * statuses, tags, roots, traversal…) and `presentation` (how: renderer, sort,
 * card fields), with the limits that bound what a query may ask the resolver
 * to do. The API validates and normalises incoming views with these; the web
 * builds the editor from the same shapes. `VIEW_*_SCHEMA_VERSION` is bumped
 * when a stored view needs migrating on read.
 */
import { z } from "zod";

export const VIEW_QUERY_SCHEMA_VERSION = 1 as const;
export const VIEW_PRESENTATION_SCHEMA_VERSION = 1 as const;

export const VIEW_LIMITS = {
  maxRoots: 50,
  maxTagFilters: 100,
  maxKinds: 10,
  maxStatuses: 7,
  maxSources: 50,
  maxActors: 50,
  maxEdgeTypes: 20,
  maxTraversalDepth: 3,
  maxTraversalNodes: 500,
  maxTraversalEdges: 2_000,
  maxResultNodes: 1_000,
  maxResolverCost: 50_000,
} as const;

const NODE_KINDS = [
  "doc", "task", "decision", "meeting", "bug", "adr", "entity", "skill", "data", "credential", "goal",
] as const;
const NODE_STATUSES = [
  "backlog", "todo", "in_progress", "review", "blocked", "done", "archived",
  "on_track", "at_risk", "off_track", "achieved", "missed", "abandoned",
] as const;
const DATE_FIELDS = ["created_at", "updated_at", "due_date"] as const;
const RENDERERS = ["graph", "board", "table", "list", "changes", "browse", "credentials", "roadmap"] as const;
/**
 * Renderers that no longer exist but may survive in stored presentations or
 * inbound API payloads. They are coerced on parse — a saved "timeline" view
 * keeps working, rendered by the list renderer (timeline retired 2026-07-21).
 */
const LEGACY_RENDERER_ALIASES: Record<string, (typeof RENDERERS)[number]> = {
  timeline: "list",
};

const LimitedString = z.string().trim().min(1).max(200);
const StringSet = (max: number) => z.array(LimitedString).max(max).default([]);

export const DateRangeSchema = z.object({
  field: z.enum(DATE_FIELDS),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.from && !value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date range requires from or to" });
  }
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date range from must not exceed to" });
  }
});

export const TraversalSchema = z.object({
  edge_types: StringSet(VIEW_LIMITS.maxEdgeTypes),
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  depth: z.number().int().min(1).max(VIEW_LIMITS.maxTraversalDepth),
  max_nodes: z.number().int().min(1).max(VIEW_LIMITS.maxTraversalNodes).default(VIEW_LIMITS.maxTraversalNodes),
  max_edges: z.number().int().min(1).max(VIEW_LIMITS.maxTraversalEdges).default(VIEW_LIMITS.maxTraversalEdges),
}).strict();

export const ViewQuerySchema = z.object({
  schema_version: z.literal(VIEW_QUERY_SCHEMA_VERSION),
  kinds: z.array(z.enum(NODE_KINDS)).max(VIEW_LIMITS.maxKinds).default([]),
  tags_any: StringSet(VIEW_LIMITS.maxTagFilters),
  tags_all: StringSet(VIEW_LIMITS.maxTagFilters),
  statuses: z.array(z.enum(NODE_STATUSES)).max(VIEW_LIMITS.maxStatuses).default([]),
  dates: z.array(DateRangeSchema).max(DATE_FIELDS.length).default([]),
  source: StringSet(VIEW_LIMITS.maxSources),
  actor: StringSet(VIEW_LIMITS.maxActors),
  root_node_ids: StringSet(VIEW_LIMITS.maxRoots),
  traversal: TraversalSchema.nullable().default(null),
  /**
   * "What can I start now": keep only nodes that carry a non-terminal status
   * and whose `blocked_by` edges all point at done/archived (or missing)
   * nodes. One rule, evaluated by the resolver, shared with
   * nodes(op=list, unblocked) and every RAG scope that goes through a view.
   */
  unblocked: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.traversal && value.root_node_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["root_node_ids"], message: "traversal requires at least one root node id" });
  }
});

export const SortFieldSchema = z.object({
  field: z.enum(["title", "kind", "status", "priority", "created_at", "updated_at", "due_date"]),
  direction: z.enum(["asc", "desc"]).default("asc"),
}).strict();

export const ViewPresentationSchema = z.object({
  schema_version: z.literal(VIEW_PRESENTATION_SCHEMA_VERSION),
  renderer: z.preprocess(
    (value) => (typeof value === "string" && value in LEGACY_RENDERER_ALIASES ? LEGACY_RENDERER_ALIASES[value] : value),
    z.enum(RENDERERS),
  ),
  group_by: z.string().trim().min(1).max(80).nullable().default(null),
  sort_by: z.array(SortFieldSchema).max(5).default([]),
  columns: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  clustering: z.record(z.unknown()).default({}),
  layout: z.record(z.unknown()).default({}),
}).strict();

export type ViewQuery = z.infer<typeof ViewQuerySchema>;
export type ViewPresentation = z.infer<typeof ViewPresentationSchema>;
export type ViewRenderer = ViewPresentation["renderer"];

function uniqueSorted(values: readonly string[], foldCase = false): string[] {
  return [...new Set(values.map((value) => {
    const trimmed = value.trim();
    return foldCase ? trimmed.toLocaleLowerCase("en-US") : trimmed;
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizeViewQuery(input: unknown): ViewQuery {
  const parsed = ViewQuerySchema.parse(input);
  return {
    ...parsed,
    kinds: uniqueSorted(parsed.kinds) as ViewQuery["kinds"],
    tags_any: uniqueSorted(parsed.tags_any, true),
    tags_all: uniqueSorted(parsed.tags_all, true),
    statuses: uniqueSorted(parsed.statuses) as ViewQuery["statuses"],
    dates: [...parsed.dates].sort((a, b) => a.field.localeCompare(b.field)),
    source: uniqueSorted(parsed.source, true),
    actor: uniqueSorted(parsed.actor),
    root_node_ids: uniqueSorted(parsed.root_node_ids),
    traversal: parsed.traversal ? { ...parsed.traversal, edge_types: uniqueSorted(parsed.traversal.edge_types, true) } : null,
  };
}

export function normalizeViewPresentation(input: unknown): ViewPresentation {
  const parsed = ViewPresentationSchema.parse(input);
  return {
    ...parsed,
    columns: uniqueInOrder(parsed.columns),
    sort_by: parsed.sort_by.map((sort) => ({ ...sort })),
    clustering: sortObject(parsed.clustering),
    layout: sortObject(parsed.layout),
  };
}

function sortObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonicalJson(value)]));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return sortObject(value as Record<string, unknown>);
  return value;
}

export function emptyViewQuery(): ViewQuery {
  return normalizeViewQuery({ schema_version: VIEW_QUERY_SCHEMA_VERSION });
}

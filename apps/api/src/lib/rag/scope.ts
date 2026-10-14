/**
 * Retrieval scope: which nodes a RAG/Nexo query may draw from. The schema is
 * the `scope` argument agents pass to `ask_rag`/`ask_nexo` and the REST
 * equivalents; `resolveRetrievalScope` turns it into concrete "lanes" of node
 * ids (workspace, saved view, tags, explicit selection, graph neighborhood)
 * that `rag.ts` searches and scores separately before merging.
 *
 * Two contracts matter: a non-auto scope is *strict* — graph expansion may
 * not leave `strict_node_ids` — while `auto` always keeps the whole
 * workspace as a low-boost lane so hints narrow ranking without losing
 * recall. Views resolve under the caller's `ViewPrincipal`, so a scope can
 * never read past what the person could see in the view itself.
 */
import { z } from "zod";
import type { Storage } from "@/lib/storage";
import { getView } from "@/lib/views/store";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import { resolveViewQuery } from "@/lib/views/resolver";
import { VIEW_LIMITS, VIEW_QUERY_SCHEMA_VERSION } from "@bcontext-dev/contract/views/schema";
import type { NodeKind } from "@bcontext-dev/contract/types";

const RAG_SCOPE_SCHEMA_VERSION = 1 as const;

const Ids = (max: number) => z.array(z.string().trim().min(1).max(200)).max(max).default([]);
const Tags = z.array(z.string().trim().min(1).max(200)).max(VIEW_LIMITS.maxTagFilters).default([]);
const GraphExpansion = z.enum(["strict", "broad"]).default("strict");
const NeighborhoodFields = {
  root_node_ids: Ids(VIEW_LIMITS.maxRoots),
  depth: z.number().int().min(1).max(VIEW_LIMITS.maxTraversalDepth).default(1),
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  edge_types: z.array(z.string().trim().min(1).max(200)).max(VIEW_LIMITS.maxEdgeTypes).default([]),
  max_nodes: z.number().int().min(1).max(VIEW_LIMITS.maxTraversalNodes).default(VIEW_LIMITS.maxTraversalNodes),
  max_edges: z.number().int().min(1).max(VIEW_LIMITS.maxTraversalEdges).default(VIEW_LIMITS.maxTraversalEdges),
} as const;

const WorkspaceScope = z.object({
  schema_version: z.literal(RAG_SCOPE_SCHEMA_VERSION),
  type: z.literal("workspace"),
  graph_expansion: GraphExpansion.default("broad"),
}).strict();

const ViewScope = z.object({
  schema_version: z.literal(RAG_SCOPE_SCHEMA_VERSION),
  type: z.literal("view"),
  view_id: z.string().trim().min(1).max(200),
  graph_expansion: GraphExpansion,
}).strict();

const TagsScope = z.object({
  schema_version: z.literal(RAG_SCOPE_SCHEMA_VERSION),
  type: z.literal("tags"),
  tags_any: Tags,
  tags_all: Tags,
  graph_expansion: GraphExpansion,
}).strict().superRefine((value, ctx) => {
  if (value.tags_any.length === 0 && value.tags_all.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tags scope requires tags_any or tags_all" });
  }
});

const SelectionScope = z.object({
  schema_version: z.literal(RAG_SCOPE_SCHEMA_VERSION),
  type: z.literal("selection"),
  node_ids: Ids(VIEW_LIMITS.maxTraversalNodes),
  graph_expansion: GraphExpansion,
}).strict().superRefine((value, ctx) => {
  if (value.node_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["node_ids"], message: "selection requires at least one node id" });
  }
});

const NeighborhoodScope = z.object({
  schema_version: z.literal(RAG_SCOPE_SCHEMA_VERSION),
  type: z.literal("neighborhood"),
  ...NeighborhoodFields,
  graph_expansion: GraphExpansion,
}).strict().superRefine((value, ctx) => {
  if (value.root_node_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["root_node_ids"], message: "neighborhood requires at least one root node id" });
  }
});

const AutoNeighborhood = z.object(NeighborhoodFields).strict().superRefine((value, ctx) => {
  if (value.root_node_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["root_node_ids"], message: "auto neighborhood requires roots" });
  }
});

const AutoScope = z.object({
  schema_version: z.literal(RAG_SCOPE_SCHEMA_VERSION),
  type: z.literal("auto"),
  view_id: z.string().trim().min(1).max(200).optional(),
  tags_any: Tags,
  tags_all: Tags,
  node_ids: Ids(VIEW_LIMITS.maxTraversalNodes),
  neighborhood: AutoNeighborhood.optional(),
  graph_expansion: GraphExpansion.default("broad"),
}).strict();

export const RetrievalScopeSchema = z.union([
  WorkspaceScope,
  ViewScope,
  TagsScope,
  SelectionScope,
  NeighborhoodScope,
  AutoScope,
]);

export type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;
export type RetrievalScopeType = RetrievalScope["type"];
export type RetrievalLaneName = "workspace" | "view" | "tags" | "selection" | "neighborhood";

export interface RetrievalLane {
  name: RetrievalLaneName;
  node_ids: string[] | null;
  /** Applied only after per-lane score normalization, before global reranking. */
  boost: number;
}

export interface RetrievalScopeMetadata {
  schema_version: typeof RAG_SCOPE_SCHEMA_VERSION;
  type: RetrievalScopeType;
  size: number;
  workspace_size: number;
  graph_expansion: "strict" | "broad";
  global_lane: boolean;
  can_expand_to_workspace: boolean;
  expanded_to_workspace: boolean;
  lanes: Array<{ name: RetrievalLaneName; size: number; boost: number }>;
  /**
   * Set when the answer came from the keyword scorer rather than the vector
   * index — no embeddings configured, or the vector search failed. Ranking is
   * coarser and there is no block granularity; a caller that gets this on a
   * Supabase workspace is looking at a configuration problem, and should not
   * be left to wonder why the answers got worse.
   */
  keyword_fallback?: true;
}

export interface ResolvedRetrievalScope {
  input: RetrievalScope;
  lanes: RetrievalLane[];
  /** Null means the whole workspace is allowed during graph expansion. */
  strict_node_ids: Set<string> | null;
  metadata: RetrievalScopeMetadata;
}

export const WORKSPACE_RAG_SCOPE: RetrievalScope = {
  schema_version: RAG_SCOPE_SCHEMA_VERSION,
  type: "workspace",
  graph_expansion: "broad",
};

/** Validates a raw `scope` argument; `null`/`undefined` mean the whole workspace. */
export function parseRetrievalScope(input: unknown): RetrievalScope {
  return RetrievalScopeSchema.parse(input ?? WORKSPACE_RAG_SCOPE);
}

/**
 * Expands a scope into lanes of node ids restricted to the storage's own
 * workspace and, when `kinds` is given, to those node kinds. Lane boosts are
 * the relative weights `rag.ts` applies after per-lane normalization.
 */
export async function resolveRetrievalScope(input: {
  storage: Storage;
  scope?: unknown;
  principal?: ViewPrincipal;
  kinds?: readonly NodeKind[];
}): Promise<ResolvedRetrievalScope> {
  const scope = parseRetrievalScope(input.scope);
  const workspaceNodes = (await input.storage.listNodes({ limit: 5_000 }))
    .filter((node) => node.workspace_id === input.storage.workspace.id);
  const workspaceIds = new Set(workspaceNodes.map((node) => node.id));
  const kindIds = input.kinds && input.kinds.length > 0
    ? new Set(workspaceNodes.filter((node) => input.kinds!.includes(node.kind)).map((node) => node.id))
    : null;
  const lanes: RetrievalLane[] = [];

  const addLane = (name: RetrievalLaneName, ids: Iterable<string> | null, boost: number) => {
    const source = ids === null ? (kindIds ? [...kindIds] : null) : [...ids];
    const nodeIds = source === null
      ? null
      : uniqueSorted(source.filter((id) => workspaceIds.has(id) && (!kindIds || kindIds.has(id))));
    lanes.push({ name, node_ids: nodeIds, boost });
  };

  if (scope.type === "workspace") {
    addLane("workspace", null, 1);
  } else if (scope.type === "view") {
    addLane("view", await resolveViewIds(input.storage, input.principal, scope.view_id), 1);
  } else if (scope.type === "tags") {
    addLane("tags", await resolveTagIds(input.storage, scope.tags_any, scope.tags_all), 1);
  } else if (scope.type === "selection") {
    addLane("selection", scope.node_ids, 1);
  } else if (scope.type === "neighborhood") {
    addLane("neighborhood", await resolveNeighborhoodIds(input.storage, scope), 1);
  } else {
    if (scope.view_id) addLane("view", await resolveViewIds(input.storage, input.principal, scope.view_id), 1.15);
    if (scope.tags_any.length > 0 || scope.tags_all.length > 0) {
      addLane("tags", await resolveTagIds(input.storage, scope.tags_any, scope.tags_all), 1.1);
    }
    if (scope.node_ids.length > 0) addLane("selection", scope.node_ids, 1.25);
    if (scope.neighborhood) {
      addLane("neighborhood", await resolveNeighborhoodIds(input.storage, scope.neighborhood), 1.2);
    }
    // Auto is recall-preserving by contract. The global lane is explicit in
    // metadata and always participates, even when no hints were supplied.
    addLane("workspace", null, 0.65);
  }

  const strictIds = scope.type === "workspace" || scope.type === "auto"
    ? null
    : new Set(lanes.flatMap((lane) => lane.node_ids ?? [...workspaceIds]));
  const primarySize = scope.type === "workspace" || scope.type === "auto"
    ? workspaceIds.size
    : strictIds?.size ?? 0;
  return {
    input: scope,
    lanes,
    strict_node_ids: strictIds,
    metadata: {
      schema_version: RAG_SCOPE_SCHEMA_VERSION,
      type: scope.type,
      size: primarySize,
      workspace_size: workspaceIds.size,
      graph_expansion: scope.graph_expansion,
      global_lane: lanes.some((lane) => lane.name === "workspace"),
      can_expand_to_workspace: scope.type !== "workspace" && scope.type !== "auto",
      expanded_to_workspace: false,
      lanes: lanes.map((lane) => ({
        name: lane.name,
        size: lane.node_ids?.length ?? workspaceIds.size,
        boost: lane.boost,
      })),
    },
  };
}

async function resolveViewIds(storage: Storage, principal: ViewPrincipal | undefined, viewId: string): Promise<string[]> {
  if (!principal) throw new Error("view scope requires an authenticated view principal");
  const view = await getView(storage, principal, viewId);
  return (await resolveViewQuery(storage, view.query)).node_ids;
}

async function resolveTagIds(storage: Storage, tagsAny: string[], tagsAll: string[]): Promise<string[]> {
  return (await resolveViewQuery(storage, {
    schema_version: VIEW_QUERY_SCHEMA_VERSION,
    tags_any: tagsAny,
    tags_all: tagsAll,
  })).node_ids;
}

async function resolveNeighborhoodIds(
  storage: Storage,
  neighborhood: Pick<z.infer<typeof NeighborhoodScope>, "root_node_ids" | "depth" | "direction" | "edge_types" | "max_nodes" | "max_edges">,
): Promise<string[]> {
  return (await resolveViewQuery(storage, {
    schema_version: VIEW_QUERY_SCHEMA_VERSION,
    root_node_ids: neighborhood.root_node_ids,
    traversal: {
      depth: neighborhood.depth,
      direction: neighborhood.direction,
      edge_types: neighborhood.edge_types,
      max_nodes: neighborhood.max_nodes,
      max_edges: neighborhood.max_edges,
    },
  })).node_ids;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

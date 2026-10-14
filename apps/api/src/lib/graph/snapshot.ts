/**
 * Workspace graph snapshot for agentic chats.
 *
 * The agentic chat does not pre-load file bodies into the prompt. Instead it
 * gets a compact markdown description of the whole workspace — every node's
 * id, title, kind, tags, parent, and outgoing references — so it can pick which
 * nodes to actually read with the `read_node` tool.
 *
 * When an `activeNodeId` is provided, the active node and its level-1 and
 * level-2 neighbours (in either direction) are visually marked so the model
 * keeps a sense of "where the user is" without losing access to the rest of
 * the graph.
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { findForwardLinks } from "@bcontext-dev/contract/backlinks";
import { extractBlockIds } from "@bcontext-dev/contract/rag/chunk";
import { readSubtasks, subtaskProgress } from "@bcontext-dev/contract/subtasks";

export interface SnapshotOptions {
  activeNodeId?: string | null;
  /** Hard cap on nodes serialised. Defaults to 400. */
  maxNodes?: number;
  /** Hard cap on references listed per node. Defaults to 12. */
  maxRefsPerNode?: number;
}

type NodeLite = Pick<
  KnowledgeNode,
  | "id"
  | "title"
  | "slug"
  | "kind"
  | "tags"
  | "parent_id"
  | "content_md"
  | "status"
  | "data"
>;

/** depth: 0 = active, 1 = direct neighbour, 2 = neighbour-of-neighbour. */
type Depth = 0 | 1 | 2;

const FOCUS_MARK: Record<Depth, string> = {
  0: "★ ACTIVE",
  1: "◐ near",
  2: "◌ context",
};

export function buildGraphSnapshot(
  workspaceName: string,
  nodes: NodeLite[],
  options: SnapshotOptions = {},
): string {
  const maxNodes = options.maxNodes ?? 400;
  const maxRefsPerNode = options.maxRefsPerNode ?? 12;
  const activeNodeId = options.activeNodeId ?? null;

  // Compute focus marks first so we know which subset to surface up-front.
  const focus = activeNodeId
    ? computeFocus(nodes, activeNodeId)
    : new Map<string, Depth>();

  // Sort: focused nodes first (active → near → context), then the rest by
  // title. Truncate once we hit `maxNodes`.
  const sorted = [...nodes].sort((a, b) => {
    const da = focus.get(a.id);
    const db = focus.get(b.id);
    if (da !== undefined && db === undefined) return -1;
    if (db !== undefined && da === undefined) return 1;
    if (da !== undefined && db !== undefined && da !== db) return da - db;
    return a.title.localeCompare(b.title);
  });
  const trimmed = sorted.slice(0, maxNodes);
  const skipped = sorted.length - trimmed.length;

  const refsByNode = new Map<string, string[]>();
  for (const n of trimmed) {
    const refs = findForwardLinks(nodes, {
      id: n.id,
      content_md: n.content_md,
      data: n.data,
    })
      .slice(0, maxRefsPerNode)
      .map((r) => `/n/${r.id}`);
    refsByNode.set(n.id, refs);
  }

  // Block listings per node. Only nodes with ≥2 real blocks get a
  // `blocks:[#a, #b]` suffix — single-H2 / no-H2 docs are "monolithic"
  // and the model can infer that from the title alone, no need to spend
  // tokens advertising it. The active node skips the 8-block cap so the
  // model has full granularity on the doc the user is touching.
  const blocksByNode = new Map<string, string[]>();
  for (const n of trimmed) {
    const ids = blockIdsForSnapshot(n.content_md);
    if (ids.length >= 2) blocksByNode.set(n.id, ids);
  }

  const lines: string[] = [];
  lines.push(`# Workspace graph: ${workspaceName}`);
  lines.push("");
  lines.push(
    `${nodes.length} node(s). Each line below is one node; the agent can read or edit any of them by id.`,
  );
  if (activeNodeId) {
    lines.push(
      `Active focus is marked ${FOCUS_MARK[0]}; level-1 neighbours ${FOCUS_MARK[1]}; level-2 ${FOCUS_MARK[2]}.`,
    );
  }
  lines.push(
    "Multi-block nodes carry a `blocks:[#a, #b, …]` suffix; call `read_block(node_id, block_id)` to read just one section instead of the whole node, and `replace_in_block` for surgical edits within one block.",
  );
  lines.push("");
  lines.push("## Nodes");
  for (const n of trimmed) {
    const id = `/n/${n.id}`;
    const kindBits: string[] = [n.kind];
    if (n.status) kindBits.push(n.status);
    const meta = `[${kindBits.join(" · ")}]`;
    const mark = focus.get(n.id);
    const focusBadge = mark !== undefined ? ` [${FOCUS_MARK[mark]}]` : "";
    const parent = n.parent_id ? ` parent:/n/${n.parent_id}` : "";
    const refIds = refsByNode.get(n.id) ?? [];
    const refs = refIds.length ? ` → ${refIds.join(", ")}` : "";
    const titleSafe = n.title.replace(/\s+/g, " ").trim();
    const tags = n.tags.length
      ? ` tags:[${n.tags.map((tag) => `#${tag.slug}`).join(", ")}]`
      : "";
    const allBlocks = blocksByNode.get(n.id);
    const blocksSuffix = allBlocks
      ? ` blocks:${formatBlockList(allBlocks, n.id === activeNodeId)}`
      : "";
    // Subtask progress, so the model knows a task has steps inside without
    // reading it: "subtasks:2/5" is the whole story at snapshot altitude.
    const progress = subtaskProgress(readSubtasks(n.data));
    const subtasksSuffix = progress.total > 0 ? ` subtasks:${progress.done}/${progress.total}` : "";
    lines.push(
      `- ${id} ${meta}${focusBadge} "${titleSafe}"${tags}${parent}${refs}${blocksSuffix}${subtasksSuffix}`,
    );
  }
  if (skipped > 0) {
    lines.push("");
    lines.push(
      `…(${skipped} additional node(s) omitted from this snapshot; call read_node by id if you need any of them).`,
    );
  }
  return lines.join("\n");
}

/**
 * Map every node in the level-2 neighbourhood of `activeNodeId` to its depth.
 * Direction-agnostic: the level-1 set is the union of forward and backward
 * neighbours. Level 2 is the union of forward + backward neighbours of every
 * level-1 node minus the active node and minus level 1 itself.
 */
function computeFocus(
  nodes: NodeLite[],
  activeNodeId: string,
): Map<string, Depth> {
  const out = new Map<string, Depth>();
  const byId = new Map<string, NodeLite>();
  for (const n of nodes) byId.set(n.id, n);
  const center = byId.get(activeNodeId);
  if (!center) return out;

  out.set(center.id, 0);

  function neighbours(n: NodeLite): NodeLite[] {
    const forward = findForwardLinks(nodes, {
      id: n.id,
      content_md: n.content_md,
      data: n.data,
    })
      .map((r) => byId.get(r.id))
      .filter((x): x is NodeLite => Boolean(x));
    const backward = nodes.filter((other) => {
      if (other.id === n.id) return false;
      const refs = findForwardLinks(nodes, {
        id: other.id,
        content_md: other.content_md,
        data: other.data,
      });
      return refs.some((r) => r.id === n.id);
    });
    return [...forward, ...backward];
  }

  const level1 = neighbours(center);
  for (const n of level1) {
    if (!out.has(n.id)) out.set(n.id, 1);
  }
  for (const l1 of level1) {
    for (const n of neighbours(l1)) {
      if (!out.has(n.id)) out.set(n.id, 2);
    }
  }
  return out;
}

/** Cap on block ids advertised per non-active node. */
const SNAPSHOT_BLOCKS_PER_NODE_MAX = 8;

/**
 * Derived block ids for a node's snapshot suffix. Sentinel ids
 * (`_intro`, `_unblocked`) are filtered — they're not addressable in a
 * way that meaningfully helps the model pick a block; if a node only
 * has sentinel ids we treat it as monolithic and the caller will skip
 * the `blocks:[…]` suffix anyway.
 */
function blockIdsForSnapshot(content_md: string | null | undefined): string[] {
  const md = content_md ?? "";
  if (!md.trim()) return [];
  return extractBlockIds(md).filter(
    (id) => id !== "_intro" && id !== "_unblocked",
  );
}

/**
 * Render the `blocks:[…]` payload for one node. Active nodes get the
 * full list (no cap) because the user is actively editing them and the
 * model needs full granularity; everyone else is capped at
 * SNAPSHOT_BLOCKS_PER_NODE_MAX with a `+N more` suffix on overflow.
 */
function formatBlockList(ids: string[], isActive: boolean): string {
  if (isActive || ids.length <= SNAPSHOT_BLOCKS_PER_NODE_MAX) {
    return `[${ids.map((b) => `#${b}`).join(", ")}]`;
  }
  const head = ids.slice(0, SNAPSHOT_BLOCKS_PER_NODE_MAX);
  const more = ids.length - SNAPSHOT_BLOCKS_PER_NODE_MAX;
  return `[${head.map((b) => `#${b}`).join(", ")}, +${more} more]`;
}

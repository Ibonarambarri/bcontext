/**
 * Node selection model: ONE floating panel over the active surface.
 *
 * A node opened from any renderer (graph, board, list, changes, links inside
 * another node, the global search) shows in a floating panel that takes
 * half of the active surface by default and can expand to all of it. The
 * panel keeps its own back/forward history so following links never loses
 * the trail. The `/n/<id>` route stays the "open as page" escape hatch.
 */

const NODE_PANEL_SIZES = ["half", "full"] as const;
export type NodePanelSize = (typeof NODE_PANEL_SIZES)[number];

export function isNodePanelSize(value: unknown): value is NodePanelSize {
  return typeof value === "string" && (NODE_PANEL_SIZES as readonly string[]).includes(value);
}

/**
 * The retired five-way "opening nodes" preference (preview popup / side
 * panel / full node…) collapses onto a panel size, so an account that had
 * chosen it keeps the closest behavior. Unknown values → null.
 */
export function panelSizeFromLegacy(value: unknown): NodePanelSize | null {
  if (isNodePanelSize(value)) return value;
  if (value === "full_node_directly" || value === "preview_then_full_node") return "full";
  if (value === "preview_popup" || value === "side_panel_directly" || value === "preview_then_side_panel") return "half";
  return null;
}

export interface NodeSelection {
  id: string;
  blockId: string | null;
}

export interface NodeHistory {
  entries: NodeSelection[];
  /** -1 when nothing is open. */
  index: number;
}

export const EMPTY_NODE_HISTORY: NodeHistory = { entries: [], index: -1 };
export const NODE_HISTORY_LIMIT = 50;

/** The entry the panel is showing, or null when it is closed. */
export function currentNodeSelection(history: NodeHistory): NodeSelection | null {
  return history.index >= 0 ? history.entries[history.index] ?? null : null;
}

/**
 * Open a node: becomes the current entry, forward entries are dropped (like
 * a browser). Re-selecting the current node (e.g. to jump to another block)
 * updates it in place instead of stacking a duplicate.
 */
export function pushNodeHistory(history: NodeHistory, selection: NodeSelection): NodeHistory {
  const current = currentNodeSelection(history);
  if (current && current.id === selection.id) {
    if (current.blockId === selection.blockId) return history;
    const entries = history.entries.slice();
    entries[history.index] = selection;
    return { entries, index: history.index };
  }
  const kept = history.entries.slice(0, history.index + 1);
  kept.push(selection);
  const overflow = Math.max(0, kept.length - NODE_HISTORY_LIMIT);
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, index: entries.length - 1 };
}

export function canGoBack(history: NodeHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: NodeHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/** Move along the history; out-of-range steps return the same history. */
export function stepNodeHistory(history: NodeHistory, delta: -1 | 1): NodeHistory {
  const index = history.index + delta;
  if (index < 0 || index >= history.entries.length) return history;
  return { entries: history.entries, index };
}

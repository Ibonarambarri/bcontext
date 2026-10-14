/**
 * Workspace realtime events that can change either a board card or a query's
 * membership; the board view resubscribes on exactly these and ignores the
 * rest of the stream.
 */
export const BOARD_REALTIME_EVENTS = [
  "node.created",
  "node.updated",
  "node.renamed",
  "node.deleted",
  "node.moved",
  "tree.invalidated",
  "view.changed",
] as const;

/** Events that can change graph membership, resources, labels or edges. */
export const GRAPH_REALTIME_EVENTS = [
  "node.created",
  "node.updated",
  "node.renamed",
  "node.deleted",
  "node.moved",
  "tree.invalidated",
  "view.changed",
  "backlink.changed",
  "graph.changed",
] as const;

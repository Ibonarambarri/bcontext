/**
 * The one dependency rule behind "what can I start now".
 *
 * It used to live inline in the MCP `nodes(op=list)` handler, which meant a
 * saved view could not ask the same question and an agent that wanted the
 * queue in a board had to re-derive it. Now the view resolver, the MCP list
 * (through the resolver) and `brief` all call this, so the three answers are
 * the same list by construction rather than by care.
 *
 * Rules, all deliberate:
 *   - Only actionable nodes qualify: a node with no status (a doc, a decision
 *     that was never given a workflow) is not "startable"; nor is one whose
 *     status is terminal (done, archived).
 *   - A blocker blocks while it is not terminal. Done and archived blockers
 *     do not — nothing further happens to them — and neither does a dangling
 *     edge to a node that no longer exists (or is out of the caller's reach:
 *     `byId` is whatever index the caller could see).
 */
import { isTerminalStatus, type KnowledgeNode } from "@bcontext-dev/contract/types";
import type { NodeEdge } from "@/lib/storage";

export type BlockerIndex = Map<string, string[]>;

/** node id → ids of the nodes it waits on (`blocked_by` edges only). */
export function indexBlockers(edges: readonly NodeEdge[]): BlockerIndex {
  const blockers: BlockerIndex = new Map();
  for (const edge of edges) {
    if (edge.relation !== "blocked_by") continue;
    const list = blockers.get(edge.from_node) ?? [];
    list.push(edge.to_node);
    blockers.set(edge.from_node, list);
  }
  return blockers;
}

export function isUnblocked(
  node: Pick<KnowledgeNode, "id" | "status">,
  blockers: BlockerIndex,
  byId: ReadonlyMap<string, Pick<KnowledgeNode, "status">>,
): boolean {
  if (node.status === null || isTerminalStatus(node.status)) return false;
  return (blockers.get(node.id) ?? []).every((id) => {
    const blocker = byId.get(id);
    return !blocker || isTerminalStatus(blocker.status);
  });
}

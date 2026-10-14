import type { KnowledgeNode } from "@bcontext-dev/contract/types";

/**
 * Optimistic board move bookkeeping.
 *
 * A drop applies the visual move synchronously (the kanban ListData is the
 * single visual source of truth) and records a `PendingBoardMove` keyed by
 * node id. Canonical data (workspace nodes + view resolve) keeps flowing
 * underneath; `reconcileBoardCard` decides, per card, whether the canonical
 * value should win yet or the optimistic column must be preserved.
 *
 * The contract that kills the "card snaps back" race: the pending record is
 * written *synchronously at drop time* (a ref, not React state), so no
 * render/effect pass can ever observe "list already moved, pending unknown".
 */
export interface PendingBoardMove {
  /** Target column value of the optimistic move. */
  value: string;
  /** node.updated_at at drop time — canonical is stale while it still matches. */
  baseUpdatedAt: string;
}

/** One card's verdict from `reconcileBoardCard`. */
export interface BoardCardReconciliation {
  /** Column the card should display after this reconcile pass. */
  column: string;
  /** True when the pending overlay is finished and must be dropped. */
  settled: boolean;
}

/**
 * Decide the column for one card given its canonical state and the pending
 * optimistic move (if any).
 *
 * - No pending move → canonical wins (normal resync path).
 * - Canonical still stale (same `updated_at` as at drop time, different
 *   column) → keep the optimistic column; the move is in flight.
 * - Canonical caught up (`updated_at` advanced — our PATCH confirmed, or a
 *   concurrent writer superseded us) or already equals the target → trust
 *   the server value and settle. When the server confirmed our move this is
 *   a visual no-op; when someone else won, their value shows (per the
 *   optimistic-UI decision: conflicts must never be hidden).
 */
export function reconcileBoardCard({
  canonicalColumn,
  canonicalUpdatedAt,
  currentColumn,
  pending,
}: {
  canonicalColumn: string;
  canonicalUpdatedAt: string;
  currentColumn: string;
  pending: PendingBoardMove | undefined;
}): BoardCardReconciliation {
  if (!pending) return { column: canonicalColumn, settled: false };
  if (
    canonicalUpdatedAt !== pending.baseUpdatedAt ||
    canonicalColumn === pending.value
  ) {
    return { column: canonicalColumn, settled: true };
  }
  return { column: currentColumn, settled: false };
}

/**
 * Fields of a freshly-PATCHed node that the workspace summary overlay needs
 * so every renderer converges on the confirmed state without a refetch.
 * `updated_at` is load-bearing twice: it settles the board's pending move
 * and it lets the overlay be pruned once server data catches up.
 */
export function boardMoveSummary(node: KnowledgeNode): Partial<KnowledgeNode> {
  return {
    status: node.status,
    priority: node.priority,
    due_date: node.due_date,
    parent_id: node.parent_id,
    data: node.data,
    tags: node.tags,
    updated_at: node.updated_at,
  };
}

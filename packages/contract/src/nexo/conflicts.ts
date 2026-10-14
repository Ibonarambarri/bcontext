/**
 * NEXO conflicts — the only thing a human reviews now.
 *
 * NEXO writes to the graph on its own when it is sure. When it is not — a
 * signal contradicts what the graph says without acknowledging a change, a
 * candidate comes out below the auto-accept threshold, or a node looks
 * stale — it opens a conflict instead. The human answers in free text and
 * NEXO turns that answer into node operations.
 */
export type NexoConflictKind = "contradiction" | "doubt" | "stale";
export type NexoConflictStatus = "open" | "resolved" | "dismissed";

export const NEXO_CONFLICT_KINDS: readonly NexoConflictKind[] = [
  "contradiction",
  "doubt",
  "stale",
] as const;

export const NEXO_CONFLICT_KIND_LABEL: Record<NexoConflictKind, string> = {
  contradiction: "Contradiction",
  doubt: "Doubt",
  stale: "Stale",
};

export interface NexoConflictEvidence {
  /** connector_id the signal came from. */
  source: string;
  external_id?: string;
  url?: string;
  /** Exact quote from the signal or the node. */
  excerpt: string;
  /** ISO timestamp of the signal, when known. */
  at?: string;
}

export interface NexoResolutionAction {
  op:
    | "accept_candidate"
    | "accept_candidate_edited"
    | "dismiss_candidate"
    /** One H2 block of an existing node rewritten or added; NEXO never rewrites a whole node. */
    | "update_block"
    | "append_block"
    /** Rows resolved before 2026-09-11 still carry this op. */
    | "update_node"
    | "supersede_node"
    | "create_decision"
    | "no_change";
  node_id?: string;
  title?: string;
  /** Short human sentence for the audit trail. */
  note?: string;
}

export interface NexoResolution {
  summary: string;
  actions: NexoResolutionAction[];
}

export interface NexoConflict {
  id: string;
  workspace_id: string;
  kind: NexoConflictKind;
  /** One sentence — the list row. */
  summary: string;
  /** What NEXO saw, why it doubts, both sides. Markdown. */
  context_md: string;
  evidence: NexoConflictEvidence[];
  related_node_ids: string[];
  /** ingest_candidates.id when the conflict wraps a candidate. */
  candidate_id: string | null;
  status: NexoConflictStatus;
  decision_text: string | null;
  resolution: NexoResolution | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface NexoConflictRelatedNode {
  id: string;
  title: string;
  kind: string;
}

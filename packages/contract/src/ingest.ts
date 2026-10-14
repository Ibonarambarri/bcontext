/**
 * Ingest candidates — what a connector proposed and a person has to review.
 * Contract between bcontext-api and bcontext-web.
 */
export type IngestCandidateKind = "decision" | "task" | "bug" | "adr";
export type IngestCandidateStatus = "pending" | "accepted" | "dismissed" | "reprocess";

export interface IngestCandidateLink {
  to_node_id: string;
  relation: string;
}

export interface IngestCandidate {
  id: string;
  workspace_id: string;
  source: string;
  external_id: string;
  kind: IngestCandidateKind;
  title: string;
  content_md: string;
  links: IngestCandidateLink[];
  confidence: number | null;
  status: IngestCandidateStatus;
  provenance: Record<string, unknown>;
  created_node_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reprocess_feedback: string | null;
  created_at: string;
}

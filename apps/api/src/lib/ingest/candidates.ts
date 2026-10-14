/**
 * Ingest entry queue: signals -> typed node candidates, reviewed via an
 * inbox before becoming real nodes.
 *
 * This is the generic, connector-agnostic pipeline. A source integration
 * (GitHub, meetings, Slack, the Nango connectors) calls
 * `proposeCandidate()` instead of upserting a node directly for
 * high-precision decision/task/bug/adr signals; a human or an agent then
 * reviews the inbox via REST or the MCP tools and calls
 * `acceptCandidate()`/`dismissCandidate()`.
 *
 * Dismiss preserves the row (never deleted) so provenance is never lost.
 * Re-proposing the same (workspace, source, external_id) only overwrites
 * a still-`pending` row — an accepted or dismissed decision is never
 * silently resurrected by a redelivered signal.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  capabilityProvenanceData,
  invocationIdFromProvenance,
  linkInvocationToNode,
} from "@/lib/capabilities/provenance";
import type { Storage } from "@/lib/storage";
import { getStorageById } from "@/lib/storage";
import type { NodeEdge } from "@/lib/storage";

export type {
  IngestCandidate,
  IngestCandidateKind,
  IngestCandidateLink,
  IngestCandidateStatus,
} from "@bcontext-dev/contract/ingest";
import type {
  IngestCandidate,
  IngestCandidateKind,
  IngestCandidateLink,
  IngestCandidateStatus,
} from "@bcontext-dev/contract/ingest";

export interface ProposeCandidateInput {
  workspaceId: string;
  source: string;
  externalId: string;
  kind: IngestCandidateKind;
  title: string;
  contentMd: string;
  links?: IngestCandidateLink[];
  confidence?: number | null;
  provenance?: Record<string, unknown>;
  /**
   * Explicit, visible auto-accept rule for this proposal — e.g.
   * `confidence >= 0.95`. Left undefined by default; a call site must
   * opt in on purpose, there is no implicit auto-accept.
   */
  autoAccept?: boolean;
  /**
   * Hand the candidate to NEXO triage right after it lands (contradiction
   * check → auto-accept above threshold → otherwise a `doubt` conflict).
   * Opt-in per call site; the Nango batch path and the native extractors
   * pass it, tests and the REST re-propose paths do not.
   */
  triage?: boolean;
}

function row(): ReturnType<typeof getSupabaseAdmin> {
  return getSupabaseAdmin();
}

/**
 * Insert a new pending candidate, or refresh an existing still-pending one
 * for the same (workspace, source, external_id). No-ops (returns the
 * existing row untouched) once a candidate has been accepted or dismissed.
 */
export async function proposeCandidate(
  input: ProposeCandidateInput,
): Promise<IngestCandidate> {
  const sb = row();
  const { data: existing } = await sb
    .from("ingest_candidates")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("source", input.source)
    .eq("external_id", input.externalId)
    .maybeSingle();

  if (existing && existing.status !== "pending") {
    return existing as IngestCandidate;
  }

  const payload = {
    workspace_id: input.workspaceId,
    source: input.source,
    external_id: input.externalId,
    kind: input.kind,
    title: input.title,
    content_md: input.contentMd,
    links: input.links ?? [],
    confidence: input.confidence ?? null,
    provenance: input.provenance ?? {},
  };

  const { data, error } = existing
    ? await sb
        .from("ingest_candidates")
        .update(payload)
        .eq("id", existing.id)
        .select("*")
        .single()
    : await sb
        .from("ingest_candidates")
        .insert({ ...payload, status: "pending" })
        .select("*")
        .single();
  if (error || !data) throw new Error(`proposeCandidate: ${error?.message}`);

  const candidate = data as IngestCandidate;
  if (input.autoAccept) {
    // Auto-accept runs during connector ingestion, which has no principal —
    // there is nobody whose reach could apply. The system grant is explicit so
    // this shows up in an audit rather than being an unscoped storage that
    // happens to look like every other one.
    const inner = await getStorageById(candidate.workspace_id);
    if (!inner) throw new Error(`proposeCandidate: workspace not found`);
    const { systemGrant } = await import("@/lib/auth/grants");
    const { scopedStorage } = await import("@/lib/storage/scoped");
    const storage = scopedStorage(
      inner,
      systemGrant(candidate.workspace_id, "connector ingestion auto-accept"),
    );
    return acceptCandidate(storage, candidate.id, null);
  }
  if (input.triage && candidate.status === "pending") {
    const { triageCandidate } = await import("@/lib/nexo/triage");
    const outcome = await triageCandidate(candidate);
    if (outcome.kind === "accepted") {
      return (await getCandidate(candidate.id, candidate.workspace_id)) ?? candidate;
    }
  }
  return candidate;
}

export async function listCandidates(
  workspaceId: string,
  opts?: { status?: IngestCandidateStatus },
): Promise<IngestCandidate[]> {
  const sb = row();
  let query = sb
    .from("ingest_candidates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (opts?.status) query = query.eq("status", opts.status);
  const { data, error } = await query;
  if (error) throw new Error(`listCandidates: ${error.message}`);
  return (data ?? []) as IngestCandidate[];
}

/**
 * Head-only count — the dashboard badge needs a number, never the candidate
 * rows (each carries full content_md + provenance payloads).
 */
export async function countCandidates(
  workspaceId: string,
  opts?: { status?: IngestCandidateStatus },
): Promise<number> {
  const sb = row();
  let query = sb
    .from("ingest_candidates")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (opts?.status) query = query.eq("status", opts.status);
  const { count, error } = await query;
  if (error) throw new Error(`countCandidates: ${error.message}`);
  return count ?? 0;
}

/**
 * Fetch a candidate, scoped to the workspace the caller was authorised for.
 *
 * `workspaceId` is not optional and not derived from the row: deriving it is
 * exactly the bug this signature exists to prevent. The id comes from the
 * caller, so without this filter a principal authorised for its own workspace
 * could name a candidate belonging to another and have the row — full
 * `content_md` and provenance — handed back, then materialised as a node in
 * *that* tenant's workspace.
 */
export async function getCandidate(
  id: string,
  workspaceId: string,
): Promise<IngestCandidate | null> {
  const sb = row();
  const { data } = await sb
    .from("ingest_candidates")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return (data as IngestCandidate | null) ?? null;
}

export class IngestCandidateError extends Error {
  code: "not_found" | "not_pending";
  constructor(code: IngestCandidateError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "IngestCandidateError";
  }
}

/**
 * Accept a pending candidate: creates the node (stamping
 * `data.ingest_candidate_id`/`data.ingest_source` for the provenance
 * metric), creates its declared links, and marks the candidate accepted.
 */
export async function acceptCandidate(
  storage: Storage,
  id: string,
  reviewerUserId: string | null,
): Promise<IngestCandidate> {
  const candidate = await getCandidate(id, storage.workspace.id);
  if (!candidate) throw new IngestCandidateError("not_found", `candidate not found: ${id}`);
  if (candidate.status !== "pending" && candidate.status !== "reprocess") {
    throw new IngestCandidateError(
      "not_pending",
      `candidate ${id} is already ${candidate.status}`,
    );
  }

  // The caller's storage, already narrowed to its grant — not one built from
  // the candidate's own workspace_id. Building it here is what let a candidate
  // from another tenant be materialised into that tenant, and it also skipped
  // the write verb entirely.
  // A candidate that a connector stamped with a gateway receipt converges
  // with a manual `nodes_write(op=create, provenance)`: same data.provenance
  // shape on the node, same capability_invocations.node_id link.
  const invocationId = invocationIdFromProvenance(candidate.provenance);
  const capabilityProvenance = invocationId
    ? capabilityProvenanceData({
        capability: String(candidate.provenance?.capability ?? candidate.source),
        tool: String(candidate.provenance?.tool ?? candidate.source),
        invocation_id: invocationId,
      })
    : null;
  const node = await storage.createNode({
    parent_id: null,
    kind: candidate.kind,
    title: candidate.title,
    content_md: candidate.content_md,
    data: {
      ingest_candidate_id: candidate.id,
      ingest_source: candidate.source,
      ingest_external_id: candidate.external_id,
      ...(capabilityProvenance ? { provenance: capabilityProvenance } : {}),
    },
  });
  if (invocationId) {
    await linkInvocationToNode({ workspaceId: storage.workspace.id, invocationId, nodeId: node.id });
  }

  for (const link of candidate.links) {
    await storage.createEdge({
      from_node: node.id,
      to_node: link.to_node_id,
      relation: link.relation,
    });
  }

  const sb = row();
  const { data, error } = await sb
    .from("ingest_candidates")
    .update({
      status: "accepted",
      created_node_id: node.id,
      reviewed_by: reviewerUserId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`acceptCandidate: ${error?.message}`);
  return data as IngestCandidate;
}

export async function dismissCandidate(
  workspaceId: string,
  id: string,
  reviewerUserId: string | null,
): Promise<IngestCandidate> {
  const candidate = await getCandidate(id, workspaceId);
  if (!candidate) throw new IngestCandidateError("not_found", `candidate not found: ${id}`);
  if (candidate.status !== "pending") {
    throw new IngestCandidateError(
      "not_pending",
      `candidate ${id} is already ${candidate.status}`,
    );
  }

  const sb = row();
  const { data, error } = await sb
    .from("ingest_candidates")
    .update({
      status: "dismissed",
      reviewed_by: reviewerUserId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`dismissCandidate: ${error?.message}`);
  return data as IngestCandidate;
}

/**
 * Marks a candidate `reprocess` with the reviewer's feedback so the next
 * extraction pass re-reads the signal with that guidance. Accepted
 * candidates cannot be sent back: their node already exists.
 */
export async function sendToReprocess(
  workspaceId: string,
  id: string,
  reviewerUserId: string | null,
  feedback: string | null,
): Promise<IngestCandidate> {
  const candidate = await getCandidate(id, workspaceId);
  if (!candidate) throw new IngestCandidateError("not_found", `candidate not found: ${id}`);
  if (candidate.status === "accepted") {
    throw new IngestCandidateError("not_pending", `candidate ${id} is already accepted`);
  }

  const sb = row();
  const { data, error } = await sb
    .from("ingest_candidates")
    .update({
      status: "reprocess",
      reprocess_feedback: feedback,
      reviewed_by: reviewerUserId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`sendToReprocess: ${error?.message}`);
  return data as IngestCandidate;
}

/**
 * Generic status transition for the Procesamiento drag-and-drop board —
 * covers all 4 columns (pending/reprocess/accepted/dismissed) through one
 * entry point. Moving to `accepted` delegates to `acceptCandidate()` (node
 * creation); every other target is a plain status update. A candidate that
 * has already been accepted is immutable — its node already exists.
 */
export async function setCandidateStatus(
  storage: Storage,
  id: string,
  status: IngestCandidateStatus,
  reviewerUserId: string | null,
  feedback?: string | null,
): Promise<IngestCandidate> {
  const candidate = await getCandidate(id, storage.workspace.id);
  if (!candidate) throw new IngestCandidateError("not_found", `candidate not found: ${id}`);
  if (candidate.status === "accepted") {
    throw new IngestCandidateError("not_pending", `candidate ${id} is already accepted`);
  }

  if (status === "accepted") return acceptCandidate(storage, id, reviewerUserId);
  if (status === "reprocess")
    return sendToReprocess(storage.workspace.id, id, reviewerUserId, feedback ?? null);

  const sb = row();
  const { data, error } = await sb
    .from("ingest_candidates")
    .update({
      status,
      reprocess_feedback: null,
      reviewed_by: reviewerUserId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`setCandidateStatus: ${error?.message}`);
  return data as IngestCandidate;
}

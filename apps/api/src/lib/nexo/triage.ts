/**
 * NEXO triage — what happens to a candidate right after it is proposed.
 *
 * The Review board is gone: NEXO writes on its own when it is sure, and
 * opens a conflict when it is not. In order:
 *
 *   1. contradiction with the graph (LLM judgement over the closest nodes)
 *      → conflict `contradiction`, candidate stays pending
 *   2. confidence >= NEXO_AUTO_ACCEPT_THRESHOLD (default 0.7)
 *      → accepted under the system grant, node created with provenance
 *   3. otherwise → conflict `doubt`, candidate stays pending
 *
 * Best effort end to end: a failure in any step leaves the candidate
 * pending (nothing is lost) and is logged.
 */
import { log } from "@bcontext-dev/contract/log";
import type { IngestCandidate } from "@bcontext-dev/contract/ingest";
import type { NexoConflictEvidence } from "@bcontext-dev/contract/nexo/conflicts";
import { acceptCandidate } from "@/lib/ingest/candidates";
import { getStorageById } from "@/lib/storage";
import { detectContradiction, openConflict } from "./conflicts";

const DEFAULT_AUTO_ACCEPT_THRESHOLD = 0.7;

/** `NEXO_AUTO_ACCEPT_THRESHOLD` in [0, 1]; anything unparseable falls back to the default. */
export function autoAcceptThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NEXO_AUTO_ACCEPT_THRESHOLD);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_AUTO_ACCEPT_THRESHOLD;
}

export type TriageOutcome =
  | { kind: "accepted"; nodeId: string | null }
  | { kind: "conflict"; conflictKind: "contradiction" | "doubt"; conflictId: string }
  | { kind: "pending"; reason: string };

export interface TriageOptions {
  threshold?: number;
  /** Evidence quotes the extractor attached (batch path). */
  evidence?: NexoConflictEvidence[];
  /** Skip the contradiction check (tests, or sources that are the truth). */
  skipContradiction?: boolean;
}

/**
 * Runs the three steps above on one pending candidate. Non-pending
 * candidates are returned untouched; a candidate that is accepted here is
 * written under the system grant with the candidate as provenance.
 */
export async function triageCandidate(
  candidate: IngestCandidate,
  opts: TriageOptions = {},
): Promise<TriageOutcome> {
  if (candidate.status !== "pending") return { kind: "pending", reason: `status_${candidate.status}` };
  const threshold = opts.threshold ?? autoAcceptThreshold();

  // 1. Does the graph disagree?
  if (!opts.skipContradiction) {
    try {
      const verdict = await detectContradiction(candidate.workspace_id, candidate);
      if (verdict?.contradiction) {
        const conflict = await openConflict({
          workspaceId: candidate.workspace_id,
          kind: "contradiction",
          summary: verdict.summary,
          contextMd: verdict.contextMd,
          evidence: [...verdict.evidence, ...(opts.evidence ?? [])],
          relatedNodeIds: verdict.relatedNodeIds,
          candidateId: candidate.id,
        });
        log.info("nexo.triage.contradiction", {
          workspace_id: candidate.workspace_id,
          candidate_id: candidate.id,
          conflict_id: conflict.id,
        });
        return { kind: "conflict", conflictKind: "contradiction", conflictId: conflict.id };
      }
    } catch (err) {
      log.warn("nexo.triage.detect_failed", {
        workspace_id: candidate.workspace_id,
        candidate_id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Sure enough → write.
  const confidence = candidate.confidence ?? 0;
  if (confidence >= threshold) {
    try {
      const inner = await getStorageById(candidate.workspace_id);
      if (!inner) return { kind: "pending", reason: "workspace_not_found" };
      const { systemGrant } = await import("@/lib/auth/grants");
      const { scopedStorage } = await import("@/lib/storage/scoped");
      const storage = scopedStorage(inner, systemGrant(candidate.workspace_id, "NEXO auto-accept"));
      const accepted = await acceptCandidate(storage, candidate.id, null);
      log.info("nexo.triage.accepted", {
        workspace_id: candidate.workspace_id,
        candidate_id: candidate.id,
        node_id: accepted.created_node_id,
        confidence,
      });
      return { kind: "accepted", nodeId: accepted.created_node_id };
    } catch (err) {
      log.warn("nexo.triage.accept_failed", {
        workspace_id: candidate.workspace_id,
        candidate_id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: "pending", reason: "accept_failed" };
    }
  }

  // 3. Not sure → ask.
  try {
    const conflict = await openConflict({
      workspaceId: candidate.workspace_id,
      kind: "doubt",
      summary: `NEXO is not sure this is a real ${candidate.kind}: ${candidate.title}`,
      contextMd: [
        `NEXO extracted this ${candidate.kind} from ${candidate.source} with confidence ${Math.round(confidence * 100)}% (threshold ${Math.round(threshold * 100)}%).`,
        "",
        `## Proposed ${candidate.kind}`,
        `# ${candidate.title}`,
        candidate.content_md,
      ].join("\n"),
      evidence: opts.evidence ?? [],
      candidateId: candidate.id,
    });
    return { kind: "conflict", conflictKind: "doubt", conflictId: conflict.id };
  } catch (err) {
    log.warn("nexo.triage.doubt_failed", {
      workspace_id: candidate.workspace_id,
      candidate_id: candidate.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "pending", reason: "conflict_failed" };
  }
}

/**
 * In-memory ingest candidates for demo (non-Supabase) workspaces.
 *
 * Same contract as `candidates.ts` but backed by a HMR-stable global map,
 * so the Review board is fully explorable — drag, stage, batch-confirm —
 * without Supabase, honouring the repo-wide demo-store fallback principle
 * (see `src/lib/demo-store.ts`). Seeded only for the reference "Context OS"
 * demo workspace; other demo workspaces start empty.
 *
 * Accepting here never creates a node (the demo board is a UI sandbox);
 * the row just flips to `accepted` with `created_node_id` left null.
 */
import type { IngestCandidate, IngestCandidateStatus } from "./candidates";
import { IngestCandidateError } from "./candidates";

/** WS_CONTEXT in src/lib/demo-store.ts — the seeded reference workspace. */
const SEED_WORKSPACE_ID = "00000000-0000-0000-0000-000000000010";

function seedCandidate(
  n: number,
  input: Pick<IngestCandidate, "source" | "kind" | "title" | "content_md"> &
    Partial<Pick<IngestCandidate, "confidence" | "status" | "reprocess_feedback">>,
): IngestCandidate {
  return {
    id: `00000000-0000-0000-000c-${String(n).padStart(12, "0")}`,
    workspace_id: SEED_WORKSPACE_ID,
    external_id: `demo-${n}`,
    links: [],
    provenance: { demo: true },
    confidence: null,
    status: "pending",
    created_node_id: null,
    reviewed_by: null,
    reviewed_at: null,
    reprocess_feedback: null,
    created_at: new Date(Date.now() - n * 3 * 60 * 60 * 1000).toISOString(),
    ...input,
  };
}

const SEED: IngestCandidate[] = [
  seedCandidate(1, {
    source: "github",
    kind: "bug",
    title: "Flaky retry loop in webhook delivery — drops events under backpressure",
    content_md: "Seen in worker logs; retries exhaust after 3 attempts.",
    confidence: 0.91,
  }),
  seedCandidate(2, {
    source: "github",
    kind: "task",
    title: "Add pagination to /api/agents/context responses over 200 nodes",
    content_md: "Large workspaces time out when the context payload exceeds ~1MB.",
    confidence: 0.84,
  }),
  seedCandidate(3, {
    source: "meetings",
    kind: "decision",
    title: "Weekly sync: keep pgvector HNSW, revisit IVFFlat only past 5M rows",
    content_md: "Agreed in the 2026-07 infra sync.",
    confidence: 0.77,
  }),
  seedCandidate(4, {
    source: "slack",
    kind: "task",
    title: "Document the agent-token rotation flow in /docs",
    content_md: "Asked twice in #support this week.",
    confidence: 0.69,
  }),
  seedCandidate(5, {
    source: "meetings",
    kind: "adr",
    title: "ADR: route all extractor LLM calls through the AI Gateway ledger",
    content_md: "Cost attribution requires a single choke point.",
    confidence: 0.88,
  }),
  seedCandidate(6, {
    source: "slack",
    kind: "bug",
    title: "Sidebar count badge stale after accepting a candidate",
    content_md: "Repro: accept from the board, badge keeps the old count until reload.",
    confidence: 0.72,
  }),
  seedCandidate(7, {
    source: "github",
    kind: "decision",
    title: "Adopt HeroUI Pro Kanban for every board surface",
    content_md: "Board renderer and Review already migrated.",
    confidence: 0.95,
    status: "reprocess",
    reprocess_feedback: "Split into one decision per surface before ingesting.",
  }),
  seedCandidate(8, {
    source: "meetings",
    kind: "task",
    title: "Spike: streaming MCP responses for ask_rag",
    content_md: "Parking lot item from the product review.",
    confidence: 0.41,
    status: "dismissed",
  }),
];

type DemoCandidateStore = Map<string, IngestCandidate>;

const g = globalThis as typeof globalThis & {
  __bcontext_demo_ingest_candidates?: DemoCandidateStore;
};

function store(): DemoCandidateStore {
  return (g.__bcontext_demo_ingest_candidates ??= new Map(
    SEED.map((candidate) => [candidate.id, { ...candidate }]),
  ));
}

export function listDemoCandidates(
  workspaceId: string,
  opts?: { status?: IngestCandidateStatus },
): IngestCandidate[] {
  return [...store().values()]
    .filter(
      (c) =>
        c.workspace_id === workspaceId &&
        (opts?.status === undefined || c.status === opts.status),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Demo mirror of `setCandidateStatus`: same transition rules (accepted is
 * immutable; reprocess carries feedback; any other target clears it).
 */
export function setDemoCandidateStatus(
  id: string,
  workspaceId: string,
  status: IngestCandidateStatus,
  feedback?: string | null,
): IngestCandidate {
  const current = store().get(id);
  if (!current || current.workspace_id !== workspaceId) {
    throw new IngestCandidateError("not_found", `candidate not found: ${id}`);
  }
  if (current.status === "accepted") {
    throw new IngestCandidateError("not_pending", `candidate ${id} is already accepted`);
  }
  const next: IngestCandidate = {
    ...current,
    status,
    reprocess_feedback: status === "reprocess" ? (feedback ?? null) : null,
    reviewed_at: new Date().toISOString(),
  };
  store().set(id, next);
  return next;
}

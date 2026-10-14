/**
 * Meeting decisions/action items -> ingest candidates.
 *
 * `refineTranscript()` already used an LLM to extract structured
 * "## Decisiones" / "## Action items" sections from the transcript (see
 * `refine.ts`'s SYSTEM_PROMPT) — that call is already recorded as AI usage
 * on the `meeting_refine` surface. Re-running an LLM extraction on each
 * bullet would be redundant, so this module parses those already-clean
 * sections deterministically (no LLM call) and proposes one candidate per
 * decision/action item, linked back to the meeting node via `caused_by`.
 *
 * Accepting or dismissing a candidate never touches the meeting node
 * itself — the transcript/refined content is untouched either way.
 */
import { retrieve } from "@/lib/rag";
import { proposeCandidate } from "@/lib/ingest/candidates";
import { log } from "@bcontext-dev/contract/log";

/**
 * A hit at or above this similarity is treated as "this decision/task
 * already exists" — skip proposing a duplicate candidate for it.
 */
const DEDUPE_SIMILARITY_THRESHOLD = 0.85;

const MAX_TITLE_CHARS = 120;

export interface ProposeMeetingCandidatesInput {
  workspaceId: string;
  workspaceSlug: string;
  meetingNodeId: string;
  refinedMd: string;
  participants: string[];
}

export interface ProposeMeetingCandidatesResult {
  proposed: number;
  skippedDuplicate: number;
}

export async function proposeMeetingCandidates(
  input: ProposeMeetingCandidatesInput,
): Promise<ProposeMeetingCandidatesResult> {
  const decisions = extractBullets(input.refinedMd, "Decisiones");
  const actionItems = extractChecklistItems(input.refinedMd, "Action items");

  let proposed = 0;
  let skippedDuplicate = 0;

  for (const [i, text] of decisions.entries()) {
    if (await isSemanticDuplicate(input.workspaceSlug, text)) {
      skippedDuplicate++;
      continue;
    }
    await proposeCandidate({
      workspaceId: input.workspaceId,
      source: "meeting",
      externalId: `${input.meetingNodeId}:decision:${i}`,
      kind: "decision",
      title: truncateTitle(text),
      contentMd: `## Decisión\n\n${text}`,
      links: [{ to_node_id: input.meetingNodeId, relation: "caused_by" }],
      confidence: 0.9,
      provenance: {
        meeting_node_id: input.meetingNodeId,
        participants: input.participants,
        section: "decisiones",
        index: i,
      },
    });
    proposed++;
  }

  for (const [i, item] of actionItems.entries()) {
    if (await isSemanticDuplicate(input.workspaceSlug, item.text)) {
      skippedDuplicate++;
      continue;
    }
    await proposeCandidate({
      workspaceId: input.workspaceId,
      source: "meeting",
      externalId: `${input.meetingNodeId}:action:${i}`,
      kind: "task",
      title: truncateTitle(item.text),
      contentMd: buildTaskMd(item),
      links: [{ to_node_id: input.meetingNodeId, relation: "caused_by" }],
      confidence: 0.9,
      provenance: {
        meeting_node_id: input.meetingNodeId,
        participants: input.participants,
        section: "action_items",
        index: i,
        owner: item.owner,
      },
    });
    proposed++;
  }

  return { proposed, skippedDuplicate };
}

/** Best-effort: a retrieval failure must never block proposing a candidate. */
async function isSemanticDuplicate(workspaceSlug: string, text: string): Promise<boolean> {
  try {
    const hits = await retrieve(workspaceSlug, text, 1);
    return hits.length > 0 && hits[0]!.similarity >= DEDUPE_SIMILARITY_THRESHOLD;
  } catch (err) {
    log.warn("meeting.candidates.dedupe_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function extractH2Section(md: string, heading: string): string[] {
  const lines = md.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (startIdx === -1) return [];
  const body: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line.trim())) break;
    body.push(line);
  }
  return body;
}

function extractBullets(md: string, heading: string): string[] {
  return extractH2Section(md, heading)
    .filter((l) => /^-\s/.test(l.trim()) && !/^-\s\[[ xX]\]/.test(l.trim()))
    .map((l) => l.trim().replace(/^-\s/, "").trim())
    .filter(Boolean);
}

interface ActionItem {
  text: string;
  owner: string | null;
}

function extractChecklistItems(md: string, heading: string): ActionItem[] {
  return extractH2Section(md, heading)
    .filter((l) => /^-\s\[[ xX]\]/.test(l.trim()))
    .map((l) => {
      const stripped = l.trim().replace(/^-\s\[[ xX]\]\s*/, "");
      const ownerMatch = stripped.match(/@([\w.-]+)/);
      return { text: stripped, owner: ownerMatch ? ownerMatch[1]! : null };
    })
    .filter((item) => item.text.length > 0);
}

function truncateTitle(text: string, max = MAX_TITLE_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function buildTaskMd(item: ActionItem): string {
  const ownerLine = item.owner ? `\n\nOwner: @${item.owner}` : "";
  return `## Objetivo\n\n${item.text}${ownerLine}`;
}

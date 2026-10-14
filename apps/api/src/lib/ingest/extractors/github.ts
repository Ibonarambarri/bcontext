/**
 * GitHub signal -> ingest candidate extractor.
 *
 * A cheap pre-filter runs before any LLM call: trivial merged PRs (small
 * diffs, bot authors, lockfile/dependency bumps) and thin issues never
 * reach `extractCandidate`. Everything that passes is classified and
 * proposed via the generic ingest pipeline (`proposeCandidate`) — nothing
 * here touches the graph directly.
 *
 * Semantic link proposal (best-effort): the PR/issue title is used as a
 * retrieval query over the workspace's existing nodes; the top hits are
 * proposed as `references` links. A retrieval failure never blocks
 * proposing the candidate itself.
 */
import { extractCandidate } from "@/lib/ingest/extract";
import { proposeCandidate, type IngestCandidateLink } from "@/lib/ingest/candidates";
import { retrieveScoped } from "@/lib/rag";
import { getStorageById } from "@/lib/storage";
import { log } from "@bcontext-dev/contract/log";

export const PR_MIN_CHANGED_LINES = 20;
const PR_BOT_LOGIN_PATTERN = /\[bot\]$/i;
const PR_TRIVIAL_TITLE_PATTERN =
  /^(chore\(deps\)|chore: bump|bump |release |version bump|update lockfile)/i;
export const ISSUE_MIN_BODY_LENGTH = 40;
const LINK_PROPOSAL_LIMIT = 2;

export interface GithubRepoLite {
  full_name: string;
}

export interface GithubPrPayload {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged?: boolean;
  additions?: number;
  deletions?: number;
  user?: { login: string } | null;
  labels?: Array<{ name: string }>;
}

export interface GithubIssuePayload {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user?: { login: string } | null;
  labels?: Array<{ name: string }>;
}

/**
 * Skip trivial merged PRs: bot-authored, dependency/lockfile bumps, or too
 * small a diff to be worth an LLM call. Real feature/fix PRs pass through.
 */
export function isCandidateWorthyMergedPr(pr: GithubPrPayload): boolean {
  if (!pr.merged) return false;
  if (pr.user?.login && PR_BOT_LOGIN_PATTERN.test(pr.user.login)) return false;
  if (PR_TRIVIAL_TITLE_PATTERN.test(pr.title)) return false;
  const changedLines = (pr.additions ?? 0) + (pr.deletions ?? 0);
  return changedLines >= PR_MIN_CHANGED_LINES;
}

/**
 * Skip issues too thin to classify meaningfully (near-empty body) or
 * opened by a bot. Everything else is candidate-worthy.
 */
export function isCandidateWorthyIssue(issue: GithubIssuePayload): boolean {
  if (issue.user?.login && PR_BOT_LOGIN_PATTERN.test(issue.user.login)) return false;
  return (issue.body ?? "").trim().length >= ISSUE_MIN_BODY_LENGTH;
}

async function proposeSemanticLinks(
  workspaceId: string,
  query: string,
): Promise<IngestCandidateLink[]> {
  try {
    const storage = await getStorageById(workspaceId);
    if (!storage) return [];
    const { hits } = await retrieveScoped(storage.workspace.slug, query, {
      storage,
      k: LINK_PROPOSAL_LIMIT,
    });
    return hits
      .slice(0, LINK_PROPOSAL_LIMIT)
      .map((hit) => ({ to_node_id: hit.node_id, relation: "references" }));
  } catch (err) {
    log.warn("ingest.github.link_lookup_failed", {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Merged PR → candidate with semantic links; extraction failures are logged, never thrown. */
export async function proposeGithubMergedPrCandidate(input: {
  workspaceId: string;
  repo: GithubRepoLite;
  pr: GithubPrPayload;
}): Promise<void> {
  const { workspaceId, repo, pr } = input;
  const rawText = `# ${pr.title}\n\n${pr.body ?? ""}`;

  let extracted;
  try {
    extracted = await extractCandidate({
      workspaceId,
      rawText,
      sourceHint: `github:pr:${repo.full_name}#${pr.number}`,
    });
  } catch (err) {
    log.warn("ingest.github.extract_failed", {
      workspace_id: workspaceId,
      repo: repo.full_name,
      number: pr.number,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const links = await proposeSemanticLinks(workspaceId, pr.title);

  await proposeCandidate({
    workspaceId,
    source: "github",
    externalId: `pr:${repo.full_name}:${pr.number}`,
    kind: extracted.kind,
    title: extracted.title,
    contentMd: extracted.contentMd,
    confidence: extracted.confidence,
    links,
    triage: true,
    provenance: {
      repo: repo.full_name,
      number: pr.number,
      url: pr.html_url,
      author: pr.user?.login ?? null,
    },
  });
}

/** Issue → candidate, same contract as the PR path. */
export async function proposeGithubIssueCandidate(input: {
  workspaceId: string;
  repo: GithubRepoLite;
  issue: GithubIssuePayload;
}): Promise<void> {
  const { workspaceId, repo, issue } = input;
  const rawText = `# ${issue.title}\n\n${issue.body ?? ""}`;

  let extracted;
  try {
    extracted = await extractCandidate({
      workspaceId,
      rawText,
      sourceHint: `github:issue:${repo.full_name}#${issue.number}`,
    });
  } catch (err) {
    log.warn("ingest.github.extract_failed", {
      workspace_id: workspaceId,
      repo: repo.full_name,
      number: issue.number,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const links = await proposeSemanticLinks(workspaceId, issue.title);

  await proposeCandidate({
    workspaceId,
    source: "github",
    externalId: `issue:${repo.full_name}:${issue.number}`,
    kind: extracted.kind,
    title: extracted.title,
    contentMd: extracted.contentMd,
    confidence: extracted.confidence,
    links,
    triage: true,
    provenance: {
      repo: repo.full_name,
      number: issue.number,
      url: issue.html_url,
      author: issue.user?.login ?? null,
    },
  });
}

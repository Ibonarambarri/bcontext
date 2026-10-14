/**
 * `@mention` autocomplete over a workspace's nodes and their H2 blocks:
 * builds the candidate list from nodes and ranks it for a typed query.
 * Pure and dependency-free so the web can run it client-side on the nodes it
 * already holds and the API can answer the same query for agents. Block
 * candidates reuse the chunker's heading extraction, so a mention target is
 * always a block id the rest of the system knows.
 */
import {
  BLOCK_INTRO,
  BLOCK_UNBLOCKED,
  extractBlockHeadings,
} from "./rag/chunk.js";

export type MentionCandidate = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  snippet: string;
};

/**
 * A block-level mention candidate — surfaced when the user types
 * `@node-title#` to drill into a specific H2 inside a node. `label` is
 * a presentation-ready string ("Node title › Block heading") that the
 * autocomplete UI can render directly.
 */
export type BlockMentionCandidate = {
  node_id: string;
  block_id: string;
  label: string;
  /** Original node title (for grouping / secondary display). */
  title: string;
  /** Node slug — handy when emitting `/s/<slug>#<block-id>` references. */
  slug: string;
  kind: string;
};

type NodeLike = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  content_md?: string | null;
};

const SNIPPET_MAX = 80;

export function cleanSnippet(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_>~]/g, " ")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_MAX);
}

export function buildMentionCandidates(
  nodes: NodeLike[],
  excludeId?: string,
): MentionCandidate[] {
  return nodes
    .filter((n) => n.id !== excludeId)
    .map((n) => ({
      id: n.id,
      title: n.title,
      slug: n.slug,
      kind: n.kind,
      snippet: cleanSnippet(n.content_md ?? ""),
    }));
}

function score(query: string, c: MentionCandidate): number {
  const q = query.toLowerCase();
  const title = c.title.toLowerCase();
  const slug = c.slug.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  const tokens = title.split(/[\s\-_]+/).filter(Boolean);
  if (tokens.some((t) => t.startsWith(q))) return 60;
  if (title.includes(q)) return 45;
  if (slug.startsWith(q)) return 40;
  if (slug.includes(q)) return 25;
  return 0;
}

export function searchMentions(
  query: string,
  candidates: MentionCandidate[],
  limit = 8,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);
  const scored: Array<{ c: MentionCandidate; s: number }> = [];
  for (const c of candidates) {
    const s = score(q, c);
    if (s > 0) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.title.length - b.c.title.length);
  return scored.slice(0, limit).map(({ c }) => c);
}

/**
 * Build a flat list of block-level autocomplete candidates spanning every
 * node in `nodes`. Each entry is one `{node_id, block_id, label, …}`
 * triple — `label` is "Node title › Block heading", suitable for direct
 * render in the menu. `_intro` / `_unblocked` sentinel blocks are skipped
 * (they're not useful targets for an explicit reference). `excludeId`
 * removes the current node so a user can't link a node to itself.
 *
 * Block_id derivation is shared with `chunkMarkdown` via
 * `extractBlockHeadings` so the autocomplete shows exactly what an inserted
 * `/n/<id>#<block-id>` reference will resolve to.
 */
export function buildBlockMentionCandidates(
  nodes: NodeLike[],
  excludeId?: string,
): BlockMentionCandidate[] {
  const out: BlockMentionCandidate[] = [];
  for (const n of nodes) {
    if (excludeId && n.id === excludeId) continue;
    const md = n.content_md ?? "";
    if (!md.trim()) continue;
    for (const { id, label } of extractBlockHeadings(md)) {
      if (id === BLOCK_INTRO || id === BLOCK_UNBLOCKED) continue;
      out.push({
        node_id: n.id,
        block_id: id,
        label: `${n.title} › ${label}`,
        title: n.title,
        slug: n.slug,
        kind: n.kind,
      });
    }
  }
  return out;
}

function scoreBlock(query: string, c: BlockMentionCandidate): number {
  const q = query.toLowerCase();
  const label = c.label.toLowerCase();
  const block = c.block_id.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  const tokens = label.split(/[\s\-_›]+/).filter(Boolean);
  if (tokens.some((t) => t.startsWith(q))) return 60;
  if (label.includes(q)) return 45;
  if (block.startsWith(q)) return 40;
  if (block.includes(q)) return 25;
  return 0;
}

/**
 * Filter and rank block-level candidates against a `#`-suffix query.
 * Used by the editor's autocomplete when the user types `@node#frag` —
 * the part after `#` is matched against block labels and slugified ids.
 * Empty query returns every candidate (capped by `limit`).
 */
export function searchBlockMentions(
  query: string,
  candidates: BlockMentionCandidate[],
  limit = 8,
): BlockMentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);
  const scored: Array<{ c: BlockMentionCandidate; s: number }> = [];
  for (const c of candidates) {
    const s = scoreBlock(q, c);
    if (s > 0) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.label.length - b.c.label.length);
  return scored.slice(0, limit).map(({ c }) => c);
}

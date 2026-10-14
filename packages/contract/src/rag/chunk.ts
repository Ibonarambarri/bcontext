/**
 * Structure-aware Markdown chunking. Target ~512 tokens per chunk with
 * a small overlap between adjacent chunks so neighbouring concepts stay
 * retrievable. Splits in order:
 *
 *   1. ATX heading boundaries (each section is its own seed chunk)
 *   2. Within an over-budget section: blank-line paragraph boundaries
 *   3. Within an over-budget paragraph: sentence boundaries (.!?)
 *
 * Token counting uses a cheap heuristic (`tokens ≈ chars / 4`) — good
 * enough for chunk sizing without pulling in tiktoken. Substitute a real
 * tokenizer later if precision matters.
 *
 * Each chunk also carries a `block_id` — a stable, in-node identifier
 * derived from the owning H2 (or H1 fallback, or `_intro` / `_unblocked`
 * sentinel). Same block_id means "same H2 section" and is what users and
 * agents reference as `/n/<node_id>#<block_id>`. Block ids are stable
 * within a node but not globally; identity is derived from heading text,
 * not stored as first-class rows.
 */

import { slugify } from "../utils.js";

const TARGET_TOKENS = 512;
const OVERLAP_TOKENS = 50;

const APPROX_CHARS_PER_TOKEN = 4;

/** Sentinel block_id for content above any heading in a node that has headings. */
export const BLOCK_INTRO = "_intro";
/** Sentinel block_id for nodes that have no headings at all. */
export const BLOCK_UNBLOCKED = "_unblocked";

export interface Chunk {
  index: number;
  content: string;
  /** Approximate token count of `content`. */
  tokens: number;
  /** Heading path (e.g. `["Spec", "Auth"]`) the chunk lives under. */
  heading_path: string[];
  /**
   * Stable in-node block identifier derived from the chunk's owning H2
   * (or H1 fallback, or `_intro` / `_unblocked` sentinel). See module
   * docstring for derivation rules.
   */
  block_id: string;
}

export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/**
 * Like `extractBlockIds`, but each entry also carries the human-readable
 * heading text (`label`). Powers the `@node#` block-level mention
 * autocomplete: the menu shows the heading, the inserted reference uses
 * the slugified id.
 *
 * The `label` for the `_intro` / `_unblocked` sentinels is the sentinel
 * itself (consumers can substitute "(intro)" if they want). Ordered by
 * document appearance, deduped on `id`.
 */
export function extractBlockHeadings(
  markdown: string,
): Array<{ id: string; label: string }> {
  if (!markdown.trim()) return [];
  const sections = splitByHeadings(markdown);
  const hasAnyHeading = sections.some((s) => s.path.length > 0);
  const blockKeyToId = new Map<string, string>();
  const seenSlugs = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  const emitted = new Set<string>();
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const seed = blockSeedForSection(section, hasAnyHeading);
    let id: string;
    let label: string;
    if (seed === BLOCK_INTRO || seed === BLOCK_UNBLOCKED) {
      id = seed;
      label = seed;
    } else {
      const blockKey = blockKeyForSection(section);
      const existing = blockKeyToId.get(blockKey);
      if (existing) {
        id = existing;
        label = seed;
      } else {
        const slug = slugify(seed);
        if (!slug) {
          id = `${BLOCK_INTRO}-${s}`;
        } else if (seenSlugs.has(slug)) {
          id = `${slug}-${s}`;
        } else {
          id = slug;
        }
        seenSlugs.add(id);
        blockKeyToId.set(blockKey, id);
        label = seed;
      }
    }
    if (!emitted.has(id)) {
      emitted.add(id);
      out.push({ id, label });
    }
  }
  return out;
}

/**
 * Extract the ordered, deduplicated list of `block_id`s present in a
 * markdown document — the same identifiers `chunkMarkdown` would assign
 * to its chunks, but without paying for the chunk splitting itself.
 *
 * Used by storage's `updateNode` to detect renamed H2s: any id that was
 * present in the previous content but absent in the next is recorded in
 * `data.previous_block_ids[]` so inbound `/n/<id>#<block-id>` references
 * still resolve after the rename.
 *
 * Reuses the exact derivation rules from `chunkMarkdown` (H2 → H1
 * fallback → `_intro` / `_unblocked` sentinels, H3 rolls up to its
 * owning H2). Order follows the document order of the first section
 * that introduces each id.
 */
export function extractBlockIds(markdown: string): string[] {
  if (!markdown.trim()) return [];
  const sections = splitByHeadings(markdown);
  const hasAnyHeading = sections.some((s) => s.path.length > 0);
  const blockKeyToId = new Map<string, string>();
  const seenSlugs = new Set<string>();
  const out: string[] = [];
  const emitted = new Set<string>();
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const seed = blockSeedForSection(section, hasAnyHeading);
    let id: string;
    if (seed === BLOCK_INTRO || seed === BLOCK_UNBLOCKED) {
      id = seed;
    } else {
      const blockKey = blockKeyForSection(section);
      const existing = blockKeyToId.get(blockKey);
      if (existing) {
        id = existing;
      } else {
        const slug = slugify(seed);
        if (!slug) {
          id = `${BLOCK_INTRO}-${s}`;
        } else if (seenSlugs.has(slug)) {
          id = `${slug}-${s}`;
        } else {
          id = slug;
        }
        seenSlugs.add(id);
        blockKeyToId.set(blockKey, id);
      }
    }
    if (!emitted.has(id)) {
      emitted.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Per-block payload returned by `extractBlocks` — the body slice plus the
 * exact `[start, end]` char offsets of that slice inside the original
 * markdown so callers can splice replacements back without `.indexOf`
 * fragility (duplicate H2 text would otherwise pick the wrong match).
 *
 * `body_md` is the verbatim slice `markdown.slice(start, end)` — heading
 * line included, no trimming. Replacements should likewise be applied via
 * a pure slice (`md.slice(0,start) + new + md.slice(end)`).
 *
 * `heading` is the human-readable seed text (e.g. "Vision 2026"), or the
 * `_intro` / `_unblocked` sentinel for headingless content.
 */
export interface BlockSlice {
  block_id: string;
  heading: string;
  body_md: string;
  start: number;
  end: number;
}

/**
 * Split a markdown document into block-level slices keyed by the same
 * `block_id` derivation rules `chunkMarkdown` / `extractBlockIds` use,
 * but returning the actual body text *and* its exact char offsets in the
 * original document. Powers the agentic `read_block` / `replace_in_block`
 * tools — both need surgical access to one H2 section without scanning
 * the rest of the file.
 *
 * Offset invariant: for every entry, `markdown.slice(start, end) ===
 * body_md`. Adjacent blocks are end-to-end contiguous (`b[i].end ===
 * b[i+1].start`) so a writeback splice never leaves a gap or duplicate.
 *
 * H3+ sections roll up into their owning H2 (same as `extractBlockIds`):
 * the H2 block's body spans from the H2 line through the last H3/H4/...
 * line beneath it, up to (but not including) the next H2.
 *
 * note: a fenced code block containing `## something` inside would still
 * be treated as a heading by the underlying line walker (parity with
 * `splitByHeadings`). v1 accepts this known limitation rather than
 * paying for a real markdown parser.
 */
export function extractBlocks(markdown: string): BlockSlice[] {
  if (!markdown || !markdown.trim()) return [];
  const sections = walkSectionsWithOffsets(markdown);
  if (sections.length === 0) return [];
  const hasAnyHeading = sections.some((s) => s.path.length > 0);

  // Resolve a block_id per section using the same rules as
  // `extractBlockIds`. Then merge adjacent sections that share an id
  // (H3+ rolling up into one H2) into a single block whose span runs
  // from the first section's start to the last section's end.
  const blockKeyToId = new Map<string, string>();
  const seenSlugs = new Set<string>();
  const sectionIds: string[] = [];
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const seed = blockSeedForSection(
      { body: "", path: section.path, levels: section.levels },
      hasAnyHeading,
    );
    let id: string;
    if (seed === BLOCK_INTRO || seed === BLOCK_UNBLOCKED) {
      id = seed;
    } else {
      const blockKey = blockKeyForSection({
        body: "",
        path: section.path,
        levels: section.levels,
      });
      const existing = blockKeyToId.get(blockKey);
      if (existing) {
        id = existing;
      } else {
        const slug = slugify(seed);
        if (!slug) {
          id = `${BLOCK_INTRO}-${s}`;
        } else if (seenSlugs.has(slug)) {
          id = `${slug}-${s}`;
        } else {
          id = slug;
        }
        seenSlugs.add(id);
        blockKeyToId.set(blockKey, id);
      }
    }
    sectionIds.push(id);
  }

  // Merge consecutive same-id sections into a single block slice. The
  // end of one block is the start of the next (no gap), keeping the
  // splice-friendly invariant `b[i].end === b[i+1].start`.
  const blocks: BlockSlice[] = [];
  let i = 0;
  while (i < sections.length) {
    const id = sectionIds[i]!;
    const start = sections[i]!.start;
    let j = i + 1;
    while (j < sections.length && sectionIds[j] === id) j++;
    // Extend the slice all the way to the start of the next section (or
    // EOF) so the writeback splice covers any trailing blank line that
    // separates this block from the next heading.
    const end = j < sections.length ? sections[j]!.start : markdown.length;
    const body_md = markdown.slice(start, end);
    const seed = blockSeedForSection(
      { body: "", path: sections[i]!.path, levels: sections[i]!.levels },
      hasAnyHeading,
    );
    blocks.push({ block_id: id, heading: seed, body_md, start, end });
    i = j;
  }
  return blocks;
}

/**
 * Cap on `data.previous_block_ids[]` history per node. Storage drops the
 * oldest entries when over — single-hop renaming is the only thing v1
 * promises, so a long tail buys nothing and pollutes the JSONB column.
 */
const PREVIOUS_BLOCK_IDS_MAX = 50;

/**
 * Diff `nextMd` against `prevMd` and return the union of:
 *   - the existing `previous_block_ids` already on the node
 *   - any block_ids that were present in `prevMd` but disappeared in
 *     `nextMd` (i.e. the user renamed an H2)
 *
 * Deduplicated, capped at `PREVIOUS_BLOCK_IDS_MAX` (oldest entries drop
 * first). Returns null when there's nothing to update — caller can skip
 * the JSONB write entirely in that case.
 *
 * Used by storage's `updateNode` (both demo-store and Supabase backends)
 * so inbound `/n/<id>#<block-id>` references survive H2 renames via
 * `resolveBlockReference`.
 */
export function nextPreviousBlockIds(
  prevMd: string,
  nextMd: string,
  existing: unknown,
): string[] | null {
  const before = new Set(extractBlockIds(prevMd));
  const after = new Set(extractBlockIds(nextMd));
  const removed: string[] = [];
  for (const id of before) {
    if (!after.has(id)) removed.push(id);
  }
  if (removed.length === 0) return null;
  const list = Array.isArray(existing)
    ? (existing as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  let changed = false;
  for (const id of removed) {
    if (!list.includes(id)) {
      list.push(id);
      changed = true;
    }
  }
  if (!changed) return null;
  while (list.length > PREVIOUS_BLOCK_IDS_MAX) list.shift();
  return list;
}

export function chunkMarkdown(
  markdown: string,
  opts?: { targetTokens?: number; overlapTokens?: number },
): Chunk[] {
  const target = opts?.targetTokens ?? TARGET_TOKENS;
  const overlap = opts?.overlapTokens ?? OVERLAP_TOKENS;

  if (!markdown.trim()) return [];

  const sections = splitByHeadings(markdown);
  // Detect whether the doc has any heading at all — controls the
  // `_intro` vs `_unblocked` sentinel for sections with no heading path.
  const hasAnyHeading = sections.some((s) => s.path.length > 0);

  // Resolve a stable block_id per section first, so every piece produced
  // by paragraph/sentence splitting inherits the same id (acceptance
  // criterion: "all N pieces share the same block_id"). Disambiguation
  // for duplicate slugs / empty slugs uses the section index, not the
  // chunk index, to preserve that invariant.
  //
  // Crucially: H3+ sections under the same H2 must all collapse to the
  // SAME block_id (the H2's slug), not get disambiguated suffixes. We
  // identify "same block" by the path prefix up through the owning H2
  // (or H1 fallback) — if two sections share that prefix, they share
  // the block. Suffix-disambiguation only fires when two DISTINCT block
  // headings happen to slugify to the same string.
  const sectionBlockIds: string[] = [];
  // Map block-path key (joined path prefix) -> assigned block_id.
  const blockKeyToId = new Map<string, string>();
  // Set of slugs already claimed by some block, used to detect real
  // cross-block collisions.
  const seenSlugs = new Set<string>();
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const seed = blockSeedForSection(section, hasAnyHeading);
    let id: string;
    if (seed === BLOCK_INTRO || seed === BLOCK_UNBLOCKED) {
      id = seed;
    } else {
      // Key identifying the block this section belongs to: the path up
      // to and including the owning H2 (or H1 fallback). H3+ sections
      // beneath the same H2 produce the same key and therefore reuse
      // the same id.
      const blockKey = blockKeyForSection(section);
      const existing = blockKeyToId.get(blockKey);
      if (existing) {
        id = existing;
      } else {
        const slug = slugify(seed);
        if (!slug) {
          id = `${BLOCK_INTRO}-${s}`;
        } else if (seenSlugs.has(slug)) {
          // Two distinct block headings collapsed to the same slug —
          // suffix with section index so each block stays independently
          // addressable.
          id = `${slug}-${s}`;
        } else {
          id = slug;
        }
        seenSlugs.add(id);
        blockKeyToId.set(blockKey, id);
      }
    }
    sectionBlockIds.push(id);
  }

  interface Piece {
    text: string;
    heading_path: string[];
    block_id: string;
  }
  const pieces: Piece[] = [];
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const block_id = sectionBlockIds[s]!;
    if (tokenEstimate(section.body) <= target) {
      pieces.push({ text: section.body, heading_path: section.path, block_id });
      continue;
    }
    for (const piece of splitByParagraphs(section.body, target)) {
      pieces.push({ text: piece, heading_path: section.path, block_id });
    }
  }

  const out: Chunk[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    let content = piece.text;
    if (i > 0 && overlap > 0) {
      const tail = tailTokens(pieces[i - 1]!.text, overlap);
      if (tail) content = `${tail}\n\n${content}`;
    }
    out.push({
      index: out.length,
      content: content.trim(),
      tokens: tokenEstimate(content),
      heading_path: piece.heading_path,
      block_id: piece.block_id,
    });
  }
  return out;
}

interface Section {
  body: string;
  path: string[];
  /** Parallel to `path`: ATX heading level (1-6) of each path entry. */
  levels: number[];
}

/**
 * Derive the unslugified "seed" text used to compute a section's block_id.
 * Returns one of:
 *   - the H2 heading text, if any H2 is in the path
 *   - the H1 heading text, if there's an H1 but no H2
 *   - `BLOCK_INTRO` for headingless content inside a doc that has headings
 *   - `BLOCK_UNBLOCKED` for a doc with no headings whatsoever
 */
function blockSeedForSection(
  section: Section,
  hasAnyHeading: boolean,
): string {
  // Prefer the first H2 in the path (the highest-frequency structural
  // marker). Fall back to the first H1. Headings deeper than H2 (H3+) do
  // not mint their own block ids in v1 — they roll up to the owning H2.
  const h2Index = section.levels.indexOf(2);
  if (h2Index !== -1) return section.path[h2Index]!;
  const h1Index = section.levels.indexOf(1);
  if (h1Index !== -1) return section.path[h1Index]!;
  return hasAnyHeading ? BLOCK_INTRO : BLOCK_UNBLOCKED;
}

/**
 * Identify the "block" a section belongs to via the path prefix up to
 * and including the owning H2 (or H1 fallback). Two sections that share
 * this key belong to the same block and must share the same block_id —
 * e.g. multiple H3 sections under one H2.
 *
 * Only called for sections whose seed is a real heading (not _intro /
 * _unblocked sentinels), so a level <=2 entry is guaranteed to exist.
 */
function blockKeyForSection(section: Section): string {
  const h2Index = section.levels.indexOf(2);
  const cut = h2Index !== -1 ? h2Index : section.levels.indexOf(1);
  return section.path.slice(0, cut + 1).join(" ");
}

/**
 * Like `splitByHeadings` but instead of trimmed bodies returns the
 * `[start, end]` char offsets of each section in the original markdown.
 * The end of one section is the start of the next (no overlap, no gap),
 * which guarantees `extractBlocks` can emit splice-friendly contiguous
 * block slices.
 *
 * Empty sections are NOT filtered — we still need them as offset anchors
 * so a heading-only block (`## Foo` with no body) gets a slice covering
 * exactly the heading line. The body-empty filter `splitByHeadings`
 * applies is a chunk-side concern; offsets must remain authoritative.
 *
 * Same heading regex as `splitByHeadings` (line-leading `#{1,6} `), so
 * the "fenced code with `##` inside" caveat lives here too — see
 * `extractBlocks` note.
 */
interface SectionWithOffsets {
  start: number;
  end: number;
  path: string[];
  levels: number[];
}

function walkSectionsWithOffsets(markdown: string): SectionWithOffsets[] {
  const lines = markdown.split("\n");
  const out: SectionWithOffsets[] = [];
  const stack: { level: number; title: string }[] = [];
  let sectionStart = 0;
  let cursor = 0;
  let currentPath: string[] = [];
  let currentLevels: number[] = [];
  // True iff the current "section" has at least one real (heading or
  // body) line. Avoids emitting an empty preamble when the doc starts
  // with a heading on line 0.
  let sectionHasContent = false;

  const push = (endOffset: number, path: string[], levels: number[]) => {
    out.push({ start: sectionStart, end: endOffset, path, levels });
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineStart = cursor;
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      if (sectionHasContent) {
        push(lineStart, currentPath.slice(), currentLevels.slice());
      }
      const level = m[1]!.length;
      const title = m[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      currentPath = stack.map((s) => s.title);
      currentLevels = stack.map((s) => s.level);
      sectionStart = lineStart;
      sectionHasContent = true;
    } else if (line.length > 0) {
      sectionHasContent = true;
    }
    cursor += line.length;
    if (li < lines.length - 1) cursor += 1;
  }
  if (sectionHasContent) {
    push(markdown.length, currentPath.slice(), currentLevels.slice());
  }
  return out;
}

function splitByHeadings(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const path = stack.map((s) => s.title);
    const levels = stack.map((s) => s.level);
    sections.push({ body: buf.join("\n").trim(), path, levels });
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      const title = m[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections.filter((s) => s.body.length > 0);
}

function splitByParagraphs(body: string, targetTokens: number): string[] {
  const paragraphs = body.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";
  let bufTokens = 0;
  for (const para of paragraphs) {
    const tokens = tokenEstimate(para);
    if (bufTokens + tokens > targetTokens && buf) {
      out.push(buf);
      buf = para;
      bufTokens = tokens;
      continue;
    }
    buf = buf ? `${buf}\n\n${para}` : para;
    bufTokens += tokens;
  }
  if (buf) out.push(buf);

  // Second pass: any single paragraph that is still over budget gets split
  // on sentence boundaries.
  const finalOut: string[] = [];
  for (const piece of out) {
    if (tokenEstimate(piece) <= targetTokens) {
      finalOut.push(piece);
    } else {
      finalOut.push(...splitBySentence(piece, targetTokens));
    }
  }
  return finalOut;
}

function splitBySentence(text: string, targetTokens: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  let bufTokens = 0;
  for (const s of sentences) {
    const tokens = tokenEstimate(s);
    if (bufTokens + tokens > targetTokens && buf) {
      out.push(buf);
      buf = s;
      bufTokens = tokens;
      continue;
    }
    buf = buf ? `${buf} ${s}` : s;
    bufTokens += tokens;
  }
  if (buf) out.push(buf);
  return out;
}

function tailTokens(text: string, tokens: number): string {
  const charBudget = tokens * APPROX_CHARS_PER_TOKEN;
  if (text.length <= charBudget) return "";
  return text.slice(text.length - charBudget).trim();
}

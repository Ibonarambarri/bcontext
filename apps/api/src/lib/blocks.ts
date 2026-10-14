/**
 * Block-level edits of a node body.
 *
 * A node's H2 sections are already addressable blocks (`/n/<id>#<block_id>`,
 * derived by `extractBlocks`). Until now an agent that wanted to add a
 * `## Result` or rewrite `## Notes` had to send the whole body back with
 * `if_updated_at`, and two agents editing different sections of the same node
 * collided every time. These helpers splice ONE block by its exact offsets and
 * leave the rest of the document byte-for-byte alone, which is what lets the
 * MCP retry a lost race by re-applying the same edit onto the fresh body.
 *
 * The chat agent's `read_block` / `replace_in_block` tools are the same
 * mechanism (offset splice, never `indexOf` on the parent document); this is
 * that logic lifted out of the route so the MCP can share it.
 *
 * Pure functions: they take markdown and return markdown. The caller owns the
 * read, the precondition and the write.
 */
import {
  BLOCK_INTRO,
  BLOCK_UNBLOCKED,
  extractBlocks,
  type BlockSlice,
} from "@bcontext-dev/contract/rag/chunk";
import { resolveBlockReference } from "@bcontext-dev/contract/backlinks";

/** A block as an agent reads and writes it: heading and body, no offsets. */
export interface BlockView {
  block_id: string;
  /** null for the sentinel blocks (`_intro`, `_unblocked`) — content with no heading. */
  heading: string | null;
  /** The body under the heading, trimmed; the heading line itself is not part of it. */
  body_md: string;
}

export type BlockEdit =
  | { ok: true; content_md: string; block: BlockView; before: BlockView | null }
  | { ok: false; error: string; blocks: string[] };

function isSentinel(block: BlockSlice): boolean {
  return block.heading === BLOCK_INTRO || block.heading === BLOCK_UNBLOCKED;
}

function blockView(block: BlockSlice): BlockView {
  if (isSentinel(block)) {
    return { block_id: block.block_id, heading: null, body_md: block.body_md.trim() };
  }
  const newline = block.body_md.indexOf("\n");
  const body = newline === -1 ? "" : block.body_md.slice(newline + 1);
  return { block_id: block.block_id, heading: block.heading, body_md: body.trim() };
}

/** The H2 blocks of a body as API cards (id, heading, body without the heading line). */
export function listBlocks(markdown: string): BlockView[] {
  return extractBlocks(markdown).map(blockView);
}

function blockIds(blocks: readonly BlockSlice[]): string[] {
  return blocks.map((block) => block.block_id);
}

function describeIds(blocks: readonly BlockSlice[]): string {
  return blocks.length > 0 ? blocks.map((block) => `#${block.block_id}`).join(", ") : "none";
}

/** Agents send `## Title`, `#title` and `Title` interchangeably; store the text. */
function cleanHeading(raw: string): string {
  return raw.replace(/^#+\s*/, "").trim();
}

/**
 * Render one block. Every block ends with exactly one newline, plus a blank
 * line when another block follows — the same shape `extractBlocks` slices,
 * so a re-extract after the splice lands on the same offsets.
 */
function renderBlock(heading: string | null, bodyMd: string, last: boolean): string {
  const text = bodyMd.replace(/^\n+/, "").replace(/\s+$/, "");
  const lines: string[] = [];
  if (heading !== null) lines.push(`## ${heading}`);
  if (text) {
    if (heading !== null) lines.push("");
    lines.push(text);
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n${last ? "" : "\n"}`;
}

/**
 * Add a new H2 block at the end of the document. Refuses a heading that
 * already names a block: the caller wanted `replace_block`, and silently
 * minting `#notes-3` next to `#notes` is how duplicate sections happen.
 */
export function appendBlock(
  markdown: string,
  input: { heading: string; body_md: string },
): BlockEdit {
  const existing = extractBlocks(markdown);
  const heading = cleanHeading(input.heading);
  if (!heading) {
    return { ok: false, error: "append needs a non-empty heading", blocks: blockIds(existing) };
  }
  const duplicate = existing.find(
    (block) => !isSentinel(block) && block.heading.trim().toLowerCase() === heading.toLowerCase(),
  );
  if (duplicate) {
    return {
      ok: false,
      error: `a block titled "${heading}" already exists (#${duplicate.block_id}); use op=replace_block to rewrite it. Blocks: ${describeIds(existing)}`,
      blocks: blockIds(existing),
    };
  }
  const base = markdown.replace(/\s+$/, "");
  const next = (base ? `${base}\n\n` : "") + renderBlock(heading, input.body_md, true);
  const after = extractBlocks(next);
  const added = after[after.length - 1];
  if (!added) {
    return { ok: false, error: "append produced no block", blocks: blockIds(existing) };
  }
  return { ok: true, content_md: next, block: blockView(added), before: null };
}

/**
 * Rewrite one block's body (and optionally its heading) in place. Everything
 * outside `[start, end)` of that block is untouched.
 */
export function replaceBlock(
  markdown: string,
  data: Record<string, unknown> | null | undefined,
  input: { block_id: string; body_md: string; heading?: string },
): BlockEdit {
  const blockId = input.block_id.replace(/^#/, "").trim();
  const blocks = extractBlocks(markdown);
  const index = blocks.findIndex((block) => block.block_id === blockId);
  if (index === -1) {
    const renamed =
      resolveBlockReference({ content_md: markdown, data: data ?? null }, blockId).found === "previous";
    return {
      ok: false,
      error: renamed
        ? `block #${blockId} was renamed; current blocks: ${describeIds(blocks)}`
        : `block not found: #${blockId}; current blocks: ${describeIds(blocks)}`,
      blocks: blockIds(blocks),
    };
  }
  const target = blocks[index]!;
  const sentinel = isSentinel(target);
  let heading: string | null;
  if (sentinel) {
    if (input.heading !== undefined) {
      return {
        ok: false,
        error: `#${blockId} is the content above the first heading and has no heading to rename; use op=append for a new titled block`,
        blocks: blockIds(blocks),
      };
    }
    heading = null;
  } else {
    heading = input.heading !== undefined ? cleanHeading(input.heading) : target.heading;
    if (!heading) {
      return { ok: false, error: "heading must not be empty", blocks: blockIds(blocks) };
    }
  }
  const last = index === blocks.length - 1;
  const next =
    markdown.slice(0, target.start) +
    renderBlock(heading, input.body_md, last) +
    markdown.slice(target.end);
  const after = extractBlocks(next);
  // The rewritten block starts where the old one did; fall back to position
  // when the edit emptied it (an empty non-last block leaves no slice).
  const block = after.find((candidate) => candidate.start === target.start) ?? after[index] ?? null;
  return {
    ok: true,
    content_md: next,
    block: block
      ? blockView(block)
      : { block_id: blockId, heading, body_md: "" },
    before: blockView(target),
  };
}

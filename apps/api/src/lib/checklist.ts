/**
 * Markdown checklist helpers. Bcontext nodes carry `- [ ]` / `- [x]` items
 * in `content_md`; agents need to flip a single item WITHOUT rewriting the
 * whole body (which loses concurrent edits). These helpers are pure string
 * transforms — the atomicity comes from the caller pairing them with
 * `updateNode(..., { ifUpdatedAt })`.
 *
 * Item addressing: 0-based index in document order, optionally scoped to a
 * block (H2 section) via `block_id` — same slugified-heading ids the RAG
 * chunker uses, so `/n/<id>#<block_id>` references and checklist scoping
 * speak one language.
 */

import { slugify } from "@bcontext-dev/contract/utils";
import { BLOCK_INTRO, BLOCK_UNBLOCKED } from "@bcontext-dev/contract/rag/chunk";

const ITEM_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s+)(.*)$/;

export interface ChecklistItem {
  /** 0-based index within the addressed scope (node or block). */
  index: number;
  checked: boolean;
  /** Item text, without the `- [ ] ` prefix. */
  text: string;
  /** H2-derived block id the item lives under (`_intro`/`_unblocked` sentinels). */
  block_id: string;
  /** 0-based line number in `content_md`. */
  line: number;
}

/**
 * Marks which lines sit inside a fenced code block (``` or ~~~). The fence
 * delimiter lines themselves count as fenced too.
 */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      if (fence === null) {
        fence = m[1]!;
        out.push(true);
        continue;
      }
      if (m[1] === fence) {
        fence = null;
        out.push(true);
        continue;
      }
    }
    out.push(fence !== null);
  }
  return out;
}

/** Block id of the H2 a given line lives under, walking top-down. */
function blockIdsPerLine(lines: string[]): string[] {
  const ids: string[] = [];
  let current: string | null = null;
  let sawHeading = false;
  const seen = new Map<string, number>();
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      sawHeading = true;
      const base = slugify(m[1]!) || "section";
      // Duplicate headings get -2, -3… suffixes, matching the chunker.
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      current = n === 1 ? base : `${base}-${n}`;
    }
    ids.push(current ?? (sawHeading ? BLOCK_INTRO : BLOCK_UNBLOCKED));
  }
  // Lines above the first H2 in a document that HAS H2s are `_intro`.
  if (sawHeading) {
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === BLOCK_UNBLOCKED) ids[i] = BLOCK_INTRO;
      if (/^##\s+/.test(lines[i]!)) break;
    }
  }
  return ids;
}

/**
 * Enumerate checklist items, optionally scoped to one block. Indices are
 * relative to the scope — the same `index` an agent must pass to
 * `toggleChecklistItem` with the same `block_id`.
 */
export function listChecklistItems(
  content_md: string,
  block_id?: string | null,
): ChecklistItem[] {
  const lines = content_md.split("\n");
  const blocks = blockIdsPerLine(lines);
  const fenced = fencedLines(lines);
  const out: ChecklistItem[] = [];
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    // `- [ ]` inside a fenced code block is literal text, not a checkbox —
    // counting it misaligns every later index and a toggle mutates code.
    if (fenced[i]) continue;
    if (block_id && blocks[i] !== block_id) continue;
    const m = ITEM_RE.exec(lines[i]!);
    if (!m) continue;
    out.push({
      index: idx++,
      checked: m[2]!.toLowerCase() === "x",
      text: m[4]!,
      block_id: blocks[i]!,
      line: i,
    });
  }
  return out;
}

export type ToggleResult =
  | { ok: true; content_md: string; item: ChecklistItem }
  | { ok: false; error: string; items: ChecklistItem[] };

/**
 * Flip (or set) one checklist item. `checked` omitted = toggle. Returns the
 * new markdown plus the item's final state, or the scope's item list on a
 * bad index so the agent can self-correct without a second round-trip.
 */
export function toggleChecklistItem(
  content_md: string,
  args: { index: number; block_id?: string | null; checked?: boolean },
): ToggleResult {
  const items = listChecklistItems(content_md, args.block_id);
  const item = items.find((it) => it.index === args.index);
  if (!item) {
    const scope = args.block_id ? `block "${args.block_id}"` : "node";
    return {
      ok: false,
      error: `no checklist item at index ${args.index} in ${scope} (${items.length} item${items.length === 1 ? "" : "s"} found)`,
      items,
    };
  }
  const nextChecked = args.checked ?? !item.checked;
  const lines = content_md.split("\n");
  lines[item.line] = lines[item.line]!.replace(
    ITEM_RE,
    (_s, pre, _mark, ws, text) => `${pre}[${nextChecked ? "x" : " "}]${ws}${text}`,
  );
  return {
    ok: true,
    content_md: lines.join("\n"),
    item: { ...item, checked: nextChecked },
  };
}

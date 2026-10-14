/**
 * Citation anchor helpers — pure, framework-free.
 *
 * Chat citations carry a `{ node_id, chunk_index, snippet }` shape and the UI
 * deep-links each citation to `/w/<ws>/n/<id>?highlight=<chunk_index>`. The
 * node page reads the `highlight` param and scrolls/flashes the matching
 * chunk in the rendered editor.
 *
 * Chunk identity comes from `(node_id, chunk_index)` as produced by
 * `chunkMarkdown`. Re-chunking a node invalidates anchors emitted before
 * the rewrite: the link still opens the node, there is just no chunk to flash.
 */

const HIGHLIGHT_PARAM = "highlight";

export interface CitationAnchorInput {
  node_id: string;
  chunk_index?: number | null;
}

/**
 * Build the value that goes into the `?highlight=` query param. Returns
 * `null` when the chunk index is missing/invalid — callers should then
 * link to the node URL without a fragment.
 */
export function buildCitationAnchor(c: CitationAnchorInput): string | null {
  const idx = c.chunk_index;
  if (typeof idx !== "number" || !Number.isFinite(idx) || idx < 0) return null;
  return String(Math.floor(idx));
}

/**
 * Build the relative URL for a citation. Always includes the workspace
 * slug + node id; appends `?highlight=` only when a valid anchor exists.
 */
export function buildCitationHref(
  /** `<org>/<workspace>` — a bare slug names one workspace per organization. */
  workspace: string,
  nodeId: string,
  chunkIndex?: number | null,
): string {
  const base = `/w/${workspace}/n/${nodeId}`;
  const anchor = buildCitationAnchor({ node_id: nodeId, chunk_index: chunkIndex });
  return anchor === null ? base : `${base}?${HIGHLIGHT_PARAM}=${anchor}`;
}

/**
 * Parse the `highlight` param off a URL search-string or value. Accepts the
 * raw string (e.g. `"3"`), a URLSearchParams-style accessor, or `null`.
 * Returns the chunk index as a non-negative integer, or `null` when missing.
 */
export function parseCitationHighlight(
  value: string | string[] | null | undefined,
): number | null {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Truncate a chunk's content to a short, single-line snippet suitable for
 * a citation list entry. Normalises whitespace and ellipses long bodies.
 */
export function formatSnippet(content: string, maxLen = 140): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 1).trimEnd() + "…";
}

export type CitationSegment =
  | { type: "text"; text: string }
  | { type: "marker"; n: number };

/**
 * Tokenise an assistant message into a stream of plain-text and citation
 * markers. Markers are written as `[N]` where N is a 1-based index into the
 * citation list — the prompt instructs the model to use this form. Unknown
 * indexes are passed through as text so we never silently swallow content.
 *
 * Citations sourced from the response side-channel (header) are the source
 * of truth for *what* `[N]` resolves to; this parser only splits the text.
 */
export function parseCitationMarkers(
  text: string,
  citationCount: number,
): CitationSegment[] {
  if (!text) return [];
  const re = /\[(\d{1,3})\]/g;
  const out: CitationSegment[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    // Only treat as a citation marker when N is a valid 1-based index into
    // the citation list. Otherwise leave the `[N]` literal in the text.
    if (n < 1 || n > citationCount) continue;
    if (m.index > cursor) {
      out.push({ type: "text", text: text.slice(cursor, m.index) });
    }
    out.push({ type: "marker", n });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    out.push({ type: "text", text: text.slice(cursor) });
  }
  return out;
}

/**
 * Link model between nodes, derived from content rather than stored edges:
 * explicit mentions (`data.mentions`), `/n/<id>#<block>` and `/s/<slug>`
 * references in the markdown and their inverse (backlinks). Also the
 * two-level neighbourhood graph the inspector and the node page draw.
 *
 * Pure functions over `NodeLike` arrays so the API computes them per request
 * and the web can recompute optimistically without a round trip. Both sides
 * must agree on what counts as a link — that is why this lives in the
 * contract.
 */
import { cleanSnippet } from "./mention-search.js";
import { extractBlockIds } from "./rag/chunk.js";

type NodeLike = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  content_md: string;
  data?: Record<string, unknown> | null;
};

/**
 * A single explicit-mention record on `node.data.mentions`. The legacy
 * shape was a bare string node id; the v1 block-aware shape is
 * `{ id, block_id? }` so a mention can point at a specific H2 section.
 * Reading code should treat the two as equivalent (`block_id: null`
 * when omitted) — see `readMentionRecords`.
 */
export type MentionRecord = { id: string; block_id: string | null };

/**
 * Read the explicit `data.mentions` array from a node. Tolerates missing
 * data, non-array values, or non-string entries. Returns deduped ids in
 * declared order. Accepts both legacy strings and `{ id, block_id }`
 * objects — block_id is discarded here; use `readMentionRecords` to
 * preserve it.
 */
function readMentionIds(data: NodeLike["data"]): string[] {
  return readMentionRecords(data).map((r) => r.id);
}

/**
 * Variant of `readMentionIds` that preserves the optional `block_id` on
 * each entry. Used wherever the caller needs to know which H2 a mention
 * targets (e.g. graph rendering with block-level edges).
 */
export function readMentionRecords(
  data: NodeLike["data"],
): MentionRecord[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as Record<string, unknown>).mentions;
  if (!Array.isArray(raw)) return [];
  const out: MentionRecord[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    let id: string | null = null;
    let block_id: string | null = null;
    if (typeof v === "string") {
      id = v.trim();
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      if (typeof obj.id === "string") id = obj.id.trim();
      if (typeof obj.block_id === "string") {
        const b = obj.block_id.trim();
        block_id = b ? b : null;
      }
    }
    if (!id) continue;
    // Dedupe key includes block_id so the same node referenced by two
    // distinct blocks survives as two records.
    const key = `${id}#${block_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, block_id });
  }
  return out;
}

export type Backlink = {
  id: string;
  title: string;
  kind: string;
  snippet: string;
  /**
   * The block_id the reference points at, if the source markdown used
   * the `/n/<id>#<block-id>` syntax. `null` for node-level references
   * and legacy explicit mentions without a block.
   */
  block_id: string | null;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRefRegex(target: { id: string; slug: string }): RegExp {
  // Match `/n/<id>` or `/s/<slug>` as a complete path segment, optionally
  // followed by `#<block-id>`. The next char must not extend either the
  // node identifier or the block_id — so `/n/abc#vision-2026extra` does
  // not swallow `extra` into the block_id (the lookahead applies AFTER
  // the optional block group, the boundary check INSIDE the block_id
  // class ensures the alphabet is the same as outside).
  const id = escapeRegex(target.id);
  const slug = escapeRegex(target.slug);
  return new RegExp(
    `(?:/n/${id}|/s/${slug})(?:#([A-Za-z0-9_-]+))?(?![A-Za-z0-9_-])`,
  );
}

function execRef(
  content_md: string,
  target: { id: string; slug: string },
): { index: number; block_id: string | null } | null {
  const m = makeRefRegex(target).exec(content_md);
  if (!m) return null;
  return { index: m.index, block_id: (m[1] ?? null) || null };
}

function hasReference(
  content_md: string,
  target: { id: string; slug: string },
): boolean {
  return makeRefRegex(target).test(content_md);
}

function snippetAround(
  content_md: string,
  target: { id: string; slug: string },
): string {
  const hit = execRef(content_md, target);
  if (!hit) return cleanSnippet(content_md);
  const idx = hit.index;
  const lineStart = Math.max(0, content_md.lastIndexOf("\n", idx) + 1);
  const nextNL = content_md.indexOf("\n", idx);
  const lineEnd = nextNL === -1 ? content_md.length : nextNL;
  const line = content_md.slice(lineStart, lineEnd);
  return cleanSnippet(line);
}

export function findBacklinks(
  nodes: NodeLike[],
  target: { id: string; slug: string },
): Backlink[] {
  const out: Backlink[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.id === target.id) continue;
    const hit = execRef(n.content_md, target);
    const inBody = hit !== null;
    // For explicit mentions, prefer the first record whose id matches the
    // target — preserves its block_id so consumers see "this mention
    // points at block X" even when it came via the structured shape.
    const explicit = readMentionRecords(n.data).find(
      (r) => r.id === target.id,
    );
    if (!inBody && !explicit) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push({
      id: n.id,
      title: n.title,
      kind: n.kind,
      snippet: inBody ? snippetAround(n.content_md, target) : "",
      block_id: inBody ? hit.block_id : (explicit?.block_id ?? null),
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/**
 * A directed edge from `from` to `to`. `from` mentions `to` in its markdown.
 */
export type GraphEdge = { from: string; to: string };

export type GraphNode = {
  id: string;
  title: string;
  kind: string;
  /** 0 = the center, 1 = direct neighbor, 2 = neighbor-of-neighbor. */
  depth: 0 | 1 | 2;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

/**
 * Build a two-level neighborhood around `center`. Level 1 is every node
 * that mentions the center or is mentioned by it; level 2 is every node
 * mentioned (in either direction) by a level-1 neighbor that isn't already
 * the center or another level-1 node. Edges are deduplicated; the orientation
 * preserved is "the mention as written in markdown" — `from` is the node
 * whose `content_md` carries the link.
 *
 * The output is bounded: level-1 caps at 12 nodes, level-2 caps at 24, edges
 * cap at 80. Large workspaces still get a meaningful local picture without
 * forcing the SVG renderer to paint hundreds of glyphs.
 */
export function buildGraphTwoLevels(
  nodes: NodeLike[],
  center: NodeLike,
): GraphData {
  const byId = new Map<string, NodeLike>();
  for (const n of nodes) byId.set(n.id, n);

  function outgoing(n: NodeLike): NodeLike[] {
    return findForwardLinks(nodes, {
      id: n.id,
      content_md: n.content_md,
      data: n.data,
    })
      .map((f) => byId.get(f.id))
      .filter((x): x is NodeLike => Boolean(x));
  }
  function incoming(n: NodeLike): NodeLike[] {
    return findBacklinks(nodes, { id: n.id, slug: n.slug })
      .map((b) => byId.get(b.id))
      .filter((x): x is NodeLike => Boolean(x));
  }

  const edgesSeen = new Set<string>();
  const edges: GraphEdge[] = [];
  function pushEdge(from: string, to: string): void {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (edgesSeen.has(key)) return;
    edgesSeen.add(key);
    edges.push({ from, to });
  }

  // Level 1 — direct neighbors of the center.
  const level1Nodes = new Map<string, NodeLike>();
  for (const out of outgoing(center)) {
    if (out.id === center.id) continue;
    level1Nodes.set(out.id, out);
    pushEdge(center.id, out.id);
    if (level1Nodes.size >= 12) break;
  }
  for (const inc of incoming(center)) {
    if (inc.id === center.id) continue;
    if (!level1Nodes.has(inc.id) && level1Nodes.size >= 12) break;
    level1Nodes.set(inc.id, inc);
    pushEdge(inc.id, center.id);
  }

  // Level 2 — neighbors of every level-1 node, excluding the center and
  // every other level-1 (those keep their inner-circle position).
  const level2Nodes = new Map<string, NodeLike>();
  for (const l1 of level1Nodes.values()) {
    if (edges.length >= 80) break;
    for (const out of outgoing(l1)) {
      pushEdge(l1.id, out.id);
      if (
        out.id !== center.id &&
        !level1Nodes.has(out.id) &&
        !level2Nodes.has(out.id) &&
        level2Nodes.size < 24
      ) {
        level2Nodes.set(out.id, out);
      }
    }
    for (const inc of incoming(l1)) {
      pushEdge(inc.id, l1.id);
      if (
        inc.id !== center.id &&
        !level1Nodes.has(inc.id) &&
        !level2Nodes.has(inc.id) &&
        level2Nodes.size < 24
      ) {
        level2Nodes.set(inc.id, inc);
      }
    }
  }

  const graphNodes: GraphNode[] = [
    {
      id: center.id,
      title: center.title,
      kind: center.kind,
      depth: 0,
    },
    ...Array.from(level1Nodes.values()).map(
      (n): GraphNode => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        depth: 1,
      }),
    ),
    ...Array.from(level2Nodes.values()).map(
      (n): GraphNode => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        depth: 2,
      }),
    ),
  ];

  return { nodes: graphNodes, edges };
}

/**
 * Find all outgoing references from `source` to other nodes. Scans
 * `source.content_md` for `/n/<id>` or `/s/<slug>` segments and matches
 * each against the universe of `nodes`. Returns the targets in document
 * order (first appearance wins), deduplicated.
 *
 * Together with `findBacklinks`, this gives the bidirectional edge set the
 * local-graph view needs to render outgoing mentions as real connections,
 * not just inbound references.
 */
export function findForwardLinks(
  nodes: NodeLike[],
  source: Pick<NodeLike, "id" | "content_md" | "data">,
): Backlink[] {
  const md = source.content_md ?? "";

  // Build id+slug lookup tables once.
  const byId = new Map<string, NodeLike>();
  const bySlug = new Map<string, NodeLike>();
  for (const n of nodes) {
    if (n.id === source.id) continue;
    byId.set(n.id, n);
    if (n.slug) bySlug.set(n.slug, n);
  }

  const seen = new Set<string>();
  const out: Backlink[] = [];

  // Walk every `/n/<id>` or `/s/<slug>` segment, optionally followed by
  // `#<block-id>`. Identifier characters are [A-Za-z0-9_-] — the trailing
  // boundary check matches the regex in `makeRefRegex` so `/n/abc#vis-2extra`
  // doesn't swallow `extra` into the block_id.
  if (md) {
    const re =
      /\/(n|s)\/([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?(?![A-Za-z0-9_-])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      const [, kind, key, blockKey] = m;
      const target = kind === "n" ? byId.get(key!) : bySlug.get(key!);
      if (!target) continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      const idx = m.index;
      const lineStart = Math.max(0, md.lastIndexOf("\n", idx) + 1);
      const nextNL = md.indexOf("\n", idx);
      const lineEnd = nextNL === -1 ? md.length : nextNL;
      const line = md.slice(lineStart, lineEnd);
      out.push({
        id: target.id,
        title: target.title,
        kind: target.kind,
        snippet: cleanSnippet(line),
        block_id: blockKey ?? null,
      });
    }
  }

  // Add explicit mentions stored in `data.mentions`. These don't have a body
  // anchor, so they get an empty snippet. Block-aware mention records
  // (`{ id, block_id }`) propagate their block here.
  for (const rec of readMentionRecords(source.data)) {
    const target = byId.get(rec.id);
    if (!target) continue;
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    out.push({
      id: target.id,
      title: target.title,
      kind: target.kind,
      snippet: "",
      block_id: rec.block_id,
    });
  }

  return out;
}

/**
 * Look up whether a `block_id` referenced via `/n/<id>#<block_id>` exists
 * on `node` — either in the current `content_md` or as a stale entry in
 * `data.previous_block_ids[]` (recorded when an H2 was renamed). v1 only
 * tracks a single hop of history; if the block was renamed twice, the
 * intermediate id is lost and resolves as `missing`.
 *
 * Consumers (e.g. a link decorator in the editor) can use the `previous`
 * return to flag the reference visually as "block was renamed" without
 * outright breaking it.
 */
export function resolveBlockReference(
  node: { content_md: string; data?: Record<string, unknown> | null },
  block_id: string,
): { found: "current" | "previous" | "missing" } {
  if (!block_id) return { found: "missing" };
  const current = extractBlockIds(node.content_md ?? "");
  if (current.includes(block_id)) return { found: "current" };
  const data = node.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const prev = (data as Record<string, unknown>).previous_block_ids;
    if (Array.isArray(prev)) {
      for (const v of prev) {
        if (typeof v === "string" && v === block_id) {
          return { found: "previous" };
        }
      }
    }
  }
  return { found: "missing" };
}

/**
 * The page and the search box, read off the query string the same way by
 * every admin list.
 *
 * One place, because the three lists are read as one screen: an operator who
 * learns that `?limit=` means fifty rows on the organizations list would be
 * right to expect it to mean fifty on the queue, and a second definition is
 * how the two stop agreeing.
 */
import type { AdminListQuery } from "@bcontext-dev/contract/admin-orgs";

const ADMIN_LIST_LIMIT = 50;
/**
 * The ceiling, above which the answer stops being a page. Clamped rather
 * than refused: a bad `limit` is somebody exploring the URL, and the useful
 * reply is the biggest page we serve, not a 400.
 */
const ADMIN_LIST_MAX_LIMIT = 200;

export interface AdminListBounds {
  q: string | undefined;
  limit: number;
  offset: number;
}

export function readListParams(url: URL): AdminListBounds {
  return {
    q: url.searchParams.get("q")?.trim() || undefined,
    limit: clampLimit(url.searchParams.get("limit")),
    offset: clampOffset(url.searchParams.get("offset")),
  };
}

function clampLimit(raw: string | null): number {
  if (!raw) return ADMIN_LIST_LIMIT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return ADMIN_LIST_LIMIT;
  return Math.min(ADMIN_LIST_MAX_LIMIT, n);
}

function clampOffset(raw: string | null): number {
  const n = Math.floor(Number(raw ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The same clamp, for the library functions that are called directly (the
 *  MCP surface, tests) rather than through a URL. */
export function pageBounds(query: AdminListQuery): { limit: number; offset: number } {
  return {
    limit: clampLimit(query.limit === undefined ? null : String(query.limit)),
    offset: clampOffset(query.offset === undefined ? null : String(query.offset)),
  };
}

/**
 * A search term made safe for PostgREST's `or=` filter, which is parsed as
 * comma-separated clauses inside parentheses: a comma or a bracket in the
 * box would not fail, it would silently become a different query. `*` and
 * `%` go too — they are ilike's wildcards, and a search box that quietly
 * accepts globs answers questions nobody asked.
 */
export function searchTerm(q: string | undefined): string | null {
  const cleaned = (q ?? "").replace(/[,()*%\\"']/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

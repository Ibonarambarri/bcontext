/**
 * Agent display names, for attributing a change to "Codex release agent"
 * instead of to a hash.
 *
 * Two callers, one question: the MCP route wants the connection's own name
 * once per request (so every write it records carries the label), and the
 * change feed wants the names of whichever agents appear on a page (so rows
 * written before labels existed, or by an agent since renamed, still read
 * correctly). Both go through a small in-process cache: a name changes
 * rarely, and a feed page should not cost one lookup per row.
 *
 * Never throws. A missing name is the honest fallback the feed already
 * renders (`Agent · 1a2b3c4d`); a lookup failure must not fail a write or a
 * read.
 */
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;

interface Cached {
  name: string | null;
  expiresAt: number;
}

const cache = new Map<string, Cached>();

/** Resolve one agent's name, or null when unknown. */
export async function agentDisplayName(agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  const names = await agentDisplayNames([agentId]);
  return names.get(agentId) ?? null;
}

/**
 * Resolve many at once — one query for every id not already cached. Ids
 * that resolve to nothing are cached as null too, so a deleted agent does
 * not cost a query on every page that still mentions it.
 */
export async function agentDisplayNames(agentIds: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of new Set(agentIds)) {
    if (!id) continue;
    const hit = cache.get(id);
    if (hit && hit.expiresAt > now) {
      if (hit.name) out.set(id, hit.name);
    } else {
      missing.push(id);
    }
  }
  if (missing.length === 0 || !isSupabaseConfigured()) return out;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("agents")
      .select("id,name")
      .in("id", missing);
    if (error) throw error;
    const found = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) {
      if (row.id && typeof row.name === "string" && row.name.length > 0) found.set(row.id, row.name);
    }
    for (const id of missing) {
      const name = found.get(id) ?? null;
      remember(id, name, now);
      if (name) out.set(id, name);
    }
  } catch {
    // Left uncached so the next call retries; the caller falls back to the
    // labelled id, which is what it had before this module existed.
  }
  return out;
}

function remember(id: string, name: string | null, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    // Drop the oldest insertions rather than refuse: the map keeps insertion
    // order, and a bounded miss rate is better than an unbounded map.
    for (const key of cache.keys()) {
      cache.delete(key);
      if (cache.size < MAX_ENTRIES / 2) break;
    }
  }
  cache.set(id, { name, expiresAt: now + TTL_MS });
}

/** Test seam. */
export function resetAgentNameCacheForTests(): void {
  cache.clear();
}

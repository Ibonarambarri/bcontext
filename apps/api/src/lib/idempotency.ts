/**
 * In-process LRU cache for idempotent agent requests.
 *
 * Keys are scoped per-process: this is intentional for the demo and a
 * single-instance deploy. Swap for Redis/Upstash if you need cross-instance
 * dedup.
 */

const MAX_ENTRIES = 200;
const TTL_MS = 10 * 60 * 1000;

type Entry = {
  status: number;
  body: unknown;
  expiresAt: number;
};

const store = new Map<string, Entry>();

function evictExpired() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

/** Cached response for an `Idempotency-Key`, or null; a hit is bumped to most recent. */
export function getIdempotent(key: string): Entry | null {
  evictExpired();
  const hit = store.get(key);
  if (!hit) return null;
  // Refresh recency for LRU semantics.
  store.delete(key);
  store.set(key, hit);
  return hit;
}

/** Remember a response for `TTL_MS`; the oldest entries go once `MAX_ENTRIES` is exceeded. */
export function setIdempotent(key: string, status: number, body: unknown): void {
  evictExpired();
  if (store.has(key)) store.delete(key);
  store.set(key, { status, body, expiresAt: Date.now() + TTL_MS });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}
